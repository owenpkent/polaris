// Shared helpers for MCP tool handlers: error mapping, and resolving project/section
// references the way the tool contract describes (by id, slug, or name).
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { NotFoundError, ValidationError, type Project, type Section, type Store } from '../core/index.ts';
import { parseGithubUrl } from '../ingest/github/mapping.ts';
import { findProjectForRepo } from '../ingest/github/trackRepo.ts';

/** Zod enums mirroring core/types.ts. Kept as local literals (not derived from the
 * exported TASK_STATUSES/PRIORITIES arrays) because zod's enum needs a non-empty
 * tuple type; keep this in sync by hand if core/types.ts adds a value. */
export const TASK_STATUS_VALUES = ['inbox', 'open', 'in_progress', 'waiting', 'done', 'dropped'] as const;
export const PRIORITY_VALUES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
export { SOURCE_TYPES as SOURCE_TYPE_VALUES } from '../core/index.ts';
export const ORDER_BY_VALUES = ['due', 'priority', 'updated', 'created', 'position'] as const;

/** Statuses returned by search_tasks / list_inbox-style defaults when no status filter is given. */
export const DEFAULT_SEARCH_STATUSES = TASK_STATUS_VALUES.filter((s) => s !== 'done' && s !== 'dropped');
export const OPEN_STATUSES = ['open', 'in_progress', 'waiting'] as const;

export function ok(text: string, structured?: Record<string, unknown>): CallToolResult {
  return structured === undefined ? { content: [{ type: 'text', text }] } : { content: [{ type: 'text', text }], structuredContent: structured };
}

export function err(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Runs a tool body, mapping NotFoundError/ValidationError (and anything else thrown) to an isError result. Tools never throw. */
export function guard(fn: () => CallToolResult): CallToolResult {
  try {
    return fn();
  } catch (e) {
    if (e instanceof NotFoundError) return err(`Not found: ${e.message}`);
    if (e instanceof ValidationError) return err(`Invalid: ${e.message}`);
    return err(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function resolveProject(store: Store, ref: string): Project {
  const p = store.findProject(ref);
  if (!p) throw new NotFoundError(`project not found: ${ref}`);
  return p;
}

/**
 * The project tracked for a GitHub repo, given as owner/repo or any github.com URL (https, ssh, or
 * scp style, with or without .git). Archived projects are not matched. Undefined when none is.
 */
export function resolveProjectByGithubRepo(store: Store, repo: string): Project | undefined {
  const trimmed = repo.trim();
  const parsed = parseGithubUrl(trimmed) ?? (/^[\w.-]+\/[\w.-]+$/.test(trimmed) ? { owner: trimmed.split('/')[0], repo: trimmed.split('/')[1].replace(/\.git$/i, '') } : null);
  if (!parsed) return undefined;
  return findProjectForRepo(store, `${parsed.owner}/${parsed.repo}`, { includeArchived: false });
}

function findSection(store: Store, projectId: string, ref: string): Section | undefined {
  const sections = store.listSections(projectId);
  return sections.find((s) => s.id === ref) ?? sections.find((s) => s.name.toLowerCase() === ref.toLowerCase());
}

/** Section lookup for reads: id or name within the project. Errors if not found. */
export function resolveSectionRead(store: Store, projectId: string, ref: string): Section {
  const s = findSection(store, projectId, ref);
  if (!s) throw new NotFoundError(`section not found in project: ${ref}`);
  return s;
}

/** Section lookup for writes: id or name within the project. Creates the section if a name does not match one yet. */
export function resolveSectionWrite(store: Store, projectId: string, ref: string): Section {
  return findSection(store, projectId, ref) ?? store.ensureSection(projectId, ref);
}

export function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

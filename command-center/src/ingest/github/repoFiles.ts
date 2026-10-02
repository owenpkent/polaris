// The one reader of repo checklists: each project's todo file, README.md, CLAUDE.md, and top-level
// docs/*.md, fetched over the GitHub contents API for every project that has a github URL. A local
// clone is never read (removed 2026-09-20), so every machine sees the same tasks. The source_id
// scheme (project slug + relative path + text hash) is the one the old disk reader used, so tasks
// it created carry over. Read-only: GithubClient only ever issues GETs.
//
// GitHub answers 404 both for "no such file" and for "you cannot see this repo". A missing file
// retires its tasks; an unreadable repo must not. So each repo is checked first, and one that
// cannot be read is skipped whole and listed in report.skipped.
import type { Store } from '../../core/index.ts';
import { checklistToSourceItems } from '../../importer/checklist.ts';
import { importChecklistContent } from '../../importer/todo.ts';
import { emptyReport, previewUpsert, tallyUpsert, type SyncReport } from '../common.ts';
import type { SecretStore } from '../secrets.ts';
import { GithubNotSignedInError, resolveGithubAuth } from './auth.ts';
import { GithubClient, GithubFileTooLargeError, GithubRateLimitStop, GithubRequestError } from './client.ts';
import { parseGithubUrl } from './mapping.ts';
import { isReadChecklistsEnabled } from './repoSettings.ts';

export interface RepoFilesSyncOptions {
  dryRun?: boolean;
  token?: string;
  /** Where the GitHub App sign-in is kept. Tests pass an in-memory store so the real one is never read. */
  secrets?: SecretStore;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  rateLimitFloor?: number;
}

const STATIC_FILES = ['README.md', 'CLAUDE.md'];

function isMarkdown(name: string): boolean {
  return name.toLowerCase().endsWith('.md');
}

function errorMessage(e: unknown): string {
  if (e instanceof GithubRateLimitStop) return `rate limited: ${e.message}`;
  if (e instanceof GithubRequestError) return `HTTP ${e.status}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

/**
 * Every non-initiative, non-archived project with a github URL. Order is stable
 * (store.listProjects() orders by name) so a --verbose run is reproducible.
 */
function checklistTargets(store: Store): { project: ReturnType<Store['listProjects']>[number]; owner: string; repo: string }[] {
  const out: { project: ReturnType<Store['listProjects']>[number]; owner: string; repo: string }[] = [];
  for (const project of store.listProjects()) {
    if (project.category === 'initiative' || !project.github) continue;
    const parsed = parseGithubUrl(project.github);
    if (!parsed) continue;
    if (!isReadChecklistsEnabled(store, `${parsed.owner}/${parsed.repo}`)) continue;
    out.push({ project, owner: parsed.owner, repo: parsed.repo });
  }
  return out;
}

export async function syncGithubRepoFiles(store: Store, opts: RepoFilesSyncOptions = {}): Promise<SyncReport> {
  const report = emptyReport('repo_files');
  const log = opts.log ?? (() => {});
  const dryRun = opts.dryRun ?? false;
  const checked = { count: 0, noun: 'repo', foundNoun: 'item' };
  report.checked = checked;

  let client: GithubClient;
  try {
    const token = opts.token ?? (await resolveGithubAuth({ secrets: opts.secrets, fetchImpl: opts.fetchImpl }));
    client = new GithubClient({ token, store, fetchImpl: opts.fetchImpl, log, rateLimitFloor: opts.rateLimitFloor });
  } catch (e) {
    report.partial = true;
    report.errors.push(e instanceof GithubNotSignedInError ? `skipped: ${e.message}` : `setup failed: ${errorMessage(e)}`);
    return report;
  }

  const targets = checklistTargets(store);

  for (const { project, owner, repo } of targets) {
    if (client.rateLimited) {
      report.partial = true;
      break;
    }
    checked.count++;

    let readable: boolean;
    try {
      readable = (await client.getOrNull(`/repos/${owner}/${repo}`)) !== null;
    } catch (e) {
      report.partial = true;
      report.errors.push(e instanceof GithubRateLimitStop ? errorMessage(e) : `${project.slug}: checking ${owner}/${repo}: ${errorMessage(e)}`);
      if (e instanceof GithubRateLimitStop) break;
      continue;
    }
    if (!readable) {
      (report.skipped ??= []).push(`${project.slug}: ${owner}/${repo} cannot be read (not found, or the GitHub App is not installed on it); its checklist tasks were left as they are`);
      continue;
    }

    const files = [project.todoFile ?? 'TODO.md', ...STATIC_FILES];
    try {
      const entries = await client.listDirectory(owner, repo, 'docs');
      if (entries) for (const e of entries) if (e.type === 'file' && isMarkdown(e.name)) files.push(`docs/${e.name}`);
    } catch (e) {
      if (e instanceof GithubRateLimitStop) {
        report.partial = true;
        report.errors.push(errorMessage(e));
        break;
      }
      report.partial = true;
      report.errors.push(`${project.slug}: listing docs/: ${errorMessage(e)}`);
    }

    for (const file of [...new Set(files)]) {
      if (client.rateLimited) {
        report.partial = true;
        break;
      }
      let content: string | null;
      try {
        content = await client.getFileText(owner, repo, file);
      } catch (e) {
        if (e instanceof GithubRateLimitStop) {
          report.partial = true;
          report.errors.push(errorMessage(e));
          break;
        }
        if (e instanceof GithubFileTooLargeError) {
          // A standing condition, not a failure: leave the file's tasks alone and say why.
          (report.skipped ??= []).push(`${project.slug}:${file} is over 1 MB, too large to read; its tasks were left as they are`);
          continue;
        }
        // This file's own fetch failed (network error, 5xx, ...): never gone-sweep it, and
        // never treat "not found" and "we couldn't tell" the same way.
        report.partial = true;
        report.errors.push(`${project.slug}:${file}: ${errorMessage(e)}`);
        continue;
      }
      const text = content ?? ''; // 404 (file absent) parses to zero items, same as an empty file.

      if (dryRun) {
        for (const item of checklistToSourceItems(text, project.slug, file)) {
          const action = previewUpsert(store, {
            sourceType: 'todo_md',
            sourceId: item.sourceId,
            title: item.text,
            notes: item.notes,
            projectId: project.id,
            contentHash: item.contentHash,
            initialStatus: item.checked ? 'done' : 'open',
          });
          tallyUpsert(report, action);
          log(`  [${action}] ${item.sourceId} ${item.text}`);
        }
        continue; // preview only: never write structure or sweep in a dry run
      }

      const r = importChecklistContent(store, project, file, text);
      report.scanned += r.created + r.updated + r.unchanged;
      report.created += r.created;
      report.updated += r.updated;
      report.unchanged += r.unchanged;
      report.goneCompleted += r.gone;
      log(`  ${project.slug}:${file}: created ${r.created}, updated ${r.updated}, unchanged ${r.unchanged}, gone ${r.gone}`);
    }
  }

  report.apiCalls = client.apiCalls;
  if (!dryRun && !report.partial) client.commitEtagCache();
  else client.discardEtagCache();
  return report;
}

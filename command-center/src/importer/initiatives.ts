// Imports each initiatives/*.md file in this repo as an 'initiative' project, with the checkboxes
// under its Tasks and Success Criteria headings as tasks. These are the owner's own files in this
// repo, so their tasks are owner-authored and skip the inbox. projects.yaml and its importer were
// removed on 2026-09-20: a repo becomes a project from the dashboard's GitHub page, and a project
// with no repo is made in the Projects tab.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Project, Store } from '../core/index.ts';
import { slugify } from '../core/index.ts';
import { checklistToSourceItems, goneSourceIds } from './checklist.ts';

/** Store.upsertProject no-ops (leaves updated_at alone) when nothing actually changed. */
function classify(counts: { created: number; updated: number; unchanged: number }, before: Project | undefined, after: Project): void {
  if (!before) counts.created++;
  else if (before.updatedAt !== after.updatedAt) counts.updated++;
  else counts.unchanged++;
}

function extractSection(markdown: string, heading: string): string | null {
  const re = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  const m = re.exec(markdown);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = markdown.slice(start);
  const next = /^##\s+/m.exec(rest);
  return rest.slice(0, next ? next.index : undefined);
}

export interface InitiativeFileCounts {
  created: number;
  updated: number;
  unchanged: number;
  tasks: { created: number; updated: number; unchanged: number; gone: number };
}

/** Where the importer looks: the initiatives/ folder under the repo root (CC_REPO_ROOT). */
export function initiativesDir(repoRoot: string): string {
  return join(repoRoot, 'initiatives');
}

/**
 * Whether there is anything to import. The importer is for a repo that keeps its plans as
 * initiatives/*.md; a checkout without that folder (the public repo, an installed desktop app)
 * has nothing for it to do, and the callers say so instead of reporting zero counts.
 */
export function hasInitiatives(repoRoot: string): boolean {
  return existsSync(initiativesDir(repoRoot));
}

/** Each initiatives/*.md file (skipping README.md / _TEMPLATE.md) as an 'initiative' project. */
export function importInitiativeFiles(store: Store, repoRoot: string): InitiativeFileCounts {
  const counts: InitiativeFileCounts = { created: 0, updated: 0, unchanged: 0, tasks: { created: 0, updated: 0, unchanged: 0, gone: 0 } };
  const dir = initiativesDir(repoRoot);
  if (!existsSync(dir)) return counts;
  const skip = new Set(['README.md', '_TEMPLATE.md']);
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md') && !skip.has(f));

  for (const file of files) {
    const content = readFileSync(join(dir, file), 'utf8');
    const h1 = /^#\s+(.+?)\s*$/m.exec(content);
    const rawTitle = h1 ? h1[1] : file.replace(/\.md$/i, '');
    const name = rawTitle.replace(/^initiative\s*:\s*/i, '').trim() || file.replace(/\.md$/i, '');
    const slug = `initiative-${slugify(name)}`;
    const before = store.getProject(slug);
    const project = store.upsertProject({ slug, name, category: 'initiative', meta: { initiativeFile: `initiatives/${file}` } });
    classify(counts, before, project);

    const currentIds = new Set<string>();
    const prefix = `${project.slug}:${file}:`;
    const prevActive = store.activeSourceIds('initiative_md', prefix);

    for (const heading of ['Tasks', 'Success Criteria']) {
      const body = extractSection(content, heading);
      if (!body) continue;
      const section = store.ensureSection(project.id, heading);
      const parsedBySourceId = new Map<string, string>(); // sourceId -> created/updated task id
      for (const item of checklistToSourceItems(body, project.slug, file)) {
        currentIds.add(item.sourceId);
        const result = store.upsertFromSource({
          sourceType: 'initiative_md',
          sourceId: item.sourceId,
          title: item.text,
          notes: item.notes,
          projectId: project.id,
          contentHash: item.contentHash,
          initialStatus: item.checked ? 'done' : 'open',
          sourceCompleted: item.checked,
        }, 'system');
        counts.tasks[result.action === 'suppressed' ? 'unchanged' : result.action]++;
        parsedBySourceId.set(item.sourceId, result.task.id);

        const desiredParentId = item.parentSourceId ? parsedBySourceId.get(item.parentSourceId) ?? null : null;
        const desiredSectionId = item.depth === 0 ? section.id : null;
        store.moveTask(result.task.id, { parentId: desiredParentId, sectionId: desiredSectionId }, 'system');
        // Only when the file's own tick changed since the last import: an unticked box that was
        // already unticked is the file staying silent, not disagreeing. Same rule as the field merge.
        if (result.sourceTickChanged) {
          if (item.checked && result.task.status !== 'done') store.completeTask(result.task.id, 'system');
          else if (!item.checked && result.task.status === 'done') store.reopenTask(result.task.id, 'system');
        }
      }
    }

    for (const goneId of goneSourceIds(prevActive, currentIds)) {
      store.markSourceGone('initiative_md', goneId, 'drop_open', 'system');
      counts.tasks.gone++;
    }
  }
  return counts;
}

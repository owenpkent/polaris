// Turns the checkboxes of one project-relative markdown file into owner-authored tasks. Owner-authored
// content is trusted, so it bypasses the inbox (initialStatus 'open'/'done'). This module never
// touches the disk or the network: ingest/github/repoFiles.ts fetches each file over the GitHub
// contents API and hands the text in. Reading checklists from a local clone was removed on
// 2026-09-20, so every machine sees the same tasks.

import type { Project, Store } from '../core/index.ts';
import { checklistToSourceItems, goneSourceIds } from './checklist.ts';

export interface TodoImportResult {
  project: string;
  file: string;
  created: number;
  updated: number;
  unchanged: number;
  gone: number;
}

/**
 * Parse already-read markdown content for one project-relative file and upsert its checkboxes
 * as owner-authored tasks, syncing checked state and sweeping ids that vanished from this file.
 * Pure with respect to the filesystem and network: the caller obtains `content`.
 */
export function importChecklistContent(store: Store, project: Pick<Project, 'id' | 'slug'>, file: string, content: string): TodoImportResult {
  const result: TodoImportResult = { project: project.slug, file, created: 0, updated: 0, unchanged: 0, gone: 0 };
  const prefix = `${project.slug}:${file}:`;
  const prevActive = store.activeSourceIds('todo_md', prefix);
  const currentIds = new Set<string>();
  const taskIdBySourceId = new Map<string, string>();
  const sectionIdByHeading = new Map<string, string>();

  for (const item of checklistToSourceItems(content, project.slug, file)) {
    currentIds.add(item.sourceId);
    const r = store.upsertFromSource(
      {
        sourceType: 'todo_md',
        sourceId: item.sourceId,
        title: item.text,
        notes: item.notes,
        projectId: project.id,
        contentHash: item.contentHash,
        initialStatus: item.checked ? 'done' : 'open',
        sourceCompleted: item.checked,
      },
      'system',
    );
    result[r.action === 'suppressed' ? 'unchanged' : r.action]++;
    taskIdBySourceId.set(item.sourceId, r.task.id);

    const desiredParentId = item.parentSourceId ? taskIdBySourceId.get(item.parentSourceId) ?? null : null;
    let desiredSectionId: string | null = null;
    if (item.depth === 0 && item.headingPath.length) {
      const heading = item.headingPath[item.headingPath.length - 1];
      let sid = sectionIdByHeading.get(heading);
      if (!sid) {
        sid = store.ensureSection(project.id, heading).id;
        sectionIdByHeading.set(heading, sid);
      }
      desiredSectionId = sid;
    }
    store.moveTask(r.task.id, { parentId: desiredParentId, sectionId: desiredSectionId }, 'system');

    const current = store.getTask(r.task.id)!;
    // Only when the file's own tick changed since the last import: an unticked box that was
    // already unticked is the file staying silent, not disagreeing. Same rule as the field merge.
    if (r.sourceTickChanged) {
      if (item.checked && current.status !== 'done') store.completeTask(current.id, 'system');
      else if (!item.checked && current.status === 'done') store.reopenTask(current.id, 'system');
    }
  }

  for (const goneId of goneSourceIds(prevActive, currentIds)) {
    store.markSourceGone('todo_md', goneId, 'drop_open', 'system');
    result.gone++;
  }
  return result;
}

// Puts back what one entry in a task's history changed (CC-S4 in docs/research/standard-notes-dossier.md).
//
// For a task.updated entry that is the value each field had before the edit. For a
// task.sync_conflict entry it is the edit that lost the merge, so an offline change that was
// outvoted can still be had. Only a task's own content comes back: status and place have their own
// one-click controls, and completing or moving through here would skip what those do. The restore
// is an ordinary edit, recorded in history like any other, so it can itself be put back.
import { ValidationError, type Store } from './store.ts';
import type { CcEvent, Json, Task, TaskPatch } from './types.ts';

export const RESTORABLE_FIELDS = ['title', 'notes', 'priority', 'dueAt', 'startAt', 'estimateMinutes', 'recurrence'] as const;

function restorable(field: string): boolean {
  return (RESTORABLE_FIELDS as readonly string[]).includes(field);
}

/** The edit that would put back what `event` changed, or null when nothing in it can come back. */
export function restorePatch(event: CcEvent): TaskPatch | null {
  const patch: Record<string, Json> = {};
  if (event.kind === 'task.updated') {
    const changes = (event.payload.changes ?? {}) as Record<string, Json>;
    for (const [field, pair] of Object.entries(changes)) {
      if (restorable(field) && Array.isArray(pair)) patch[field] = pair[0] ?? null;
    }
  } else if (event.kind === 'task.sync_conflict') {
    const field = event.payload.field;
    if (typeof field === 'string' && restorable(field)) patch[field] = event.payload.discarded ?? null;
  }
  // A title cannot be emptied, so an entry that would do that has nothing to put back.
  if (patch.title !== undefined && (typeof patch.title !== 'string' || !patch.title.trim())) delete patch.title;
  return Object.keys(patch).length ? (patch as TaskPatch) : null;
}

export function restoreFromHistory(store: Store, taskId: string, eventId: number, actor: CcEvent['actor']): Task {
  const event = store.taskHistory(taskId).find((e) => e.id === eventId);
  if (!event) throw new ValidationError(`event ${eventId} is not in the history of task ${taskId}`);
  const patch = restorePatch(event);
  if (!patch) throw new ValidationError('nothing in that history entry can be put back');
  return store.updateTask(taskId, patch, actor);
}

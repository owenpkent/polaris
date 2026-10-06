// Replays the edits a dashboard made while the server was unreachable (initiatives/offline-clone.md).
//
// The merge is the KeePass one, per field: if nobody else changed a field since the device last
// saw the task, the edit applies. If somebody did, the newer of the two edits wins and the losing
// value is written to the task's history as task.sync_conflict, so nothing vanishes without a
// trace. "When" is when the edit was made, not when it arrived: a change that itself came through
// here is weighed by its recorded edit time (applied_ops.edited_at), so two devices that were
// both offline are ordered by their clocks rather than by who reconnected first. Two edits made in
// the same millisecond are ordered by op id, so the result never depends on arrival order either.
//
// What an op may do is a closed list: create a task of the owner's own, edit one, complete, reopen or
// move it, and comment on it. There is no op that accepts or rejects an inbox suggestion, touches
// a rule, a goal or a project, or deletes anything, and an op aimed at a task still in the inbox
// is refused. Those decisions stay a live click (src/invariants.test.ts).
import { NotFoundError, ValidationError, type Store } from './store.ts';
import type { Json, Task, TaskPatch, TaskStatus } from './types.ts';

export const OUTBOX_OP_KINDS = ['create_task', 'update_task', 'complete_task', 'reopen_task', 'move_task', 'add_comment'] as const;
export type OutboxOpKind = typeof OUTBOX_OP_KINDS[number];

/** The task fields an offline edit may set. Source fields and `inbox` are deliberately absent. */
export const OUTBOX_PATCH_FIELDS = ['title', 'notes', 'priority', 'dueAt', 'startAt', 'recurrence', 'status', 'estimateMinutes', 'projectId', 'sectionId', 'assignee'] as const;
const OUTBOX_STATUSES: TaskStatus[] = ['open', 'in_progress', 'waiting', 'done', 'dropped'];

export interface OutboxOp {
  opId: string;
  deviceId: string;
  kind: OutboxOpKind;
  taskId: string;
  /** When the edit was made on the device. */
  at: string;
  /** The task's updatedAt as the device last saw it. Null for a task the device created itself. */
  base: string | null;
  body: Record<string, Json>;
}

export interface OutboxConflict {
  field: string;
  kept: Json;
  discarded: Json;
}

export interface OutboxResult {
  opId: string;
  taskId: string;
  title: string | null;
  /** applied: done in full. conflict: at least one field lost to a newer edit. duplicate: seen before. rejected: refused. */
  status: 'applied' | 'conflict' | 'duplicate' | 'rejected';
  conflicts: OutboxConflict[];
  error: string | null;
}

export type MoveTarget = { projectId?: string | null; sectionId?: string | null; parentId?: string | null; position?: number };

export interface ApplyOutboxOptions {
  /** Turns a move op's body (project ref, section name or id) into ids. REST passes its own resolver. */
  resolveMove?: (task: Task, body: Record<string, Json>) => MoveTarget;
}

/**
 * When an edit was made, and a key that breaks a tie between two edits made in the same
 * millisecond: the op id, or LIVE_KEY for a live edit, which has none. Device clocks are not
 * synchronized, so an equal time is not the same edit, and the order has to come from something
 * both replays see alike rather than from which arrived first.
 */
interface EditStamp {
  at: string;
  key: string;
}

// Sorts above every op id, so a live edit wins a tie: its time is when the server saw it, while an
// op's is only what the device claims, and may have been clamped to now.
const LIVE_KEY = '￿';

function isNewer(a: EditStamp, b: EditStamp): boolean {
  return a.at > b.at || (a.at === b.at && a.key > b.key);
}

/** The latest change to each field after `base` that did not come from `deviceId`, with when it was made. */
function competingChanges(store: Store, taskId: string, base: string | null, deviceId: string): Map<string, EditStamp> {
  const out = new Map<string, EditStamp>();
  if (base === null) return out;
  const ops = store.appliedOpsForTask(taskId);
  for (const event of store.taskHistory(taskId)) {
    const op = ops.find((o) => event.id > o.firstEventId && event.id <= o.lastEventId);
    if (op?.deviceId === deviceId) continue;
    // It competes only if it reached the server after this device last looked. Its weight is
    // when it was made, which for another device's offline edit is earlier than when it arrived.
    if (event.at <= base) continue;
    const stamp: EditStamp = op ? { at: op.editedAt, key: op.opId } : { at: event.at, key: LIVE_KEY };
    let fields: string[] = [];
    if (event.kind === 'task.updated') fields = Object.keys((event.payload.changes ?? {}) as Record<string, Json>);
    else if (event.kind === 'task.completed' || event.kind === 'task.reopened') fields = ['status'];
    else if (event.kind === 'task.moved') fields = ['projectId', 'sectionId', 'parentId'];
    for (const f of fields) hold(out, f, stamp);
  }
  // An op that asked for the value a field already had changed nothing, so it left no event, but
  // it still holds the field from then on: a later edit has to be newer than it, not only newer
  // than whoever set the value first. Its fields are kept in its recorded result as `held`.
  for (const op of ops) {
    if (op.deviceId === deviceId || op.appliedAt <= base) continue;
    const held = Array.isArray(op.result.held) ? (op.result.held as string[]) : [];
    for (const f of held) hold(out, f, { at: op.editedAt, key: op.opId });
  }
  return out;
}

function hold(out: Map<string, EditStamp>, field: string, stamp: EditStamp): void {
  const prev = out.get(field);
  if (!prev || isNewer(stamp, prev)) out.set(field, stamp);
}

function clampToNow(at: string, now: string): string {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return now;
  const iso = new Date(t).toISOString();
  return iso > now ? now : iso;
}

interface Merged {
  apply: Record<string, Json>;
  conflicts: OutboxConflict[];
  /** Fields that already had the wanted value and that this op now holds, being the newest edit. */
  held: string[];
}

/** Splits the wanted field values into those that apply and those that lose to a newer edit. */
function mergeFields(store: Store, task: Task, op: OutboxOp, editedAt: string, wanted: Record<string, Json>): Merged {
  const competing = competingChanges(store, task.id, op.base, op.deviceId);
  const mine: EditStamp = { at: editedAt, key: op.opId };
  const apply: Record<string, Json> = {};
  const conflicts: OutboxConflict[] = [];
  const held: string[] = [];
  for (const [field, value] of Object.entries(wanted)) {
    const current = (task as unknown as Record<string, Json>)[field] ?? null;
    const theirs = competing.get(field);
    if (current === value) {
      if (!theirs || isNewer(mine, theirs)) held.push(field);
      continue;
    }
    if (!theirs) { apply[field] = value; continue; }
    if (isNewer(mine, theirs)) {
      apply[field] = value;
      conflicts.push({ field, kept: value, discarded: current });
    } else {
      conflicts.push({ field, kept: current, discarded: value });
    }
  }
  return { apply, conflicts, held };
}

function applyOne(store: Store, op: OutboxOp, editedAt: string, opts: ApplyOutboxOptions): { task: Task | null; conflicts: OutboxConflict[]; held: string[] } {
  // The op kinds are a closed list. The HTTP schema checks it too, but the core must not rely on
  // that: the update branch below would otherwise read any unknown kind as an edit.
  if (!(OUTBOX_OP_KINDS as readonly string[]).includes(op.kind)) throw new ValidationError(`unknown op kind: ${String(op.kind)}`);
  if (op.kind === 'create_task') {
    const existing = store.getTask(op.taskId);
    if (existing) return { task: existing, conflicts: [], held: [] };
    const b = op.body;
    if (typeof b.title !== 'string' || !b.title.trim()) throw new ValidationError('title is required');
    const task = store.createTask({
      title: b.title,
      notes: typeof b.notes === 'string' ? b.notes : undefined,
      projectId: (b.projectId as string | null | undefined) ?? null,
      sectionId: (b.sectionId as string | null | undefined) ?? null,
      parentId: (b.parentId as string | null | undefined) ?? null,
      priority: b.priority as Task['priority'] | undefined,
      dueAt: (b.dueAt as string | null | undefined) ?? null,
      startAt: (b.startAt as string | null | undefined) ?? null,
      recurrence: (b.recurrence as string | null | undefined) ?? null,
      assignee: (b.assignee as string | null | undefined) ?? null,
      // A link saved with a share (quick add from the share sheet). Only the URL: no sourceType,
      // so an offline create can never look like it came from an external source.
      sourceUrl: typeof b.sourceUrl === 'string' && b.sourceUrl ? b.sourceUrl : null,
    }, 'human', { id: op.taskId });
    return { task, conflicts: [], held: [] };
  }

  const task = store.requireTask(op.taskId);
  if (task.status === 'inbox') throw new ValidationError('an inbox suggestion can only be accepted or rejected online');

  if (op.kind === 'add_comment') {
    if (typeof op.body.body !== 'string' || !op.body.body.trim()) throw new ValidationError('body is required');
    store.addComment(task.id, op.body.body, 'human');
    return { task, conflicts: [], held: [] };
  }

  if (op.kind === 'move_task') {
    const to = opts.resolveMove ? opts.resolveMove(task, op.body) : (op.body as MoveTarget);
    const wanted: Record<string, Json> = {};
    for (const f of ['projectId', 'sectionId', 'parentId'] as const) if (to[f] !== undefined) wanted[f] = to[f] ?? null;
    const { apply, conflicts, held } = mergeFields(store, task, op, editedAt, wanted);
    // A move is one decision: if any part of it lost to a newer move, none of it applies.
    const lost = conflicts.some((c) => !(c.field in apply));
    if (lost) return { task, conflicts, held: [] };
    if (!Object.keys(apply).length) return { task, conflicts, held };
    return { task: store.moveTask(task.id, { ...apply, position: to.position }, 'human'), conflicts, held };
  }

  let wanted: Record<string, Json>;
  if (op.kind === 'complete_task') wanted = { status: 'done' };
  else if (op.kind === 'reopen_task') wanted = { status: 'open' };
  else {
    wanted = {};
    for (const f of OUTBOX_PATCH_FIELDS) if (op.body[f] !== undefined) wanted[f] = op.body[f];
    const unknown = Object.keys(op.body).filter((k) => !(OUTBOX_PATCH_FIELDS as readonly string[]).includes(k));
    if (unknown.length) throw new ValidationError(`not editable offline: ${unknown.join(', ')}`);
    if (wanted.status !== undefined && !OUTBOX_STATUSES.includes(wanted.status as TaskStatus)) {
      throw new ValidationError(`status cannot be set to '${String(wanted.status)}' offline`);
    }
  }
  const { apply, conflicts, held } = mergeFields(store, task, op, editedAt, wanted);
  if (!Object.keys(apply).length) return { task, conflicts, held };
  return { task: store.updateTask(task.id, apply as TaskPatch & { status?: TaskStatus }, 'human'), conflicts, held };
}

/** Applies each op in order, each in its own transaction, so one refused op never blocks the rest. */
export function applyOutbox(store: Store, ops: OutboxOp[], opts: ApplyOutboxOptions = {}): OutboxResult[] {
  return ops.map((op): OutboxResult => {
    const seen = store.getAppliedOp(op.opId);
    if (seen) {
      const { held: _held, ...result } = seen.result as unknown as OutboxResult & { held?: string[] };
      return { ...result, status: 'duplicate' };
    }

    const editedAt = clampToNow(op.at, store.timestamp());
    const firstEventId = store.lastEventId();
    // `held` goes into the stored row for later merges (competingChanges), not to the device.
    const record = (result: OutboxResult, held: string[] = []): OutboxResult => {
      store.recordAppliedOp({
        opId: op.opId, deviceId: op.deviceId, taskId: op.taskId, editedAt,
        firstEventId, lastEventId: store.lastEventId(), result: { ...result, held } as unknown as Record<string, Json>,
      });
      return result;
    };
    try {
      // The op is recorded in the transaction that applies it: a crash between the two would
      // let a retry apply it again.
      return store.db.transaction(() => {
        const { task, conflicts, held } = applyOne(store, op, editedAt, opts);
        for (const c of conflicts) {
          store.recordEvent('task.sync_conflict', op.taskId, 'system', { field: c.field, kept: c.kept, discarded: c.discarded, opId: op.opId });
        }
        return record({ opId: op.opId, taskId: op.taskId, title: task?.title ?? null, status: conflicts.length ? 'conflict' : 'applied', conflicts, error: null }, held);
      });
    } catch (e) {
      if (!(e instanceof ValidationError) && !(e instanceof NotFoundError)) throw e;
      return record({ opId: op.opId, taskId: op.taskId, title: null, status: 'rejected', conflicts: [], error: e.message });
    }
  });
}

/** What a dashboard puts on a write it sends while online, so the same write replayed later is recognised. */
export interface OnlineOpIdentity {
  opId?: string;
  deviceId?: string;
}

/**
 * Runs a create or a comment that a dashboard sent online, once per op id. A dashboard that never
 * saw the answer queues the same op and replays it through applyOutbox, which finds it recorded
 * here and reports a duplicate. `write` returns the task the op belongs to, and `again` answers
 * an op id that was already applied. Without an op id the write just runs.
 */
export function applyOnlineOnce<T>(store: Store, ident: OnlineOpIdentity, write: () => { task: Task; value: T }, again: (taskId: string) => T): T {
  if (!ident.opId) return write().value;
  const opId = ident.opId;
  const seen = store.getAppliedOp(opId);
  if (seen) {
    if (!seen.taskId || (seen.result as unknown as OutboxResult).status === 'rejected') throw new ValidationError(`op ${opId} was already refused`);
    return again(seen.taskId);
  }
  const firstEventId = store.lastEventId();
  return store.db.transaction(() => {
    const { task, value } = write();
    const result: OutboxResult = { opId, taskId: task.id, title: task.title, status: 'applied', conflicts: [], error: null };
    store.recordAppliedOp({
      opId, deviceId: ident.deviceId ?? 'online', taskId: task.id, editedAt: store.timestamp(),
      firstEventId, lastEventId: store.lastEventId(), result: result as unknown as Record<string, Json>,
    });
    return value;
  });
}

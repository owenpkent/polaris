// The task graph. Every mutation goes through Store so it is validated, timestamped,
// and recorded in the events table (the audit log and the rules engine's input).

// Web Crypto keeps this file portable to Workers.
import { countRows, type DatabaseCounts, type SqlDriver, type SqlValue } from './db.ts';
import {
  ACTIVE_STATUSES, CONFIDENCES, EXTERNAL_SOURCE_TYPES, GOAL_PROGRESS_MODES, GOAL_STATUSES, JUDGED_POST_TYPES, OPEN_GOAL_STATUSES, POST_STATUSES, POST_TYPES, PRIORITIES, TASK_STATUSES,
  type Actor, type ActorInput, type AppliedOp, type CcEvent, type Comment, type CustomFieldValue, type EventKind, type Goal, type GoalDetail,
  type GoalLink, type GoalPatch, type GoalProgress, type Json, type Link, type NewGoal, type NewPost,
  type NewProject, type NewTask, type Post, type PostSearch, type PostSearchHit, type PostStatus, type PostType, type Priority, type Project, type ProjectInput, type ProjectPatch, type Rule, type SavedView, type Section,
  type SourceItem, type SourceType, type Task, type TaskFilter, type TaskPatch, type TaskStatus, type Thread, type ThreadOptions, type ThreadSummary, type UpsertResult,
} from './types.ts';

const INBOX_HAS_NO_THREAD = 'an inbox task has no thread until the owner accepts it';

export class NotFoundError extends Error {}
export class ValidationError extends Error {}

function appliedOpFromRow(r: Row): AppliedOp {
  return {
    opId: r.op_id as string, deviceId: r.device_id as string, taskId: r.task_id as string | null,
    editedAt: r.edited_at as string, appliedAt: r.applied_at as string,
    firstEventId: r.first_event_id as number, lastEventId: r.last_event_id as number,
    result: parseJson(r.result, {}),
  };
}

/** The shape newId('t') produces. A client-supplied task id must match it. */
export const TASK_ID_PATTERN = /^t_[0-9a-z]{10}$/;

export function newId(prefix: string): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(10));
  let s = '';
  for (const b of bytes) s += alphabet[b % 36];
  return `${prefix}_${s}`;
}

export interface StoreOptions {
  now?: () => string;
  /** Given an RRULE and the previous due date, return the next due date (same format) or null when the series ends. */
  nextOccurrence?: (rrule: string, previousDue: string) => string | null;
  /** Return an error message if the recurrence rule is invalid, else null. */
  validateRecurrence?: (rrule: string) => string | null;
}

type Row = Record<string, SqlValue>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const MERGE_FIELDS = ['title', 'notes', 'dueAt', 'priority'] as const;
const PRIORITY_RANK = `CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;

const bool = (v: SqlValue): boolean => v === 1 || v === '1';
const parseJson = <T>(v: SqlValue, fallback: T): T => {
  if (typeof v !== 'string') return fallback;
  try { return JSON.parse(v) as T; } catch { return fallback; }
};

/** SQLite treats a negative LIMIT as unlimited, so every row-count bound is squeezed through here. */
function clampLimit(limit: number, max = 1000): number {
  return Math.min(Math.max(Math.trunc(limit) || 1, 1), max);
}

/** Carry a recurring task's lead time onto its next occurrence: same gap, new due date. */
function shiftStartAt(startAt: string | null, previousDue: string | null, nextDue: string): string | null {
  if (!startAt) return null;
  if (!previousDue) return startAt;
  const day = 86_400_000;
  const gap = Math.round((Date.parse(`${previousDue.slice(0, 10)}T00:00:00Z`) - Date.parse(`${startAt.slice(0, 10)}T00:00:00Z`)) / day);
  if (!Number.isFinite(gap)) return null;
  return new Date(Date.parse(`${nextDue.slice(0, 10)}T00:00:00Z`) - gap * day).toISOString().slice(0, 10);
}

/** An assignee is a one-line trimmed name or null; blank means unclaimed, so clearing from a form works. */
function normalizeAssignee(v: string | null | undefined): string | null {
  if (v == null) return null;
  const name = v.replace(/\s+/g, ' ').trim();
  return name ? name : null;
}

/**
 * Every write method accepts an ActorInput: either a plain Actor, or an actor with a self-declared
 * name riding beside it (an MCP connection started with --agent-name or X-Agent-Name). This is the
 * one place that tells the two apart, so emit() and addComment() always have a real Actor to put in
 * the actor column and a name (or null) to put beside it.
 */
function normalizeActorInput(who: ActorInput): { actor: Actor; name: string | null } {
  return typeof who === 'string' ? { actor: who, name: null } : { actor: who.actor, name: who.name ?? null };
}

function rowToThread(r: Row): Thread {
  return {
    id: r.id as string, taskId: r.task_id as string, title: r.title as string, status: r.status as Thread['status'],
    pinnedPostId: (r.pinned_post_id as string | null) ?? null,
    authorHidden: bool(r.author_hidden), dailyCap: (r.daily_cap as number | null) ?? null,
    successorThreadId: (r.successor_thread_id as string | null) ?? null,
    createdAt: r.created_at as string, closedAt: (r.closed_at as string | null) ?? null,
  };
}

function rowToPost(r: Row): Post {
  return {
    id: r.id as string, threadId: r.thread_id as string, parentPostId: (r.parent_post_id as string | null) ?? null,
    author: r.author as Post['author'], authorName: (r.author_name as string | null) ?? null,
    type: r.type as PostType, body: r.body as string, confidence: (r.confidence as Post['confidence']) ?? null,
    status: (r.status as PostStatus | null) ?? null, refs: parseJson<string[]>(r.refs, []),
    untrustedText: bool(r.untrusted_text), judgedAt: (r.judged_at as string | null) ?? null, createdAt: r.created_at as string,
  };
}

function rowToTask(r: Row): Task {
  return {
    id: r.id as string,
    projectId: r.project_id as string | null,
    sectionId: r.section_id as string | null,
    parentId: r.parent_id as string | null,
    title: r.title as string,
    notes: r.notes as string,
    status: r.status as TaskStatus,
    priority: r.priority as Priority,
    dueAt: r.due_at as string | null,
    startAt: r.start_at as string | null,
    estimateMinutes: r.estimate_minutes as number | null,
    recurrence: r.recurrence as string | null,
    assignee: (r.assignee as string | null) ?? null,
    isMilestone: bool(r.is_milestone),
    position: r.position as number,
    sourceType: r.source_type as SourceType | null,
    sourceId: r.source_id as string | null,
    sourceUrl: r.source_url as string | null,
    confidence: r.confidence as number | null,
    // Stored OR derived, and only ever raising. The column catches tasks derived from untrusted
    // ones, which have no source of their own; the source check catches rows ingested before their
    // type was added to EXTERNAL_SOURCE_TYPES, which the stored flag alone would leave trusted.
    // Promoting a type should still ship a backfill migration, but nothing depends on remembering.
    untrustedText: bool(r.untrusted_text)
      || (r.source_type != null && EXTERNAL_SOURCE_TYPES.includes(r.source_type as SourceType)),
    customFields: parseJson(r.custom_fields, {}),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    completedAt: r.completed_at as string | null,
  };
}

function rowToProject(r: Row): Project {
  return {
    id: r.id as string,
    slug: r.slug as string,
    name: r.name as string,
    category: r.category as string | null,
    type: r.type as string | null,
    description: r.description as string | null,
    status: r.status as string | null,
    path: r.path as string | null,
    github: r.github as string | null,
    todoFile: r.todo_file as string | null,
    archived: bool(r.archived),
    meta: parseJson(r.meta, {}),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function rowToGoal(r: Row): Goal {
  return {
    id: r.id as string,
    title: r.title as string,
    notes: r.notes as string,
    parentId: r.parent_id as string | null,
    periodLabel: r.period_label as string | null,
    startsOn: r.starts_on as string | null,
    endsOn: r.ends_on as string | null,
    status: r.status as Goal['status'],
    statusNote: r.status_note as string,
    statusUpdatedAt: r.status_updated_at as string | null,
    progressMode: r.progress_mode as Goal['progressMode'],
    currentValue: r.current_value as number | null,
    targetValue: r.target_value as number | null,
    unit: r.unit as string | null,
    position: r.position as number,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function rowToGoalLink(r: Row): GoalLink {
  return {
    goalId: r.goal_id as string,
    projectId: r.project_id as string | null,
    taskId: r.task_id as string | null,
    createdAt: r.created_at as string,
  };
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

export function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-');
}

export class Store {
  readonly db: SqlDriver;
  private readonly now: () => string;
  private readonly nextOccurrence?: StoreOptions['nextOccurrence'];
  private readonly validateRecurrence?: StoreOptions['validateRecurrence'];

  constructor(db: SqlDriver, opts: StoreOptions = {}) {
    this.db = db;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.nextOccurrence = opts.nextOccurrence;
    this.validateRecurrence = opts.validateRecurrence;
  }

  // ---------------------------------------------------------------- events

  private emit(kind: EventKind, taskId: string | null, who: ActorInput, payload: Record<string, Json> = {}): void {
    const { actor, name } = normalizeActorInput(who);
    this.db.run('INSERT INTO events (at, kind, task_id, actor, actor_name, payload) VALUES (?, ?, ?, ?, ?, ?)',
      [this.now(), kind, taskId, actor, name, JSON.stringify(payload)]);
  }

  recordEvent(kind: EventKind, taskId: string | null, actor: ActorInput, payload: Record<string, Json> = {}): void {
    this.emit(kind, taskId, actor, payload);
  }

  eventsSince(afterId: number, limit = 500): CcEvent[] {
    // SQLite reads a negative LIMIT as "no limit", and the events table only ever grows, so the
    // clamp lives here rather than at each caller. Mirrors searchTasks.
    return this.db.all<Row>('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?',
      [Math.max(afterId, 0), clampLimit(limit)]).map((r) => ({
      id: r.id as number,
      at: r.at as string,
      kind: r.kind as EventKind,
      taskId: r.task_id as string | null,
      actor: r.actor as Actor,
      actorName: (r.actor_name as string | null) ?? null,
      payload: parseJson(r.payload, {}),
    }));
  }

  taskHistory(taskId: string): CcEvent[] {
    return this.db.all<Row>('SELECT * FROM events WHERE task_id = ? ORDER BY id', [taskId]).map((r) => ({
      id: r.id as number, at: r.at as string, kind: r.kind as EventKind, taskId: r.task_id as string | null,
      actor: r.actor as Actor, actorName: (r.actor_name as string | null) ?? null, payload: parseJson(r.payload, {}),
    }));
  }

  // ------------------------------------------------------------ offline ops

  /** The store's clock, for callers that must compare a time of their own against it. */
  timestamp(): string {
    return this.now();
  }

  getAppliedOp(opId: string): AppliedOp | null {
    const r = this.db.get<Row>('SELECT * FROM applied_ops WHERE op_id = ?', [opId]);
    return r ? appliedOpFromRow(r) : null;
  }

  recordAppliedOp(op: Omit<AppliedOp, 'appliedAt'>): void {
    this.db.run(
      `INSERT INTO applied_ops (op_id, device_id, task_id, edited_at, applied_at, first_event_id, last_event_id, result)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [op.opId, op.deviceId, op.taskId, op.editedAt, this.now(), op.firstEventId, op.lastEventId, JSON.stringify(op.result)]);
  }

  appliedOpsForTask(taskId: string): AppliedOp[] {
    return this.db.all<Row>('SELECT * FROM applied_ops WHERE task_id = ? ORDER BY first_event_id', [taskId]).map(appliedOpFromRow);
  }

  lastEventId(): number {
    return this.db.get<{ id: number | null }>('SELECT MAX(id) AS id FROM events')?.id ?? 0;
  }

  // -------------------------------------------------------------- projects

  upsertProject(p: NewProject, actor: ActorInput = 'system'): Project {
    if (!p.slug || !p.name) throw new ValidationError('project slug and name are required');
    const now = this.now();
    return this.db.transaction(() => {
      const existing = this.getProject(p.slug);
      if (existing) {
        const merged = {
          name: p.name,
          category: p.category !== undefined ? p.category : existing.category,
          type: p.type !== undefined ? p.type : existing.type,
          description: p.description !== undefined ? p.description : existing.description,
          status: p.status !== undefined ? p.status : existing.status,
          path: p.path !== undefined ? p.path : existing.path,
          github: p.github !== undefined ? p.github : existing.github,
          todoFile: p.todoFile !== undefined ? p.todoFile : existing.todoFile,
          archived: p.archived !== undefined ? p.archived : existing.archived,
          meta: p.meta !== undefined ? { ...existing.meta, ...p.meta } : existing.meta,
        };
        const unchanged = merged.name === existing.name && merged.category === existing.category && merged.type === existing.type
          && merged.description === existing.description && merged.status === existing.status && merged.path === existing.path
          && merged.github === existing.github && merged.todoFile === existing.todoFile && merged.archived === existing.archived
          && JSON.stringify(merged.meta) === JSON.stringify(existing.meta);
        if (unchanged) return existing;
        this.db.run(
          `UPDATE projects SET name=?, category=?, type=?, description=?, status=?, path=?, github=?, todo_file=?, archived=?, meta=?, updated_at=? WHERE id=?`,
          [merged.name, merged.category, merged.type, merged.description, merged.status, merged.path, merged.github,
            merged.todoFile, merged.archived ? 1 : 0, JSON.stringify(merged.meta), now, existing.id]);
      } else {
        const id = newId('p');
        this.db.run(
          `INSERT INTO projects (id, slug, name, category, type, description, status, path, github, todo_file, archived, meta, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, p.slug, p.name, p.category ?? null, p.type ?? null, p.description ?? null, p.status ?? null, p.path ?? null,
            p.github ?? null, p.todoFile ?? null, p.archived ? 1 : 0, JSON.stringify(p.meta ?? {}), now, now]);
      }
      const out = this.getProject(p.slug)!;
      this.emit('project.upserted', null, actor, { projectId: out.id, slug: out.slug });
      return out;
    });
  }

  /** A project made by hand (dashboard or MCP), not by an importer. The slug comes from the name and must be new. */
  createProject(input: ProjectInput, actor: ActorInput = 'human'): Project {
    const name = input.name?.trim();
    if (!name) throw new ValidationError('project name is required');
    const slug = slugify(name);
    if (!slug) throw new ValidationError('project name needs at least one letter or digit');
    if (this.getProject(slug)) throw new ValidationError(`a project with the slug "${slug}" already exists`);
    return this.upsertProject({ ...input, slug, name }, actor);
  }

  /** Change a project's own fields. `null` clears a field; a field left out is untouched. The slug never changes. */
  updateProject(idOrSlug: string, patch: ProjectPatch, actor: ActorInput = 'human'): Project {
    const existing = this.getProject(idOrSlug);
    if (!existing) throw new NotFoundError(`project not found: ${idOrSlug}`);
    const name = patch.name !== undefined ? patch.name.trim() : existing.name;
    if (!name) throw new ValidationError('project name is required');
    return this.upsertProject({ ...patch, slug: existing.slug, name }, actor);
  }

  getProject(idOrSlug: string): Project | undefined {
    const r = this.db.get<Row>('SELECT * FROM projects WHERE id = ? OR slug = ?', [idOrSlug, idOrSlug]);
    return r ? rowToProject(r) : undefined;
  }

  /** Resolve by id, slug, or case-insensitive name. */
  findProject(ref: string): Project | undefined {
    return this.getProject(ref) ?? this.getProject(slugify(ref)) ?? (() => {
      const r = this.db.get<Row>('SELECT * FROM projects WHERE lower(name) = lower(?)', [ref]);
      return r ? rowToProject(r) : undefined;
    })();
  }

  listProjects(opts: { includeArchived?: boolean } = {}): Project[] {
    const sql = opts.includeArchived ? 'SELECT * FROM projects ORDER BY name' : 'SELECT * FROM projects WHERE archived = 0 ORDER BY name';
    return this.db.all<Row>(sql).map(rowToProject);
  }

  // -------------------------------------------------------------- sections

  listSections(projectId: string): Section[] {
    return this.db.all<Row>('SELECT * FROM sections WHERE project_id = ? ORDER BY position', [projectId]).map((r) => ({
      id: r.id as string, projectId: r.project_id as string, name: r.name as string, position: r.position as number,
    }));
  }

  ensureSection(projectId: string, name: string): Section {
    const existing = this.db.get<Row>('SELECT * FROM sections WHERE project_id = ? AND name = ?', [projectId, name]);
    if (existing) return { id: existing.id as string, projectId, name, position: existing.position as number };
    if (!this.getProject(projectId)) throw new NotFoundError(`project ${projectId} not found`);
    const pos = (this.db.get<{ p: number | null }>('SELECT MAX(position) AS p FROM sections WHERE project_id = ?', [projectId])?.p ?? 0) + 1;
    const id = newId('s');
    this.db.run('INSERT INTO sections (id, project_id, name, position) VALUES (?, ?, ?, ?)', [id, projectId, name, pos]);
    return { id, projectId, name, position: pos };
  }

  // ----------------------------------------------------------------- tasks

  getTask(id: string): Task | undefined {
    const r = this.db.get<Row>('SELECT * FROM tasks WHERE id = ?', [id]);
    return r ? rowToTask(r) : undefined;
  }

  requireTask(id: string): Task {
    const t = this.getTask(id);
    if (!t) throw new NotFoundError(`task ${id} not found`);
    return t;
  }

  getTaskBySource(sourceType: SourceType, sourceId: string): Task | undefined {
    const r = this.db.get<Row>('SELECT * FROM tasks WHERE source_type = ? AND source_id = ?', [sourceType, sourceId]);
    return r ? rowToTask(r) : undefined;
  }

  private validate(input: TaskPatch & { status?: TaskStatus }): void {
    if (input.title !== undefined && !input.title.trim()) throw new ValidationError('title must not be empty');
    if (input.status !== undefined && !TASK_STATUSES.includes(input.status)) throw new ValidationError(`invalid status ${input.status}`);
    if (input.priority !== undefined && !PRIORITIES.includes(input.priority)) throw new ValidationError(`invalid priority ${input.priority}`);
    for (const k of ['dueAt', 'startAt'] as const) {
      const v = input[k];
      if (v != null && !DATE_RE.test(v)) throw new ValidationError(`${k} must be YYYY-MM-DD or ISO datetime, got ${v}`);
    }
    if (input.recurrence && this.validateRecurrence) {
      const problem = this.validateRecurrence(input.recurrence);
      if (problem) throw new ValidationError(`invalid recurrence "${input.recurrence}": ${problem}`);
    }
    if (input.confidence != null && (input.confidence < 0 || input.confidence > 1)) throw new ValidationError('confidence must be 0..1');
    if (input.assignee != null) {
      if (typeof input.assignee !== 'string') throw new ValidationError('assignee must be a name or null');
      if (input.assignee.trim().length > 200) throw new ValidationError('assignee must be 200 characters or fewer');
    }
    if (input.projectId && !this.getProject(input.projectId)) throw new NotFoundError(`project ${input.projectId} not found`);
    if (input.sectionId) {
      const s = this.db.get<Row>('SELECT project_id FROM sections WHERE id = ?', [input.sectionId]);
      if (!s) throw new NotFoundError(`section ${input.sectionId} not found`);
    }
    if (input.parentId && !this.getTask(input.parentId)) throw new NotFoundError(`parent task ${input.parentId} not found`);
  }

  private nextPosition(projectId: string | null, sectionId: string | null): number {
    const r = this.db.get<{ p: number | null }>(
      'SELECT MAX(position) AS p FROM tasks WHERE project_id IS ? AND section_id IS ?', [projectId, sectionId]);
    return (r?.p ?? 0) + 1;
  }

  /** `opts.id` is for a task a dashboard created offline, which already carries the id it minted. */
  createTask(input: NewTask, actor: ActorInput = 'human', opts: { id?: string } = {}): Task {
    this.validate(input);
    if (opts.id !== undefined && !TASK_ID_PATTERN.test(opts.id)) throw new ValidationError(`not a task id: ${opts.id}`);
    const now = this.now();
    const status = input.status ?? 'open';
    // Propose, do not act: third-party text may only ever enter as an inbox suggestion, whichever
    // path creates the task. upsertFromSource gates its own input, but it is not the only caller --
    // the REST and MCP write paths both accept a caller-supplied sourceType, so the gate lives here
    // as well and covers every future caller by default.
    const external = input.sourceType != null && EXTERNAL_SOURCE_TYPES.includes(input.sourceType);
    if (external && status !== 'inbox') {
      throw new ValidationError(`${input.sourceType} tasks must start in the inbox, not as '${status}'`);
    }
    // One-way: an external source raises the flag on its own, and a caller may raise it for a task
    // it derived from untrusted text, but nothing here can lower it.
    const untrustedText = external || input.untrustedText === true;
    const projectId = input.projectId ?? (input.parentId ? this.getTask(input.parentId)?.projectId ?? null : null);
    const sectionId = input.sectionId ?? null;
    const id = opts.id ?? newId('t');
    return this.db.transaction(() => {
      this.db.run(
        `INSERT INTO tasks (id, project_id, section_id, parent_id, title, notes, status, priority, due_at, start_at, estimate_minutes,
          recurrence, assignee, is_milestone, position, source_type, source_id, source_url, confidence, untrusted_text,
          custom_fields, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, projectId, sectionId, input.parentId ?? null, input.title.trim(), input.notes ?? '', status, input.priority ?? 'none',
          input.dueAt ?? null, input.startAt ?? null, input.estimateMinutes ?? null, input.recurrence ?? null, normalizeAssignee(input.assignee),
          input.isMilestone ? 1 : 0, this.nextPosition(projectId, sectionId), input.sourceType ?? null, input.sourceId ?? null,
          input.sourceUrl ?? null, input.confidence ?? null, untrustedText ? 1 : 0, JSON.stringify(input.customFields ?? {}), now, now,
          status === 'done' ? now : null]);
      this.emit('task.created', id, actor, {
        title: input.title, status, projectId, source: input.sourceType ? `${input.sourceType}:${input.sourceId}` : null,
      });
      return this.requireTask(id);
    });
  }

  updateTask(id: string, patch: TaskPatch & { status?: TaskStatus }, actor: ActorInput = 'human'): Task {
    this.validate(patch);
    // Normalised up front so the history records what was stored: a blank from a form clears the
    // field and lands as null, the same as an explicit null.
    if (patch.assignee !== undefined) patch = { ...patch, assignee: normalizeAssignee(patch.assignee) };
    return this.db.transaction(() => {
      const before = this.requireTask(id);
      if (patch.parentId && this.isAncestor(id, patch.parentId)) throw new ValidationError('a task cannot be nested under its own subtask');

      // Finishing a task is not a field write. It stamps completed_at, emits task.completed (which
      // is what rules trigger on and what the history shows) and spawns the next occurrence of a
      // recurring task. Writing status = 'done' straight into the column did none of that, so an
      // agent closing a weekly task through update_task ended the series silently. Route both
      // directions through the methods that own them, whatever path the patch arrived by.
      if (patch.status !== undefined && patch.status !== before.status) {
        const rest: TaskPatch & { status?: TaskStatus } = { ...patch };
        delete rest.status;
        if (patch.status === 'done') {
          if (Object.keys(rest).length) this.updateTask(id, rest, actor);
          return this.completeTask(id, actor).task;
        }
        if (before.status === 'done' && patch.status === 'open') {
          if (Object.keys(rest).length) this.updateTask(id, rest, actor);
          return this.reopenTask(id, actor);
        }
        // Any other move off 'done' (to dropped, waiting, in_progress) still has to clear the
        // completion stamp, or the task keeps showing in "completed in the last 24 hours".
        if (before.status === 'done') this.db.run('UPDATE tasks SET completed_at = NULL WHERE id = ?', [id]);
      }
      const cols: Record<string, [keyof Task, (v: never) => SqlValue]> = {
        title: ['title', (v: string) => v.trim()], notes: ['notes', (v: string) => v], projectId: ['projectId', (v) => v],
        sectionId: ['sectionId', (v) => v], parentId: ['parentId', (v) => v], status: ['status', (v) => v], priority: ['priority', (v) => v],
        dueAt: ['dueAt', (v) => v], startAt: ['startAt', (v) => v], estimateMinutes: ['estimateMinutes', (v) => v],
        recurrence: ['recurrence', (v) => v], assignee: ['assignee', (v) => v],
        isMilestone: ['isMilestone', (v: boolean) => (v ? 1 : 0)],
        sourceUrl: ['sourceUrl', (v) => v], confidence: ['confidence', (v) => v],
      };
      const colName: Record<string, string> = {
        title: 'title', notes: 'notes', projectId: 'project_id', sectionId: 'section_id', parentId: 'parent_id', status: 'status',
        priority: 'priority', dueAt: 'due_at', startAt: 'start_at', estimateMinutes: 'estimate_minutes', recurrence: 'recurrence',
        assignee: 'assignee', isMilestone: 'is_milestone', sourceUrl: 'source_url', confidence: 'confidence',
      };
      const sets: string[] = [];
      const params: SqlValue[] = [];
      const changes: Record<string, Json> = {};
      for (const [key, [field, conv]] of Object.entries(cols)) {
        const v = (patch as Record<string, unknown>)[key];
        if (v === undefined) continue;
        const next = conv(v as never);
        const prev = before[field] as unknown;
        const prevSql = typeof prev === 'boolean' ? (prev ? 1 : 0) : (prev as SqlValue);
        if (prevSql === next) continue;
        sets.push(`${colName[key]} = ?`);
        params.push(next);
        changes[key] = [prev as Json, v as Json];
      }
      if (patch.customFields !== undefined) {
        const merged: Record<string, CustomFieldValue> = { ...before.customFields };
        for (const [k, v] of Object.entries(patch.customFields)) {
          if (v === null) delete merged[k]; else merged[k] = v;
        }
        if (JSON.stringify(merged) !== JSON.stringify(before.customFields)) {
          sets.push('custom_fields = ?');
          params.push(JSON.stringify(merged));
          changes.customFields = [before.customFields, merged];
        }
      }
      if (patch.status !== undefined && patch.status !== before.status) {
        sets.push('completed_at = ?');
        params.push(patch.status === 'done' ? this.now() : null);
      }
      if (!sets.length) return before;
      // position is allocated per project+section, so carrying the old number into a new bucket
      // collides with whatever is already sitting there and interleaves the task at the top of
      // the list. moveTask recomputes it; this path has to as well.
      const bucketChanged = (patch.projectId !== undefined && patch.projectId !== before.projectId)
        || (patch.sectionId !== undefined && patch.sectionId !== before.sectionId);
      if (bucketChanged) {
        const nextProjectId = patch.projectId !== undefined ? patch.projectId ?? null : before.projectId;
        const nextSectionId = patch.sectionId !== undefined ? patch.sectionId ?? null : before.sectionId;
        sets.push('position = ?');
        params.push(this.nextPosition(nextProjectId, nextSectionId));
      }
      sets.push('updated_at = ?');
      params.push(this.now(), id);
      this.db.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, params);
      this.emit('task.updated', id, actor, { changes });
      return this.requireTask(id);
    });
  }

  private isAncestor(ancestorId: string, taskId: string): boolean {
    let cur: string | null = taskId;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      if (cur === ancestorId) return true;
      seen.add(cur);
      cur = this.db.get<{ parent_id: string | null }>('SELECT parent_id FROM tasks WHERE id = ?', [cur])?.parent_id ?? null;
    }
    return false;
  }

  /** Complete a task. If it recurs, the next instance is created and returned. */
  completeTask(id: string, actor: ActorInput = 'human'): { task: Task; next: Task | null } {
    return this.db.transaction(() => {
      const before = this.requireTask(id);
      if (before.status === 'done') return { task: before, next: null };
      const now = this.now();
      this.db.run(`UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?`, [now, now, id]);
      this.emit('task.completed', id, actor, { previousStatus: before.status });
      let next: Task | null = null;
      if (before.recurrence && this.nextOccurrence) {
        const from = before.dueAt ?? now.slice(0, 10);
        let nextDue: string | null = null;
        try {
          nextDue = this.nextOccurrence(before.recurrence, from);
        } catch (e) {
          // A bad rule must never make a task impossible to complete.
          this.addComment(id, `Completed, but no next occurrence was created: ${e instanceof Error ? e.message : String(e)}`, 'system');
        }
        if (nextDue) {
          next = this.createTask({
            title: before.title, notes: before.notes, projectId: before.projectId, sectionId: before.sectionId, parentId: before.parentId,
            priority: before.priority, dueAt: nextDue, estimateMinutes: before.estimateMinutes, recurrence: before.recurrence,
            assignee: before.assignee,
            // Shifted by the same amount as the due date, so a task that always starts three days
            // before it is due keeps doing that. Dropping it lost the only field a user can set on
            // a recurring task that never came back.
            startAt: shiftStartAt(before.startAt, before.dueAt, nextDue),
            isMilestone: before.isMilestone, customFields: before.customFields, status: 'open',
            untrustedText: before.untrustedText,
          }, actor);
          this.addComment(next.id, `Next occurrence of ${id}.`, 'system');
        }
      }
      return { task: this.requireTask(id), next };
    });
  }

  reopenTask(id: string, actor: ActorInput = 'human'): Task {
    return this.db.transaction(() => {
      const before = this.requireTask(id);
      if (before.status !== 'done' && before.status !== 'dropped') return before;
      this.db.run(`UPDATE tasks SET status = 'open', completed_at = NULL, updated_at = ? WHERE id = ?`, [this.now(), id]);
      this.emit('task.reopened', id, actor, { previousStatus: before.status });
      return this.requireTask(id);
    });
  }

  moveTask(id: string, to: { projectId?: string | null; sectionId?: string | null; parentId?: string | null; position?: number }, actor: ActorInput = 'human'): Task {
    return this.db.transaction(() => {
      const before = this.requireTask(id);
      let projectId = to.projectId !== undefined ? to.projectId : before.projectId;
      let sectionId = to.sectionId !== undefined ? to.sectionId : (to.projectId !== undefined && to.projectId !== before.projectId ? null : before.sectionId);
      if (sectionId) {
        const s = this.db.get<{ project_id: string }>('SELECT project_id FROM sections WHERE id = ?', [sectionId]);
        if (!s) throw new NotFoundError(`section ${sectionId} not found`);
        if (to.projectId === undefined) projectId = s.project_id;
        else if (s.project_id !== projectId) throw new ValidationError('section does not belong to target project');
      }
      if (projectId && !this.getProject(projectId)) throw new NotFoundError(`project ${projectId} not found`);
      const parentId = to.parentId !== undefined ? to.parentId : before.parentId;
      if (parentId && (parentId === id || this.isAncestor(id, parentId))) throw new ValidationError('a task cannot be nested under itself');
      if (parentId && !this.getTask(parentId)) throw new NotFoundError(`parent task ${parentId} not found`);
      const position = to.position ?? (projectId === before.projectId && sectionId === before.sectionId ? before.position : this.nextPosition(projectId, sectionId));
      if (projectId === before.projectId && sectionId === before.sectionId && parentId === before.parentId && position === before.position) return before;
      this.db.run('UPDATE tasks SET project_id = ?, section_id = ?, parent_id = ?, position = ?, updated_at = ? WHERE id = ?',
        [projectId, sectionId, parentId, position, this.now(), id]);
      this.emit('task.moved', id, actor, { from: { projectId: before.projectId, sectionId: before.sectionId, parentId: before.parentId }, to: { projectId, sectionId, parentId, position } });
      return this.requireTask(id);
    });
  }

  acceptInboxItem(id: string, patch: TaskPatch = {}, actor: ActorInput = 'human'): Task {
    return this.db.transaction(() => {
      const t = this.requireTask(id);
      if (t.status !== 'inbox') throw new ValidationError(`task ${id} is not in the inbox (status ${t.status})`);
      this.updateTask(id, { ...patch, status: 'open' }, actor);
      this.emit('task.accepted', id, actor, {});
      return this.requireTask(id);
    });
  }

  rejectInboxItem(id: string, reason: string | null = null, actor: ActorInput = 'human'): Task {
    return this.db.transaction(() => {
      const t = this.requireTask(id);
      if (t.status !== 'inbox') throw new ValidationError(`task ${id} is not in the inbox (status ${t.status})`);
      const now = this.now();
      this.db.run(`UPDATE tasks SET status = 'dropped', updated_at = ? WHERE id = ?`, [now, id]);
      if (t.sourceType && t.sourceId) {
        this.db.run(`UPDATE source_items SET state = 'rejected' WHERE source_type = ? AND source_id = ?`, [t.sourceType, t.sourceId]);
      }
      const { actor: who } = normalizeActorInput(actor);
      if (reason) this.addComment(id, `Rejected: ${reason}`, who === 'agent' ? 'agent' : 'human', actor);
      this.emit('task.rejected', id, actor, { reason });
      return this.requireTask(id);
    });
  }

  searchTasks(filter: TaskFilter = {}): Task[] {
    const { where, params } = this.buildWhere(filter);
    const order = {
      due: `CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END, t.due_at, ${PRIORITY_RANK}`,
      priority: `${PRIORITY_RANK}, CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END, t.due_at`,
      updated: 't.updated_at DESC',
      created: 't.created_at DESC',
      position: 't.position',
    }[filter.orderBy ?? 'due'];
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000);
    return this.db.all<Row>(`SELECT t.* FROM tasks t ${where} ORDER BY ${order}, t.id LIMIT ? OFFSET ?`,
      [...params, limit, filter.offset ?? 0]).map(rowToTask);
  }

  /**
   * Every task matching the filter, paged past the per-query ceiling. searchTasks clamps limit to
   * 1000, so a caller that has to see all of them -- the exporters, which write generated files --
   * would otherwise drop rows silently once a project grew past that.
   */
  searchAllTasks(filter: TaskFilter = {}): Task[] {
    const pageSize = 1000;
    const out: Task[] = [];
    for (let offset = filter.offset ?? 0; ; offset += pageSize) {
      const page = this.searchTasks({ ...filter, limit: pageSize, offset });
      out.push(...page);
      if (page.length < pageSize) return out;
    }
  }

  countTasks(filter: TaskFilter = {}): number {
    const { where, params } = this.buildWhere(filter);
    return this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks t ${where}`, params)?.n ?? 0;
  }

  private buildWhere(f: TaskFilter): { where: string; params: SqlValue[] } {
    const c: string[] = [];
    const p: SqlValue[] = [];
    const inList = (col: string, vals: readonly string[]) => {
      c.push(`${col} IN (${vals.map(() => '?').join(', ')})`);
      p.push(...vals);
    };
    if (f.text) {
      c.push(`(t.title LIKE ? ESCAPE '\\' OR t.notes LIKE ? ESCAPE '\\')`);
      const like = `%${f.text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      p.push(like, like);
    }
    if (f.status?.length) inList('t.status', f.status);
    if (f.priority?.length) inList('t.priority', f.priority);
    if (f.sourceType?.length) inList('t.source_type', f.sourceType);
    if (f.projectId) { c.push('t.project_id = ?'); p.push(f.projectId); }
    if (f.sectionId) { c.push('t.section_id = ?'); p.push(f.sectionId); }
    if (f.parentId !== undefined) {
      if (f.parentId === null) c.push('t.parent_id IS NULL'); else { c.push('t.parent_id = ?'); p.push(f.parentId); }
    }
    if (f.dueBefore) { c.push('t.due_at IS NOT NULL AND t.due_at < ?'); p.push(f.dueBefore); }
    if (f.dueAfter) { c.push('t.due_at IS NOT NULL AND t.due_at >= ?'); p.push(f.dueAfter); }
    if (f.hasDue !== undefined) c.push(f.hasDue ? 't.due_at IS NOT NULL' : 't.due_at IS NULL');
    if (f.completedAfter) { c.push('t.completed_at IS NOT NULL AND t.completed_at >= ?'); p.push(f.completedAfter); }
    if (f.completedBefore) { c.push('t.completed_at IS NOT NULL AND t.completed_at < ?'); p.push(f.completedBefore); }
    if (f.updatedBefore) { c.push('t.updated_at < ?'); p.push(f.updatedBefore); }
    if (f.isMilestone !== undefined) { c.push('t.is_milestone = ?'); p.push(f.isMilestone ? 1 : 0); }
    if (f.assignee !== undefined) { c.push('t.assignee = ?'); p.push(f.assignee); }
    if (f.unassigned !== undefined) c.push(f.unassigned ? 't.assignee IS NULL' : 't.assignee IS NOT NULL');
    if (f.blocked !== undefined) {
      c.push(`${f.blocked ? '' : 'NOT '}EXISTS (SELECT 1 FROM dependencies d JOIN tasks b ON b.id = d.blocker_id
        WHERE d.blocked_id = t.id AND b.status NOT IN ('done', 'dropped'))`);
    }
    if (f.startBefore) { c.push('(t.start_at IS NULL OR t.start_at < ?)'); p.push(f.startBefore); }
    if (f.parentClosed !== undefined) {
      // A top-level task has no parent row, so it passes parentClosed: false and fails parentClosed: true.
      c.push(`${f.parentClosed ? '' : 'NOT '}EXISTS (SELECT 1 FROM tasks parent
        WHERE parent.id = t.parent_id AND parent.status IN ('done', 'dropped'))`);
    }
    if (f.customField) {
      c.push(`json_extract(t.custom_fields, ?) IS ?`);
      p.push(`$."${f.customField.key.replace(/"/g, '')}"`, typeof f.customField.value === 'boolean' ? (f.customField.value ? 1 : 0) : f.customField.value);
    }
    return { where: c.length ? `WHERE ${c.join(' AND ')}` : '', params: p };
  }

  subtasks(id: string): Task[] {
    return this.db.all<Row>('SELECT * FROM tasks WHERE parent_id = ? ORDER BY position, created_at', [id]).map(rowToTask);
  }

  // ---------------------------------------------------------- dependencies

  addDependency(blockerId: string, blockedId: string, actor: ActorInput = 'human'): void {
    this.requireTask(blockerId);
    this.requireTask(blockedId);
    if (blockerId === blockedId) throw new ValidationError('a task cannot block itself');
    // Cycle if blocked already (transitively) blocks blocker.
    const stack = [blockerId];
    const seen = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === blockedId) throw new ValidationError('dependency would create a cycle');
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const r of this.db.all<{ blocker_id: string }>('SELECT blocker_id FROM dependencies WHERE blocked_id = ?', [cur])) stack.push(r.blocker_id);
    }
    this.db.run('INSERT OR IGNORE INTO dependencies (blocker_id, blocked_id) VALUES (?, ?)', [blockerId, blockedId]);
    this.emit('task.updated', blockedId, actor, { changes: { blockedBy: [null, blockerId] } });
  }

  removeDependency(blockerId: string, blockedId: string, actor: ActorInput = 'human'): void {
    const { changes } = this.db.run('DELETE FROM dependencies WHERE blocker_id = ? AND blocked_id = ?', [blockerId, blockedId]);
    if (changes) this.emit('task.updated', blockedId, actor, { changes: { blockedBy: [blockerId, null] } });
  }

  blockersOf(id: string): Task[] {
    return this.db.all<Row>('SELECT t.* FROM tasks t JOIN dependencies d ON d.blocker_id = t.id WHERE d.blocked_id = ?', [id]).map(rowToTask);
  }

  blocking(id: string): Task[] {
    return this.db.all<Row>('SELECT t.* FROM tasks t JOIN dependencies d ON d.blocked_id = t.id WHERE d.blocker_id = ?', [id]).map(rowToTask);
  }

  // ------------------------------------------------------ comments & links

  /**
   * `actor` is who caused the event (defaults to author). Rules pass author 'system' and actor
   * 'rule' so the loop guard sees them. The self-declared name on `actor` is stored as the
   * comment's author_name only when it actually names this comment's author (author === the
   * normalized actor): a name riding on an actor used only to log a system-generated comment
   * (markSourceGone, the recurrence note) must not be attached to that system message.
   */
  addComment(taskId: string, body: string, author: Comment['author'] = 'human', actor: ActorInput = author): Comment {
    this.requireTask(taskId);
    if (!body.trim()) throw new ValidationError('comment body must not be empty');
    const { actor: who, name } = normalizeActorInput(actor);
    const authorName = who === author ? name : null;
    const c: Comment = { id: newId('c'), taskId, author, authorName, body, createdAt: this.now() };
    this.db.run('INSERT INTO comments (id, task_id, author, author_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [c.id, taskId, author, authorName, body, c.createdAt]);
    this.emit('comment.added', taskId, actor, { commentId: c.id });
    return c;
  }

  /** Events of one kind after an ISO instant, newest last. Filters in SQL so large event tables stay correct. */
  eventsOfKind(kind: EventKind, afterAt: string | null, limit = 500): CcEvent[] {
    // DESC in SQL, then reversed: when the window truncates, the caller must keep the NEWEST
    // events, not the oldest. Callers like listNotifications want a deep history, so the ceiling
    // here is higher than the one on searchTasks.
    const rows = this.db.all<Row>('SELECT * FROM events WHERE kind = ? AND (? IS NULL OR at > ?) ORDER BY id DESC LIMIT ?',
      [kind, afterAt, afterAt, clampLimit(limit, 10_000)]);
    return rows.reverse().map((r) => ({
      id: r.id as number, at: r.at as string, kind: r.kind as EventKind, taskId: r.task_id as string | null,
      actor: r.actor as Actor, actorName: (r.actor_name as string | null) ?? null, payload: parseJson(r.payload, {}),
    }));
  }

  listComments(taskId: string): Comment[] {
    return this.db.all<Row>('SELECT * FROM comments WHERE task_id = ? ORDER BY created_at, id', [taskId]).map((r) => ({
      id: r.id as string, taskId: r.task_id as string, author: r.author as Comment['author'],
      authorName: (r.author_name as string | null) ?? null, body: r.body as string, createdAt: r.created_at as string,
    }));
  }

  addLink(taskId: string, url: string, title: string | null = null, kind: string | null = null): Link {
    this.requireTask(taskId);
    const l: Link = { id: newId('l'), taskId, url, title, kind, createdAt: this.now() };
    this.db.run('INSERT INTO links (id, task_id, url, title, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)', [l.id, taskId, url, title, kind, l.createdAt]);
    return l;
  }

  listLinks(taskId: string): Link[] {
    return this.db.all<Row>('SELECT * FROM links WHERE task_id = ? ORDER BY created_at, id', [taskId]).map((r) => ({
      id: r.id as string, taskId: r.task_id as string, url: r.url as string, title: r.title as string | null, kind: r.kind as string | null, createdAt: r.created_at as string,
    }));
  }

  // ------------------------------------------------------------- ingestion

  /**
   * Idempotent ingest of one source item. Unchanged content is a no-op. Changed content updates the task with a
   * three-way merge: a field is overwritten only if the user has not edited it since the last ingest.
   * Items the user rejected are never resurrected.
   */
  upsertFromSource(item: SourceItem, actor: ActorInput = 'system'): UpsertResult {
    // Propose, do not act: third-party text may only ever arrive as an inbox suggestion. This is
    // enforced here, not left to each ingest module, so a new source cannot skip the inbox by mistake.
    if (EXTERNAL_SOURCE_TYPES.includes(item.sourceType) && item.initialStatus !== undefined && item.initialStatus !== 'inbox') {
      throw new ValidationError(`${item.sourceType} items must start in the inbox, not as '${item.initialStatus}'`);
    }
    return this.db.transaction(() => {
      const now = this.now();
      const snapshot = {
        title: item.title.trim(), notes: item.notes ?? '', dueAt: item.dueAt ?? null, priority: item.priority ?? 'none',
        // The source's own done/not-done state, so the next import has the third input it needs
        // to merge completion rather than just overwrite it.
        sourceCompleted: item.sourceCompleted ?? null,
      };
      const si = this.db.get<Row>('SELECT * FROM source_items WHERE source_type = ? AND source_id = ?', [item.sourceType, item.sourceId]);
      const existing = this.getTaskBySource(item.sourceType, item.sourceId);
      const priorSnapshot = parseJson<Record<string, Json>>(si?.snapshot ?? null, {});
      // Never seen before, or the source flipped its own tick since we last looked. Either way the
      // source is speaking; an unchanged tick is the source staying silent, not agreeing.
      const sourceTickChanged = si == null
        || priorSnapshot.sourceCompleted === undefined
        || priorSnapshot.sourceCompleted !== (item.sourceCompleted ?? null);

      if (!existing) {
        const task = this.createTask({
          title: item.title, notes: item.notes, projectId: item.projectId ?? null, status: item.initialStatus ?? 'inbox',
          priority: item.priority, dueAt: item.dueAt ?? null, sourceType: item.sourceType, sourceId: item.sourceId,
          sourceUrl: item.sourceUrl ?? null, confidence: item.confidence ?? null, customFields: item.customFields,
        }, actor);
        this.db.run(
          `INSERT INTO source_items (source_type, source_id, task_id, content_hash, state, snapshot, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
           ON CONFLICT (source_type, source_id) DO UPDATE SET task_id = excluded.task_id, content_hash = excluded.content_hash,
             state = 'active', snapshot = excluded.snapshot, last_seen_at = excluded.last_seen_at`,
          [item.sourceType, item.sourceId, task.id, item.contentHash, JSON.stringify(snapshot), now, now]);
        return { action: 'created', task, sourceTickChanged };
      }

      const state = (si?.state as string | undefined) ?? 'active';
      if (state === 'rejected') {
        this.db.run('UPDATE source_items SET last_seen_at = ? WHERE source_type = ? AND source_id = ?', [now, item.sourceType, item.sourceId]);
        return { action: 'suppressed', task: existing, sourceTickChanged };
      }
      if (si && si.content_hash === item.contentHash && state === 'active') {
        this.db.run('UPDATE source_items SET last_seen_at = ? WHERE source_type = ? AND source_id = ?', [now, item.sourceType, item.sourceId]);
        return { action: 'unchanged', task: existing, sourceTickChanged };
      }

      const prev = priorSnapshot;
      const patch: TaskPatch & { status?: TaskStatus } = {};
      const isInbox = existing.status === 'inbox';
      // No prior snapshot means this task has never been merged against its source: the row was
      // adopted, or created with a sourceType by a REST or MCP caller. There is nothing to have
      // edited since, so take the source's values rather than treating every field as user-edited.
      // Without this the per-field default for title (null) could never equal a real title, so the
      // title was frozen for the life of the task while notes and priority still updated.
      const firstMerge = si == null || prev.title === undefined;
      for (const f of MERGE_FIELDS) {
        // Three-way merge for every status, inbox included: a field the user edited is never overwritten.
        const userUntouched = firstMerge
          || (existing[f] as Json) === (prev[f] ?? (f === 'notes' ? '' : f === 'priority' ? 'none' : null));
        if (userUntouched && (existing[f] as Json) !== snapshot[f]) (patch as Record<string, unknown>)[f] = snapshot[f];
      }
      if (item.sourceUrl !== undefined && item.sourceUrl !== existing.sourceUrl) patch.sourceUrl = item.sourceUrl;
      if (isInbox && item.confidence !== undefined) patch.confidence = item.confidence;
      if (isInbox && item.projectId !== undefined && item.projectId !== existing.projectId) patch.projectId = item.projectId;
      // Revive only what this system closed. gone_resolution is NULL when markSourceGone left the
      // task alone ('keep', or a resolution that did not apply), which is exactly the case where
      // the closing was the human's decision: reopening it would undo finished work every time the
      // source rotated back into view.
      const closedByUs = (si?.gone_resolution as string | null | undefined) != null;
      if (state === 'gone' && closedByUs && (existing.status === 'done' || existing.status === 'dropped')) {
        patch.status = item.initialStatus ?? 'inbox';
      }
      if (Object.keys(patch).length) this.updateTask(existing.id, patch, actor);
      this.db.run(
        `UPDATE source_items SET content_hash = ?, state = 'active', gone_resolution = NULL, snapshot = ?, last_seen_at = ?, task_id = ? WHERE source_type = ? AND source_id = ?`,
        [item.contentHash, JSON.stringify(snapshot), now, existing.id, item.sourceType, item.sourceId]);
      if (!si) {
        this.db.run(`INSERT INTO source_items (source_type, source_id, task_id, content_hash, state, snapshot, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
          [item.sourceType, item.sourceId, existing.id, item.contentHash, JSON.stringify(snapshot), now, now]);
      }
      this.emit('task.source_changed', existing.id, actor, { source: `${item.sourceType}:${item.sourceId}`, applied: Object.keys(patch) });
      return { action: 'updated', task: this.requireTask(existing.id), sourceTickChanged };
    });
  }

  /**
   * Claim an existing task as the origin of a source item, when the task has no source of its own.
   *
   * The Next Steps exporter writes hand-created tasks into PROJECT_STATUS.md, so the next import
   * meets a line describing a task that already exists. Without this it would create a second one,
   * and every cycle would add another. Adoption hands that task to the file instead: from here it
   * round-trips like any other line.
   *
   * Refuses, returning false, if the task already has a source or if the source id is taken, so a
   * mistaken call can never re-point an ingested task at a different source item.
   */
  adoptSource(
    sourceType: SourceType, sourceId: string, contentHash: string, taskId: string,
    snapshot: Record<string, Json>, actor: ActorInput = 'system',
  ): boolean {
    return this.db.transaction(() => {
      const task = this.requireTask(taskId);
      if (task.sourceType != null || task.sourceId != null) return false;
      if (this.getTaskBySource(sourceType, sourceId)) return false;
      const taken = this.db.get<Row>('SELECT 1 FROM source_items WHERE source_type = ? AND source_id = ?', [sourceType, sourceId]);
      if (taken) return false;

      const now = this.now();
      this.db.run('UPDATE tasks SET source_type = ?, source_id = ?, updated_at = ? WHERE id = ?',
        [sourceType, sourceId, now, taskId]);
      this.db.run(
        `INSERT INTO source_items (source_type, source_id, task_id, content_hash, state, snapshot, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
        [sourceType, sourceId, taskId, contentHash, JSON.stringify(snapshot), now, now]);
      this.emit('task.source_changed', taskId, actor, { source: `${sourceType}:${sourceId}`, adopted: true });
      return true;
    });
  }

  /**
   * The source item no longer exists or is resolved (checkbox ticked, PR merged, email archived).
   * 'complete' marks the task done, unless it is still an untriaged inbox suggestion, which is
   * left in the inbox with a comment: the owner never accepted it, so it was never work the owner did.
   * 'drop' drops it only if it is still in the inbox; an accepted task is kept with a comment.
   * 'drop_open' also drops open tasks and is only for owner-authored sources (TODO.md, PROJECT_STATUS.md, initiatives).
   * 'keep' only records the fact.
   *
   * Whatever it actually did to the task is stored on the source row as gone_resolution, which is
   * what upsertFromSource consults before reviving anything. NULL means this system left the task
   * alone, so a later reappearance must not reopen it.
   */
  markSourceGone(sourceType: SourceType, sourceId: string, resolution: 'complete' | 'drop' | 'drop_open' | 'keep', actor: ActorInput = 'system'): Task | undefined {
    return this.db.transaction(() => {
      const si = this.db.get<Row>('SELECT * FROM source_items WHERE source_type = ? AND source_id = ?', [sourceType, sourceId]);
      if (!si || si.state !== 'active') return si?.task_id ? this.getTask(si.task_id as string) : undefined;
      this.db.run(`UPDATE source_items SET state = 'gone', last_seen_at = ? WHERE source_type = ? AND source_id = ?`, [this.now(), sourceType, sourceId]);
      const task = this.getTaskBySource(sourceType, sourceId);
      if (!task) return undefined;
      this.emit('task.source_gone', task.id, actor, { source: `${sourceType}:${sourceId}`, resolution });
      const applied = (what: 'complete' | 'drop'): void => {
        this.db.run('UPDATE source_items SET gone_resolution = ? WHERE source_type = ? AND source_id = ?', [what, sourceType, sourceId]);
      };
      if (resolution === 'complete' && task.status !== 'done' && task.status !== 'dropped') {
        // An untriaged suggestion was never accepted, so completing it would record work the owner
        // never did: it would appear in the digest's "Completed" section and count toward any goal
        // the task is linked to. Leave it in the inbox for the owner to decide, with the fact recorded.
        // The owner's call, 2026-09-19; see initiatives/agentic-command-center.md.
        if (task.status === 'inbox') {
          this.addComment(
            task.id,
            `The ${sourceType} item this task came from was closed or resolved upstream. Left here to triage, because you have not accepted it.`,
            'system', actor);
          return task;
        }
        applied('complete');
        return this.completeTask(task.id, actor).task;
      }
      if (resolution === 'drop_open' && (task.status === 'inbox' || task.status === 'open')) {
        applied('drop');
        return this.updateTask(task.id, { status: 'dropped' }, actor);
      }
      if (resolution === 'drop') {
        if (task.status === 'inbox') { applied('drop'); return this.updateTask(task.id, { status: 'dropped' }, actor); }
        if (task.status !== 'done' && task.status !== 'dropped') {
          this.addComment(task.id, `The ${sourceType} item this task came from is gone. The task was kept because you accepted it.`, 'system', actor);
        }
      }
      return task;
    });
  }

  /** Current tracking state of a source item, or undefined if it has never been ingested or seen. */
  getSourceState(sourceType: SourceType, sourceId: string): { contentHash: string; state: 'active' | 'gone' | 'rejected'; taskId: string | null; lastSeenAt: string } | undefined {
    const r = this.db.get<Row>('SELECT * FROM source_items WHERE source_type = ? AND source_id = ?', [sourceType, sourceId]);
    return r ? { contentHash: r.content_hash as string, state: r.state as 'active' | 'gone' | 'rejected', taskId: r.task_id as string | null, lastSeenAt: r.last_seen_at as string } : undefined;
  }

  /**
   * Record that a source item was examined and produced no task (for example a GitHub item that is filtered out).
   * A later upsertFromSource for the same item still creates a task. Never touches an item that already has a task or was rejected.
   */
  markSourceSeen(sourceType: SourceType, sourceId: string, contentHash: string): void {
    const now = this.now();
    this.db.run(
      `INSERT INTO source_items (source_type, source_id, task_id, content_hash, state, snapshot, first_seen_at, last_seen_at)
       VALUES (?, ?, NULL, ?, 'active', '{}', ?, ?)
       ON CONFLICT (source_type, source_id) DO UPDATE SET content_hash = excluded.content_hash, state = 'active', last_seen_at = excluded.last_seen_at
       WHERE source_items.task_id IS NULL AND source_items.state <> 'rejected'`,
      [sourceType, sourceId, contentHash, now, now]);
  }

  /** Active source items of a type, for detecting items that disappeared since the last sync. */
  activeSourceIds(sourceType: SourceType, idPrefix = ''): string[] {
    return this.db.all<{ source_id: string }>(
      `SELECT source_id FROM source_items WHERE source_type = ? AND state = 'active' AND source_id LIKE ? ESCAPE '\\'`,
      [sourceType, `${idPrefix.replace(/[\\%_]/g, (m) => `\\${m}`)}%`]).map((r) => r.source_id);
  }

  getCursor(source: string): string | undefined {
    return this.db.get<{ cursor: string }>('SELECT cursor FROM sync_cursors WHERE source = ?', [source])?.cursor;
  }

  setCursor(source: string, cursor: string): void {
    this.db.run(`INSERT INTO sync_cursors (source, cursor, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (source) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`, [source, cursor, this.now()]);
  }

  // ---------------------------------------------------------- rules, views

  listRules(): Rule[] {
    return this.db.all<Row>('SELECT * FROM rules ORDER BY created_at').map((r) => ({
      id: r.id as string, name: r.name as string, enabled: bool(r.enabled), definition: parseJson(r.definition, {}),
      createdAt: r.created_at as string, updatedAt: r.updated_at as string,
    }));
  }

  getRule(id: string): Rule | undefined {
    return this.listRules().find((r) => r.id === id || r.name === id);
  }

  saveRule(input: { id?: string; name: string; enabled?: boolean; definition: Record<string, Json> }): Rule {
    const now = this.now();
    const existing = input.id ? this.getRule(input.id) : undefined;
    if (existing) {
      this.db.run('UPDATE rules SET name = ?, enabled = ?, definition = ?, updated_at = ? WHERE id = ?',
        [input.name, input.enabled === false ? 0 : 1, JSON.stringify(input.definition), now, existing.id]);
      return this.getRule(existing.id)!;
    }
    const id = input.id ?? newId('r');
    this.db.run('INSERT INTO rules (id, name, enabled, definition, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, input.name, input.enabled === false ? 0 : 1, JSON.stringify(input.definition), now, now]);
    return this.getRule(id)!;
  }

  deleteRule(id: string): boolean {
    return this.db.run('DELETE FROM rules WHERE id = ?', [id]).changes > 0;
  }

  listViews(): SavedView[] {
    return this.db.all<Row>('SELECT * FROM views ORDER BY name').map((r) => ({
      id: r.id as string, name: r.name as string, filter: parseJson(r.filter, {}), createdAt: r.created_at as string,
    }));
  }

  saveView(name: string, filter: TaskFilter): SavedView {
    this.db.run(`INSERT INTO views (id, name, filter, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (name) DO UPDATE SET filter = excluded.filter`, [newId('v'), name, JSON.stringify(filter), this.now()]);
    return this.listViews().find((v) => v.name === name)!;
  }

  deleteView(nameOrId: string): boolean {
    return this.db.run('DELETE FROM views WHERE name = ? OR id = ?', [nameOrId, nameOrId]).changes > 0;
  }

  // ----------------------------------------------------------------- goals
  // A goal's status is always set by hand. Its progress is typed in ('manual') or counted from
  // linked work ('tasks'). Nothing here changes a task, and rules have no goal actions.

  getGoal(id: string): Goal | undefined {
    const r = this.db.get<Row>('SELECT * FROM goals WHERE id = ?', [id]);
    return r ? rowToGoal(r) : undefined;
  }

  private requireGoal(id: string): Goal {
    const goal = this.getGoal(id);
    if (!goal) throw new NotFoundError(`goal not found: ${id}`);
    return goal;
  }

  /** Goals in display order. Achieved and dropped goals are left out unless includeClosed is set. */
  listGoals(opts: { includeClosed?: boolean } = {}): Goal[] {
    const goals = this.db.all<Row>('SELECT * FROM goals ORDER BY position, created_at').map(rowToGoal);
    return opts.includeClosed ? goals : goals.filter((g) => OPEN_GOAL_STATUSES.includes(g.status));
  }

  private validateGoalFields(input: GoalPatch, selfId: string | null): void {
    if (input.title !== undefined && !input.title.trim()) throw new ValidationError('goal title is required');
    if (input.status !== undefined && !GOAL_STATUSES.includes(input.status)) {
      throw new ValidationError(`invalid goal status: ${String(input.status)}`);
    }
    if (input.progressMode !== undefined && !GOAL_PROGRESS_MODES.includes(input.progressMode)) {
      throw new ValidationError(`invalid progress mode: ${String(input.progressMode)}`);
    }
    for (const key of ['startsOn', 'endsOn'] as const) {
      const v = input[key];
      if (v != null && !DATE_ONLY_RE.test(v)) throw new ValidationError(`${key} must be YYYY-MM-DD`);
    }
    for (const key of ['currentValue', 'targetValue'] as const) {
      const v = input[key];
      if (v != null && !Number.isFinite(v)) throw new ValidationError(`${key} must be a finite number`);
    }
    if (input.parentId != null) {
      if (input.parentId === selfId) throw new ValidationError('a goal cannot be its own parent');
      // Walk up from the proposed parent: meeting this goal on the way would make a cycle.
      const seen = new Set<string>();
      let cursor: string | null = input.parentId;
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        const ancestor: Goal | undefined = this.getGoal(cursor);
        if (!ancestor) throw new ValidationError(`parent goal not found: ${cursor}`);
        if (selfId && ancestor.id === selfId) throw new ValidationError('a goal cannot be moved under one of its own sub-goals');
        cursor = ancestor.parentId;
      }
    }
  }

  createGoal(input: NewGoal, actor: ActorInput = 'human'): Goal {
    if (typeof input.title !== 'string') throw new ValidationError('goal title is required');
    this.validateGoalFields(input, null);
    if (input.startsOn && input.endsOn && input.endsOn < input.startsOn) throw new ValidationError('endsOn is before startsOn');
    const now = this.now();
    const id = newId('g');
    const position = (this.db.get<{ p: number | null }>('SELECT MAX(position) AS p FROM goals')?.p ?? 0) + 1;
    this.db.run(
      `INSERT INTO goals (id, title, notes, parent_id, period_label, starts_on, ends_on, status, status_note,
        status_updated_at, progress_mode, current_value, target_value, unit, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.title.trim(), input.notes ?? '', input.parentId ?? null, input.periodLabel ?? null,
        input.startsOn ?? null, input.endsOn ?? null, input.status ?? 'on_track', input.statusNote ?? '', now,
        input.progressMode ?? 'tasks', input.currentValue ?? null, input.targetValue ?? null, input.unit ?? null,
        position, now, now],
    );
    this.emit('goal.created', null, actor, { goalId: id, title: input.title.trim() });
    return this.getGoal(id)!;
  }

  updateGoal(id: string, patch: GoalPatch, actor: ActorInput = 'human'): Goal {
    const before = this.requireGoal(id);
    this.validateGoalFields(patch, id);
    const next: Goal = {
      ...before,
      title: patch.title !== undefined ? patch.title.trim() : before.title,
      notes: patch.notes ?? before.notes,
      parentId: patch.parentId !== undefined ? patch.parentId : before.parentId,
      periodLabel: patch.periodLabel !== undefined ? patch.periodLabel : before.periodLabel,
      startsOn: patch.startsOn !== undefined ? patch.startsOn : before.startsOn,
      endsOn: patch.endsOn !== undefined ? patch.endsOn : before.endsOn,
      status: patch.status ?? before.status,
      statusNote: patch.statusNote ?? before.statusNote,
      progressMode: patch.progressMode ?? before.progressMode,
      currentValue: patch.currentValue !== undefined ? patch.currentValue : before.currentValue,
      targetValue: patch.targetValue !== undefined ? patch.targetValue : before.targetValue,
      unit: patch.unit !== undefined ? patch.unit : before.unit,
    };
    if (next.startsOn && next.endsOn && next.endsOn < next.startsOn) throw new ValidationError('endsOn is before startsOn');
    const now = this.now();
    const statusTouched = next.status !== before.status || next.statusNote !== before.statusNote;
    this.db.run(
      `UPDATE goals SET title = ?, notes = ?, parent_id = ?, period_label = ?, starts_on = ?, ends_on = ?, status = ?,
        status_note = ?, status_updated_at = ?, progress_mode = ?, current_value = ?, target_value = ?, unit = ?, updated_at = ?
       WHERE id = ?`,
      [next.title, next.notes, next.parentId, next.periodLabel, next.startsOn, next.endsOn, next.status, next.statusNote,
        statusTouched ? now : before.statusUpdatedAt, next.progressMode, next.currentValue, next.targetValue, next.unit, now, id],
    );
    const changed = (Object.keys(patch) as (keyof GoalPatch)[]).filter((k) => before[k] !== next[k]);
    this.emit('goal.updated', null, actor, { goalId: id, changed, ...(next.status !== before.status ? { status: next.status } : {}) });
    return this.getGoal(id)!;
  }

  /** Deletes a goal and its links. Sub-goals are kept and become top-level goals. */
  deleteGoal(id: string, actor: ActorInput = 'human'): boolean {
    const goal = this.getGoal(id);
    if (!goal) return false;
    this.db.run('DELETE FROM goals WHERE id = ?', [id]);
    this.emit('goal.deleted', null, actor, { goalId: id, title: goal.title });
    return true;
  }

  goalLinks(goalId: string): GoalLink[] {
    return this.db.all<Row>('SELECT * FROM goal_links WHERE goal_id = ? ORDER BY created_at, rowid', [goalId]).map(rowToGoalLink);
  }

  /** Links a goal to exactly one project or one task. Linking the same thing twice is a no-op. */
  linkGoal(goalId: string, target: { projectId?: string | null; taskId?: string | null }, actor: ActorInput = 'human'): GoalLink {
    this.requireGoal(goalId);
    const taskId = target.taskId ?? null;
    if ((target.projectId == null) === (taskId === null)) throw new ValidationError('link a goal to exactly one of projectId or taskId');
    let projectId: string | null = null;
    if (target.projectId != null) {
      const project = this.getProject(target.projectId);
      if (!project) throw new NotFoundError(`project not found: ${target.projectId}`);
      projectId = project.id;
    }
    if (taskId && !this.getTask(taskId)) throw new NotFoundError(`task not found: ${taskId}`);
    const same = (l: GoalLink): boolean => l.projectId === projectId && l.taskId === taskId;
    const existing = this.goalLinks(goalId).find(same);
    if (existing) return existing;
    this.db.run('INSERT INTO goal_links (goal_id, project_id, task_id, created_at) VALUES (?, ?, ?, ?)',
      [goalId, projectId, taskId, this.now()]);
    this.emit('goal.linked', taskId, actor, { goalId, ...(projectId ? { projectId } : {}) });
    return this.goalLinks(goalId).find(same)!;
  }

  unlinkGoal(goalId: string, target: { projectId?: string | null; taskId?: string | null }, actor: ActorInput = 'human'): boolean {
    const taskId = target.taskId ?? null;
    if ((target.projectId == null) === (taskId === null)) throw new ValidationError('unlink exactly one of projectId or taskId');
    const projectId = target.projectId != null ? (this.getProject(target.projectId)?.id ?? target.projectId) : null;
    const changes = projectId
      ? this.db.run('DELETE FROM goal_links WHERE goal_id = ? AND project_id = ?', [goalId, projectId]).changes
      : this.db.run('DELETE FROM goal_links WHERE goal_id = ? AND task_id = ?', [goalId, taskId]).changes;
    if (changes > 0) this.emit('goal.unlinked', taskId, actor, { goalId, ...(projectId ? { projectId } : {}) });
    return changes > 0;
  }

  /** The goals a task is linked to directly, open or closed, in the Goals view's order. */
  goalsLinkedToTask(taskId: string): Goal[] {
    return this.db.all<Row>(
      'SELECT g.* FROM goals g JOIN goal_links l ON l.goal_id = g.id WHERE l.task_id = ? ORDER BY g.position, g.created_at',
      [taskId],
    ).map(rowToGoal);
  }

  /** This goal and every goal beneath it. Safe against a cycle, should one ever be written by hand. */
  private goalTreeIds(goalId: string): string[] {
    const ids = [goalId];
    const seen = new Set(ids);
    for (let i = 0; i < ids.length; i++) {
      for (const r of this.db.all<{ id: string }>('SELECT id FROM goals WHERE parent_id = ?', [ids[i]])) {
        if (!seen.has(r.id)) { seen.add(r.id); ids.push(r.id); }
      }
    }
    return ids;
  }

  /** The project ids and task ids linked to a goal or to any of its sub-goals, open or closed.
   *  A task moves the goal when it is one of these tasks or sits in one of these projects. */
  goalLinkedWork(goalId: string): { projectIds: string[]; taskIds: string[] } {
    const tree = this.goalTreeIds(goalId);
    const rows = this.db.all<Row>(`SELECT project_id, task_id FROM goal_links WHERE goal_id IN (${placeholders(tree.length)})`, tree);
    const unique = (values: SqlValue[]): string[] => [...new Set(values.filter((v): v is string => typeof v === 'string'))];
    return { projectIds: unique(rows.map((r) => r.project_id)), taskIds: unique(rows.map((r) => r.task_id)) };
  }

  /** Ids of the active tasks that can move a goal: linked tasks plus every task in linked projects. */
  goalOpenTaskIds(goalId: string): string[] {
    this.requireGoal(goalId);
    const { projectIds, taskIds } = this.goalLinkedWork(goalId);
    const clauses: string[] = [];
    if (taskIds.length) clauses.push(`id IN (${placeholders(taskIds.length)})`);
    if (projectIds.length) clauses.push(`project_id IN (${placeholders(projectIds.length)})`);
    if (!clauses.length) return [];
    const sql = `SELECT id FROM tasks WHERE (${clauses.join(' OR ')}) AND status IN (${placeholders(ACTIVE_STATUSES.length)})`;
    return this.db.all<{ id: string }>(sql, [...taskIds, ...projectIds, ...ACTIVE_STATUSES]).map((r) => r.id);
  }

  goalProgress(goalId: string): GoalProgress {
    const goal = this.requireGoal(goalId);
    const openTasks = this.goalOpenTaskIds(goalId).length;
    if (goal.progressMode === 'manual') {
      const { currentValue, targetValue } = goal;
      const percent = currentValue != null && targetValue != null && targetValue > 0
        ? Math.max(0, Math.min(100, Math.round((currentValue / targetValue) * 100)))
        : null;
      return { mode: 'manual', done: null, total: null, percent, openTasks };
    }
    // Counted work: directly linked tasks, plus the milestone tasks of linked projects.
    // Inbox suggestions and dropped tasks never count.
    const { projectIds, taskIds } = this.goalLinkedWork(goalId);
    const clauses: string[] = [];
    if (taskIds.length) clauses.push(`id IN (${placeholders(taskIds.length)})`);
    if (projectIds.length) clauses.push(`(project_id IN (${placeholders(projectIds.length)}) AND is_milestone = 1)`);
    if (!clauses.length) return { mode: 'tasks', done: 0, total: 0, percent: null, openTasks };
    const rows = this.db.all<{ status: string }>(
      `SELECT status FROM tasks WHERE (${clauses.join(' OR ')}) AND status NOT IN ('inbox', 'dropped')`,
      [...taskIds, ...projectIds],
    );
    const total = rows.length;
    const done = rows.filter((r) => r.status === 'done').length;
    return { mode: 'tasks', done, total, percent: total > 0 ? Math.round((done / total) * 100) : null, openTasks };
  }

  goalDetail(goalId: string): GoalDetail {
    const goal = this.requireGoal(goalId);
    const childIds = this.db.all<{ id: string }>('SELECT id FROM goals WHERE parent_id = ? ORDER BY position, created_at', [goalId]).map((r) => r.id);
    return { ...goal, progress: this.goalProgress(goalId), links: this.goalLinks(goalId), childIds };
  }

  /** Every goal (open ones unless includeClosed) with its progress, for the Goals view and the digest. */
  listGoalDetails(opts: { includeClosed?: boolean } = {}): GoalDetail[] {
    return this.listGoals(opts).map((g) => this.goalDetail(g.id));
  }

  // --------------------------------------------------------------- threads
  // docs/agent-threads-proposal.md. A thread is the argument about one task; posts are typed,
  // short, and never change the task. The owner is the only party who decides what counts: a
  // verdict on a claim, a pinned state, closing, forking, and the thread's settings all require
  // the human actor here (ownerOnly), and MCP has no tool for any of them.

  // Propose, do not act: a suggestion waiting in the inbox is not yet the owner's work, so nothing
  // argues about it until they accept it. The same check guards a post, in case the task went back.
  /**
   * The thread for a task, made if there is none. Idempotent: a second call returns the existing
   * thread and records nothing, so two agents opening the same discussion do not race. The title
   * defaults to the task's own, which keeps a third-party title inside the thread row too; the
   * untrusted flag is read from the task when each post is made, not copied here.
   */
  createThread(taskId: string, title: string | null, actor: ActorInput): Thread {
    const task = this.requireTask(taskId);
    if (task.status === 'inbox') throw new ValidationError(INBOX_HAS_NO_THREAD);
    return this.db.transaction(() => {
      const existing = this.getThreadForTask(task.id);
      if (existing) return existing;
      const name = (title ?? '').replace(/\s+/g, ' ').trim() || task.title;
      const thread: Thread = {
        id: newId('th'), taskId: task.id, title: name, status: 'open', pinnedPostId: null, authorHidden: false, dailyCap: null, successorThreadId: null,
        createdAt: this.now(), closedAt: null,
      };
      this.db.run('INSERT INTO threads (id, task_id, title, status, pinned_post_id, created_at, closed_at) VALUES (?, ?, ?, ?, NULL, ?, NULL)',
        [thread.id, thread.taskId, thread.title, thread.status, thread.createdAt]);
      this.emit('thread.created', task.id, actor, { threadId: thread.id });
      return thread;
    });
  }

  getThread(threadId: string): Thread | null {
    const r = this.db.get<Row>('SELECT * FROM threads WHERE id = ?', [threadId]);
    return r ? rowToThread(r) : null;
  }

  requireThread(threadId: string): Thread {
    const thread = this.getThread(threadId);
    if (!thread) throw new NotFoundError(`thread not found: ${threadId}`);
    return thread;
  }

  getThreadForTask(taskId: string): Thread | null {
    const r = this.db.get<Row>('SELECT * FROM threads WHERE task_id = ?', [taskId]);
    return r ? rowToThread(r) : null;
  }

  /** Every thread, newest first, with the counts the thread list shows beside each. */
  listThreads(opts: { status?: Thread['status'] } = {}): ThreadSummary[] {
    const rows = this.db.all<Row>(
      `SELECT th.*, t.title AS task_title, t.untrusted_text AS task_untrusted, t.source_type AS task_source_type,
         (SELECT COUNT(*) FROM posts p WHERE p.thread_id = th.id) AS post_count,
         (SELECT COUNT(*) FROM posts p WHERE p.thread_id = th.id AND p.type = 'claim' AND p.status = 'open') AS open_claims,
         (SELECT COUNT(*) FROM posts p WHERE p.thread_id = th.id AND p.type = 'objection') AS objections,
         (SELECT COUNT(*) FROM posts p WHERE p.thread_id = th.id AND p.type = 'objection' AND NOT EXISTS (
            SELECT 1 FROM posts a WHERE a.thread_id = p.thread_id AND a.id <> p.id
              AND (a.created_at > p.created_at OR (a.created_at = p.created_at AND a.id > p.id))
              AND (a.parent_post_id = p.id OR EXISTS (SELECT 1 FROM json_each(a.refs) WHERE json_each.value = p.id))
         )) AS unanswered_objections,
         (SELECT COUNT(*) FROM posts p WHERE p.thread_id = th.id AND p.type = 'result') AS results,
         (SELECT COUNT(*) FROM posts p WHERE p.thread_id = th.id AND p.type = 'result' AND p.status = 'accepted') AS accepted_results,
         COALESCE((SELECT MAX(p.judged_at) FROM posts p WHERE p.thread_id = th.id), th.created_at) AS last_progress_at
       FROM threads th JOIN tasks t ON t.id = th.task_id
       WHERE (? IS NULL OR th.status = ?)
       ORDER BY th.created_at DESC, th.id DESC`,
      [opts.status ?? null, opts.status ?? null]);
    return rows.map((r) => ({
      thread: rowToThread(r), taskTitle: r.task_title as string,
      // The same stored-or-derived rule as rowToTask, so the list never shows a trusted title for a GitHub task.
      untrustedText: bool(r.task_untrusted) || (r.task_source_type != null && EXTERNAL_SOURCE_TYPES.includes(r.task_source_type as SourceType)),
      postCount: r.post_count as number,
      openClaims: r.open_claims as number, objections: r.objections as number, unansweredObjections: r.unanswered_objections as number,
      results: r.results as number, acceptedResults: r.accepted_results as number, lastProgressAt: r.last_progress_at as string,
    }));
  }

  /**
   * Posts across every thread, newest first: the library. A later thread cites an earlier
   * accepted result by id after finding it here. The query matches the body, case-insensitively.
   */
  searchPosts(opts: PostSearch = {}): PostSearchHit[] {
    if (opts.type !== undefined && !POST_TYPES.includes(opts.type)) throw new ValidationError(`invalid post type: ${String(opts.type)}`);
    if (opts.status !== undefined && !POST_STATUSES.includes(opts.status)) throw new ValidationError(`invalid post status: ${String(opts.status)}`);
    const query = opts.query?.trim() || null;
    const rows = this.db.all<Row>(
      `SELECT p.*, th.task_id AS hit_task_id, th.title AS thread_title, t.title AS task_title
       FROM posts p JOIN threads th ON th.id = p.thread_id JOIN tasks t ON t.id = th.task_id
       WHERE (? IS NULL OR p.type = ?) AND (? IS NULL OR p.status = ?) AND (? IS NULL OR th.task_id = ?)
         AND (? IS NULL OR instr(lower(p.body), lower(?)) > 0)
       ORDER BY p.created_at DESC, p.id DESC LIMIT ?`,
      [opts.type ?? null, opts.type ?? null, opts.status ?? null, opts.status ?? null, opts.taskId ?? null, opts.taskId ?? null,
        query, query, clampLimit(opts.limit ?? 50, 500)]);
    return rows.map((r) => ({
      post: rowToPost(r), taskId: r.hit_task_id as string, taskTitle: r.task_title as string, threadTitle: r.thread_title as string,
    }));
  }

  // Propose, do not act, from the other side: what counts is the owner's call and nobody else's.
  private ownerOnly(actor: ActorInput, what: string): void {
    if (normalizeActorInput(actor).actor !== 'human') throw new ValidationError(`only the owner can ${what}`);
  }

  /**
   * The owner's verdict on a claim or a result. Open again clears it. judged_at is when the last
   * verdict was given, which is what the thread list calls progress.
   */
  setPostStatus(postId: string, status: PostStatus, actor: ActorInput): Post {
    this.ownerOnly(actor, 'set a post status');
    if (!POST_STATUSES.includes(status)) throw new ValidationError(`invalid post status: ${String(status)}`);
    const post = this.getPost(postId);
    if (!post) throw new NotFoundError(`post not found: ${postId}`);
    if (!JUDGED_POST_TYPES.includes(post.type)) throw new ValidationError(`a ${post.type} post carries no status; only a claim or a result does`);
    const judgedAt = status === 'open' ? null : this.now();
    const thread = this.requireThread(post.threadId);
    this.db.transaction(() => {
      this.db.run('UPDATE posts SET status = ?, judged_at = ? WHERE id = ?', [status, judgedAt, post.id]);
      this.emit('post.status_changed', thread.taskId, actor, { threadId: thread.id, postId: post.id, status });
    });
    return { ...post, status, judgedAt };
  }

  /** The post shown first as the thread's current state, or null to unpin. */
  pinPost(threadId: string, postId: string | null, actor: ActorInput): Thread {
    this.ownerOnly(actor, 'pin a post');
    const thread = this.requireThread(threadId);
    if (postId !== null && !this.postInThread(postId, thread.id)) throw new ValidationError(`not a post of this thread: ${postId}`);
    this.db.transaction(() => {
      this.db.run('UPDATE threads SET pinned_post_id = ? WHERE id = ?', [postId, thread.id]);
      this.emit('thread.updated', thread.taskId, actor, { threadId: thread.id, field: 'pinnedPostId' });
    });
    return { ...thread, pinnedPostId: postId };
  }

  setThreadOptions(threadId: string, options: ThreadOptions, actor: ActorInput): Thread {
    this.ownerOnly(actor, 'change thread settings');
    const thread = this.requireThread(threadId);
    const next = { ...thread };
    const fields: string[] = [];
    if (options.authorHidden !== undefined) {
      if (typeof options.authorHidden !== 'boolean') throw new ValidationError('authorHidden must be true or false');
      next.authorHidden = options.authorHidden;
      fields.push('authorHidden');
    }
    if (options.dailyCap !== undefined) {
      if (options.dailyCap !== null && (!Number.isInteger(options.dailyCap) || options.dailyCap < 1)) throw new ValidationError('dailyCap must be a positive integer or null');
      next.dailyCap = options.dailyCap;
      fields.push('dailyCap');
    }
    if (!fields.length) throw new ValidationError('nothing to change');
    this.db.transaction(() => {
      this.db.run('UPDATE threads SET author_hidden = ?, daily_cap = ? WHERE id = ?', [next.authorHidden ? 1 : 0, next.dailyCap, thread.id]);
      for (const field of fields) this.emit('thread.updated', thread.taskId, actor, { threadId: thread.id, field });
    });
    return next;
  }

  closeThread(threadId: string, actor: ActorInput): Thread {
    this.ownerOnly(actor, 'close a thread');
    const thread = this.requireThread(threadId);
    if (thread.status === 'closed') throw new ValidationError('thread is already closed');
    const closedAt = this.now();
    this.db.transaction(() => {
      this.db.run("UPDATE threads SET status = 'closed', closed_at = ? WHERE id = ?", [closedAt, thread.id]);
      this.emit('thread.closed', thread.taskId, actor, { threadId: thread.id, successorThreadId: null });
    });
    return { ...thread, status: 'closed', closedAt };
  }

  /** Open again. A successor set by a fork stays recorded: the pointer is history, not state. */
  reopenThread(threadId: string, actor: ActorInput): Thread {
    this.ownerOnly(actor, 'reopen a thread');
    const thread = this.requireThread(threadId);
    if (thread.status === 'open') throw new ValidationError('thread is already open');
    this.db.transaction(() => {
      this.db.run("UPDATE threads SET status = 'open', closed_at = NULL WHERE id = ?", [thread.id]);
      this.emit('thread.reopened', thread.taskId, actor, { threadId: thread.id });
    });
    return { ...thread, status: 'open', closedAt: null };
  }

  /**
   * Two approaches that diverge get their own threads. A thread is one per task, so the fork is
   * a subtask of this thread's task, with a thread of its own; this thread closes and points at
   * it. The original task gains a subtask and nothing else.
   */
  forkThread(threadId: string, input: { title: string }, actor: ActorInput): { thread: Thread; successor: Thread; task: Task } {
    this.ownerOnly(actor, 'fork a thread');
    const thread = this.requireThread(threadId);
    if (thread.status === 'closed') throw new ValidationError('thread is closed; reopen it to fork it');
    const title = (input.title ?? '').replace(/\s+/g, ' ').trim();
    if (!title) throw new ValidationError('a fork needs a title');
    const parent = this.requireTask(thread.taskId);
    return this.db.transaction(() => {
      const task = this.createTask({ title, parentId: parent.id, projectId: parent.projectId, sectionId: parent.sectionId }, actor);
      const successor = this.createThread(task.id, title, actor);
      const closedAt = this.now();
      this.db.run("UPDATE threads SET status = 'closed', closed_at = ?, successor_thread_id = ? WHERE id = ?", [closedAt, successor.id, thread.id]);
      this.emit('thread.closed', thread.taskId, actor, { threadId: thread.id, successorThreadId: successor.id });
      return { thread: { ...thread, status: 'closed' as const, closedAt, successorThreadId: successor.id }, successor, task };
    });
  }

  /**
   * One post. The body must say something; refs and the parent must be posts of this thread, so
   * a post cannot point outside the argument it belongs to. untrusted_text comes from the task
   * at this moment and never clears. author_name follows addComment: kept only when the actor is
   * the author, so a name never lands on a post it did not write. Nothing here touches the task.
   */
  addPost(threadId: string, input: NewPost, author: Post['author'], actor: ActorInput): Post {
    const thread = this.requireThread(threadId);
    if (thread.status !== 'open') throw new ValidationError('thread is closed');
    if (!POST_TYPES.includes(input.type)) throw new ValidationError(`invalid post type: ${String(input.type)}`);
    if (typeof input.body !== 'string' || !input.body.trim()) throw new ValidationError('post body must not be empty');
    if (input.confidence != null && !CONFIDENCES.includes(input.confidence)) throw new ValidationError(`invalid confidence: ${String(input.confidence)}`);
    const refs = [...new Set(input.refs ?? [])];
    for (const ref of refs) {
      if (typeof ref !== 'string' || !this.postInThread(ref, thread.id)) throw new ValidationError(`ref is not a post of this thread: ${String(ref)}`);
    }
    const parentPostId = input.parentPostId ?? null;
    if (parentPostId !== null && !this.postInThread(parentPostId, thread.id)) throw new ValidationError(`parent is not a post of this thread: ${parentPostId}`);
    const task = this.requireTask(thread.taskId);
    if (task.status === 'inbox') throw new ValidationError(INBOX_HAS_NO_THREAD);
    const { actor: who, name } = normalizeActorInput(actor);
    const now = this.now();
    const post: Post = {
      id: newId('po'), threadId: thread.id, parentPostId, author, authorName: who === author ? name : null,
      type: input.type, body: input.body, confidence: input.confidence ?? null,
      status: JUDGED_POST_TYPES.includes(input.type) ? 'open' : null, refs, untrustedText: task.untrustedText, judgedAt: null, createdAt: now,
    };
    this.db.transaction(() => {
      // The cap is on agents, per name, per UTC day. The owner is never capped: it is their thread.
      if (author === 'agent' && thread.dailyCap !== null && this.postsTodayBy(thread.id, post.authorName, now) >= thread.dailyCap) {
        throw new ValidationError(`daily cap of ${thread.dailyCap} posts reached for ${post.authorName ?? 'an unnamed agent'} on this thread`);
      }
      this.db.run(
        `INSERT INTO posts (id, thread_id, parent_post_id, author, author_name, type, body, confidence, status, refs, untrusted_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [post.id, post.threadId, post.parentPostId, post.author, post.authorName, post.type, post.body, post.confidence, post.status,
          JSON.stringify(post.refs), post.untrustedText ? 1 : 0, post.createdAt]);
      this.emit('post.added', task.id, actor, { threadId: thread.id, postId: post.id, type: post.type });
    });
    return post;
  }

  /** How many posts the agent with this name (null for an unnamed one) made to the thread since 00:00 UTC of `at`'s day. */
  postsTodayBy(threadId: string, agentName: string | null, at: string = this.now()): number {
    const dayStart = `${at.slice(0, 10)}T00:00:00.000Z`;
    return this.db.get<Row>(
      `SELECT COUNT(*) AS n FROM posts WHERE thread_id = ? AND author = 'agent' AND author_name IS ? AND created_at >= ?`,
      [threadId, agentName, dayStart])!.n as number;
  }

  private postInThread(postId: string, threadId: string): boolean {
    return !!this.db.get<Row>('SELECT 1 AS one FROM posts WHERE id = ? AND thread_id = ?', [postId, threadId]);
  }

  /** How many posts a thread holds, for a reader that fetched a window of them. */
  countPosts(threadId: string): number {
    this.requireThread(threadId);
    return this.db.get<Row>('SELECT COUNT(*) AS n FROM posts WHERE thread_id = ?', [threadId])!.n as number;
  }

  getPost(postId: string): Post | null {
    const r = this.db.get<Row>('SELECT * FROM posts WHERE id = ?', [postId]);
    return r ? rowToPost(r) : null;
  }

  /**
   * A thread's posts, oldest first. `after` is a post id: only posts made after it are returned,
   * so a reader polling a long thread pays for the new posts only. An unknown `after` is a
   * NotFoundError rather than the whole thread, so a stale cursor is noticed.
   */
  listPosts(threadId: string, opts: { after?: string | null; limit?: number } = {}): Post[] {
    this.requireThread(threadId);
    const limit = clampLimit(opts.limit ?? 500, 5000);
    // Insertion order (rowid), not created_at: two posts made in the same millisecond would
    // otherwise sort by their random ids, and a cursor past the later id would skip the earlier.
    if (opts.after) {
      const cursor = this.db.get<Row>('SELECT rowid AS rid FROM posts WHERE id = ? AND thread_id = ?', [opts.after, threadId]);
      if (!cursor) throw new NotFoundError(`post not found in thread: ${opts.after}`);
      return this.db.all<Row>('SELECT * FROM posts WHERE thread_id = ? AND rowid > ? ORDER BY rowid LIMIT ?',
        [threadId, cursor.rid, limit]).map(rowToPost);
    }
    // No cursor: the newest window, so a reader of a long thread sees where it is now and
    // countPosts says how much came before.
    return this.db.all<Row>(
      'SELECT * FROM (SELECT rowid AS rid, * FROM posts WHERE thread_id = ? ORDER BY rowid DESC LIMIT ?) ORDER BY rid',
      [threadId, limit]).map(rowToPost);
  }

  // -------------------------------------------------------------------- kv

  getKv<T extends Json>(key: string): T | undefined {
    const r = this.db.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', [key]);
    return r ? (JSON.parse(r.value) as T) : undefined;
  }

  setKv(key: string, value: Json): void {
    this.db.run(`INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, [key, JSON.stringify(value), this.now()]);
  }

  // ---------------------------------------------------------------- backup

  /** Write a consistent, compacted copy of the whole database to `file`, which must not exist yet.
   *  Safe while the daemon is running: VACUUM INTO reads from one snapshot. */
  backupTo(file: string): void {
    this.db.run('VACUUM INTO ?', [file]);
  }

  /** What a good copy must match: see `inspectDatabaseFile`. */
  backupFingerprint(): { schemaVersion: number; counts: DatabaseCounts } {
    return {
      schemaVersion: this.db.get<{ version: number }>('SELECT version FROM schema_version')!.version,
      counts: countRows(this.db),
    };
  }
}

export { ACTIVE_STATUSES };

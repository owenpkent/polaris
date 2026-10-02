// Domain types for the Command Center task graph.
// Dates: due_at / start_at are 'YYYY-MM-DD' or full ISO datetimes. All other timestamps are ISO datetimes (UTC).

export type TaskStatus = 'inbox' | 'open' | 'in_progress' | 'waiting' | 'done' | 'dropped';
export const TASK_STATUSES: readonly TaskStatus[] = ['inbox', 'open', 'in_progress', 'waiting', 'done', 'dropped'];
export const ACTIVE_STATUSES: readonly TaskStatus[] = ['open', 'in_progress', 'waiting'];

export type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent';
export const PRIORITIES: readonly Priority[] = ['none', 'low', 'medium', 'high', 'urgent'];

export type CustomFieldValue = string | number | boolean | null;
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** Where an ingested task came from. source_type + source_id is unique across tasks. */
export const SOURCE_TYPES = ['todo_md', 'status_md', 'initiative_md', 'github', 'git_local', 'code_todo', 'gmail', 'gdrive', 'gcal', 'manual'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/**
 * Sources whose text is written by third parties. Two rules hang off this one list: a task from
 * one of these always starts in the inbox (the store enforces it), and its title and notes are
 * marked UNTRUSTED-TEXT wherever an assistant reads them.
 */
export const EXTERNAL_SOURCE_TYPES: readonly SourceType[] = ['github', 'gmail', 'gdrive', 'gcal'];

export interface Project {
  id: string;
  slug: string;
  name: string;
  category: string | null;
  type: string | null;
  description: string | null;
  status: string | null;
  path: string | null;
  github: string | null;
  todoFile: string | null;
  archived: boolean;
  /** Free-form extra data (e.g. parsed PROJECT_STATUS.md sections). */
  meta: Record<string, Json>;
  createdAt: string;
  updatedAt: string;
}

export interface Section {
  id: string;
  projectId: string;
  name: string;
  position: number;
}

export interface Task {
  id: string;
  projectId: string | null;
  sectionId: string | null;
  parentId: string | null;
  title: string;
  notes: string;
  status: TaskStatus;
  priority: Priority;
  dueAt: string | null;
  startAt: string | null;
  estimateMinutes: number | null;
  /** RFC 5545 RRULE string (without the "RRULE:" prefix), e.g. "FREQ=WEEKLY;BYDAY=MO". */
  recurrence: string | null;
  /** Who the task is handed to. null means unclaimed, which today means the owner. */
  assignee: string | null;
  isMilestone: boolean;
  position: number;
  sourceType: SourceType | null;
  sourceId: string | null;
  sourceUrl: string | null;
  /** Extractor confidence 0..1 for LLM-derived tasks, null otherwise. */
  confidence: number | null;
  /**
   * The title and notes were written by a third party, so an assistant must treat them as data.
   * Set from sourceType at ingest and inherited by anything derived from this task; never cleared,
   * because accepting a suggestion approves the task, not its wording.
   */
  untrustedText: boolean;
  customFields: Record<string, CustomFieldValue>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface Comment {
  id: string;
  taskId: string;
  author: 'human' | 'agent' | 'system';
  body: string;
  createdAt: string;
}

export interface Link {
  id: string;
  taskId: string;
  url: string;
  title: string | null;
  kind: string | null;
  createdAt: string;
}

export interface Dependency {
  blockerId: string;
  blockedId: string;
}

export type EventKind =
  | 'task.created'
  | 'task.updated'
  | 'task.completed'
  | 'task.reopened'
  | 'task.moved'
  | 'task.accepted'
  | 'task.rejected'
  | 'task.source_changed'
  | 'task.source_gone'
  | 'task.sync_conflict'
  | 'comment.added'
  | 'project.upserted'
  | 'rule.fired'
  | 'goal.created'
  | 'goal.updated'
  | 'goal.deleted'
  | 'goal.linked'
  | 'goal.unlinked';

/** One offline edit replayed through POST /api/outbox. See core/outbox.ts. */
export interface AppliedOp {
  opId: string;
  deviceId: string;
  taskId: string | null;
  /** When the edit was made on the device, clamped to the server clock. */
  editedAt: string;
  appliedAt: string;
  /** The events this op produced are those with firstEventId < id <= lastEventId. */
  firstEventId: number;
  lastEventId: number;
  result: Record<string, Json>;
}

export interface CcEvent {
  id: number;
  at: string;
  kind: EventKind;
  taskId: string | null;
  actor: 'human' | 'agent' | 'system' | 'rule';
  payload: Record<string, Json>;
}

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  /** Rule definition, interpreted by src/automation. Stored opaquely by core. */
  definition: Record<string, Json>;
  createdAt: string;
  updatedAt: string;
}

export type GoalStatus = 'on_track' | 'at_risk' | 'off_track' | 'achieved' | 'dropped';
export const GOAL_STATUSES: readonly GoalStatus[] = ['on_track', 'at_risk', 'off_track', 'achieved', 'dropped'];
/** Statuses of a goal that is still being worked toward. */
export const OPEN_GOAL_STATUSES: readonly GoalStatus[] = ['on_track', 'at_risk', 'off_track'];

/** 'tasks': progress is counted from linked work. 'manual': currentValue out of targetValue, typed in. */
export type GoalProgressMode = 'manual' | 'tasks';
export const GOAL_PROGRESS_MODES: readonly GoalProgressMode[] = ['manual', 'tasks'];

export interface Goal {
  id: string;
  title: string;
  notes: string;
  parentId: string | null;
  /** Free text such as "2026" or "2026 Q4". */
  periodLabel: string | null;
  startsOn: string | null;
  endsOn: string | null;
  /** Always set by a person or an agent acting for one; never computed. */
  status: GoalStatus;
  statusNote: string;
  /** When status or statusNote last changed. Drives the "no update in N days" digest check. */
  statusUpdatedAt: string | null;
  progressMode: GoalProgressMode;
  currentValue: number | null;
  targetValue: number | null;
  unit: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface NewGoal {
  title: string;
  notes?: string;
  parentId?: string | null;
  periodLabel?: string | null;
  startsOn?: string | null;
  endsOn?: string | null;
  status?: GoalStatus;
  statusNote?: string;
  progressMode?: GoalProgressMode;
  currentValue?: number | null;
  targetValue?: number | null;
  unit?: string | null;
}

export type GoalPatch = Partial<NewGoal>;

export interface GoalLink {
  goalId: string;
  projectId: string | null;
  taskId: string | null;
  createdAt: string;
}

/**
 * Progress of one goal, including the work linked to its sub-goals.
 * In 'tasks' mode done/total count the directly linked tasks plus the milestone tasks of linked
 * projects (inbox and dropped tasks never count). In 'manual' mode they are null.
 */
export interface GoalProgress {
  mode: GoalProgressMode;
  done: number | null;
  total: number | null;
  /** 0 to 100, or null when there is nothing to measure yet. */
  percent: number | null;
  /** Active tasks that can move this goal: linked tasks plus every task in linked projects. */
  openTasks: number;
}

export interface GoalDetail extends Goal {
  progress: GoalProgress;
  links: GoalLink[];
  childIds: string[];
}

export interface SavedView {
  id: string;
  name: string;
  filter: TaskFilter;
  createdAt: string;
}

export interface TaskFilter {
  text?: string;
  status?: TaskStatus[];
  projectId?: string;
  sectionId?: string;
  parentId?: string | null;
  priority?: Priority[];
  dueBefore?: string;
  dueAfter?: string;
  hasDue?: boolean;
  /** completed_at on or after this ISO instant or date. */
  completedAfter?: string;
  /** completed_at strictly before this ISO instant or date. */
  completedBefore?: string;
  /** updated_at strictly before this ISO instant or date. Filters in SQL, so a LIMIT keeps the
   *  stalest rows rather than whichever ones the ordering happened to put first. */
  updatedBefore?: string;
  sourceType?: SourceType[];
  isMilestone?: boolean;
  /** Only tasks with at least one incomplete blocker. */
  blocked?: boolean;
  /**
   * No start date, or start_at strictly before this date (YYYY-MM-DD or ISO instant). Unlike
   * dueBefore, a missing start passes: a task without a start date can be started any time.
   */
  startBefore?: string;
  /**
   * true: only subtasks whose parent is done or dropped. false: top-level tasks, and subtasks whose
   * parent is still live (any status but done or dropped).
   */
  parentClosed?: boolean;
  customField?: { key: string; value: CustomFieldValue };
  /** Exact match on the assignee name. */
  assignee?: string;
  /** Only tasks with no assignee (true) or with one (false). */
  unassigned?: boolean;
  orderBy?: 'due' | 'priority' | 'updated' | 'created' | 'position';
  limit?: number;
  offset?: number;
}

export interface NewTask {
  title: string;
  notes?: string;
  projectId?: string | null;
  sectionId?: string | null;
  parentId?: string | null;
  status?: TaskStatus;
  priority?: Priority;
  dueAt?: string | null;
  startAt?: string | null;
  estimateMinutes?: number | null;
  recurrence?: string | null;
  assignee?: string | null;
  isMilestone?: boolean;
  customFields?: Record<string, CustomFieldValue>;
  sourceType?: SourceType | null;
  sourceId?: string | null;
  sourceUrl?: string | null;
  confidence?: number | null;
  /**
   * Mark this task's text as third-party. Only ever raises the flag: an external sourceType sets it
   * regardless, and passing false on such a task does not clear it. Callers that derive a task from
   * an untrusted one (rules, recurrence) pass the parent's value through.
   */
  untrustedText?: boolean;
}

// untrustedText is left out on purpose: the marker is one-way, so no edit can take it off.
export type TaskPatch = Partial<Omit<NewTask, 'sourceType' | 'sourceId' | 'untrustedText'>>;

export interface NewProject {
  slug: string;
  name: string;
  category?: string | null;
  type?: string | null;
  description?: string | null;
  status?: string | null;
  path?: string | null;
  github?: string | null;
  todoFile?: string | null;
  archived?: boolean;
  meta?: Record<string, Json>;
}

/** The fields the owner (or an agent) can set by hand. `path`, `todoFile`, and `meta` belong to the importers. */
export interface ProjectPatch {
  name?: string;
  category?: string | null;
  type?: string | null;
  description?: string | null;
  status?: string | null;
  github?: string | null;
  archived?: boolean;
}

export interface ProjectInput extends ProjectPatch {
  name: string;
}

/** Input from an ingestion source. */
export interface SourceItem {
  sourceType: SourceType;
  sourceId: string;
  title: string;
  notes?: string;
  sourceUrl?: string | null;
  dueAt?: string | null;
  projectId?: string | null;
  priority?: Priority;
  confidence?: number | null;
  /** Hash of the source content the task was derived from. Unchanged hash = no-op. */
  contentHash: string;
  /** Status for newly created tasks. Defaults to 'inbox'. Only trusted, owner-authored sources should pass 'open'. */
  initialStatus?: TaskStatus;
  /**
   * Whether the source itself says this is finished: a ticked checkbox, for the checklist
   * importers. Recorded in the snapshot so the next import can tell "the file still says unticked
   * because nobody touched it" from "the file was just unticked", which is the difference between
   * leaving a completion alone and undoing it.
   */
  sourceCompleted?: boolean;
  customFields?: Record<string, CustomFieldValue>;
}

/**
 * `sourceTickChanged` is true when the source's own done/not-done state differs from what it was
 * at the last import, or when this is the first time the item has been seen. It is the third input
 * a caller needs to merge completion the way the field merge already works: without it, a caller
 * can only compare the source to the task and cannot tell a stale checkbox from a fresh one.
 */
export type UpsertResult =
  | { action: 'created'; task: Task; sourceTickChanged: boolean }
  | { action: 'updated'; task: Task; sourceTickChanged: boolean }
  | { action: 'unchanged'; task: Task; sourceTickChanged: boolean }
  | { action: 'suppressed'; task: Task; sourceTickChanged: boolean };

export type Actor = CcEvent['actor'];

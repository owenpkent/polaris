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
  /** The name an MCP connection self-declared for itself, when `author` was that connection. See ActorInput. */
  authorName: string | null;
  body: string;
  createdAt: string;
}

// ---- threads (docs/agent-threads-proposal.md) ----

/** One idea per post. The type is what the owner filters and counts by. */
export const POST_TYPES = ['claim', 'evidence', 'objection', 'question', 'failed_attempt', 'summary', 'result'] as const;
export type PostType = (typeof POST_TYPES)[number];
/** The owner's verdict on a claim or a result. Only those two types carry one; it starts open. */
export const POST_STATUSES = ['open', 'accepted', 'rejected', 'superseded'] as const;
export type PostStatus = (typeof POST_STATUSES)[number];
export const CONFIDENCES = ['low', 'medium', 'high'] as const;
export type Confidence = (typeof CONFIDENCES)[number];
/** The post types that carry a status. */
export const JUDGED_POST_TYPES: readonly PostType[] = ['claim', 'result'];

/** At most one per task: the discussion of the task that is the challenge. */
export interface Thread {
  id: string;
  taskId: string;
  title: string;
  status: 'open' | 'closed';
  /** The summary post the owner pinned as the current state, if any. */
  pinnedPostId: string | null;
  /** When set, an assistant reading the thread sees every author as "participant". The dashboard always shows names. */
  authorHidden: boolean;
  /** The most posts one agent may add per UTC day, or null for no cap. Never applies to the owner. */
  dailyCap: number | null;
  /** Set by a fork: the thread the argument continues in. The thread is closed when this is set. */
  successorThreadId: string | null;
  createdAt: string;
  closedAt: string | null;
}

/** The thread settings only the owner changes. */
export interface ThreadOptions {
  authorHidden?: boolean;
  dailyCap?: number | null;
}

export interface Post {
  id: string;
  threadId: string;
  parentPostId: string | null;
  author: 'human' | 'agent';
  /** The name an MCP connection self-declared for itself, when `author` was that connection. See ActorInput. */
  authorName: string | null;
  type: PostType;
  body: string;
  confidence: Confidence | null;
  /** Set on claim and result posts only, by the owner. Null on every other type. */
  status: PostStatus | null;
  /** Ids of posts in the same thread this one answers or builds on. */
  refs: string[];
  /** Copied from the task when the post was made, and never cleared. */
  untrustedText: boolean;
  /** When the owner last set the status; null while a claim or result is open, and on every other type. */
  judgedAt: string | null;
  createdAt: string;
}

export interface NewPost {
  type: PostType;
  body: string;
  confidence?: Confidence | null;
  refs?: string[];
  parentPostId?: string | null;
}

/** A thread with the counts the thread list shows. */
export interface ThreadSummary {
  thread: Thread;
  taskTitle: string;
  /** The task's flag: the thread title defaults to the task title, so a list line repeats third-party text. */
  untrustedText: boolean;
  postCount: number;
  openClaims: number;
  objections: number;
  /** Objections no later post answers (by parent or by refs). */
  unansweredObjections: number;
  results: number;
  acceptedResults: number;
  /** The last verdict the owner gave in this thread, or the thread's creation when there is none. */
  lastProgressAt: string;
}

/** A post found across threads, with where it lives. */
export interface PostSearchHit {
  post: Post;
  taskId: string;
  taskTitle: string;
  threadTitle: string;
  /** The task's flag: the thread title defaults to the task's, so both titles here are third-party text when set. */
  untrustedText: boolean;
}

export interface PostSearch {
  type?: PostType;
  status?: PostStatus;
  query?: string;
  taskId?: string;
  limit?: number;
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
  | 'thread.created'
  | 'thread.updated'
  | 'thread.closed'
  | 'thread.reopened'
  | 'post.added'
  | 'post.status_changed'
  | 'project.upserted'
  | 'rule.fired'
  | 'goal.created'
  | 'goal.updated'
  | 'goal.deleted'
  | 'goal.linked'
  | 'goal.unlinked';

// ---- update requests (docs/update-proposal.md, section 4C) ----

export const UPDATE_REQUEST_STATES = ['pending', 'picked_up', 'done', 'failed', 'cancelled', 'expired'] as const;
export type UpdateRequestState = typeof UPDATE_REQUEST_STATES[number];

/** A release version: MAJOR.MINOR.PATCH with nothing after the patch. Anything else is not a release. */
export const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/** A pending request the updater has not picked up within this long is expired by the daemon. */
export const UPDATE_REQUEST_TTL_MS = 60 * 60_000;

/**
 * The owner asking the scheduled updater to install one release. Written only by the daemon's
 * REST routes; requestedBy is always the human actor. Not an event and never a rule trigger.
 */
export interface UpdateRequest {
  id: string;
  version: string;
  requestedAt: string;
  requestedBy: Actor;
  state: UpdateRequestState;
  pickedUpAt: string | null;
  finishedAt: string | null;
  /** The updater's one-line outcome once done or failed, else null. */
  result: string | null;
}

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
  /** The name an MCP connection self-declared for itself, when it was the actor. See ActorInput. */
  actorName: string | null;
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

/**
 * What a Store write method accepts for "who did this": a plain Actor, or an actor paired with a
 * name the connection declared for itself (MCP's --agent-name / X-Agent-Name). The name is
 * self-declared by the connection and is never an identity or a permission: it labels who to
 * credit in an event's history line or a comment's byline, never who is allowed to act. The actor
 * enum itself stays exactly human, agent, system, rule.
 */
export type ActorInput = Actor | { actor: Actor; name: string | null };

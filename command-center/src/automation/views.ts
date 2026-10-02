// Built-in views plus the saved-view lookup. A "view" is, in principle, just a TaskFilter --
// but TaskFilter can only AND its conditions together, and two of the views below need an OR
// ("no due date, OR due date far out"). For those we run two focused queries and merge them in
// JS, and say so at the call site. See the phase 4 report for the core change (an OR-capable
// filter shape) that would let these collapse into single queries.
import { ACTIVE_STATUSES, NotFoundError, type Store, type Task, type TaskFilter } from '../core/index.ts';
import { addDays } from './dates.ts';

export interface ViewDefinition {
  name: string;
  description: string;
  filter: TaskFilter;
}

export interface ViewResult {
  view: ViewDefinition;
  tasks: Task[];
  /**
   * The blocked view only: each task's incomplete blockers (status not done or dropped), keyed by
   * task id, so a caller can say why a task is stuck. Blockers that are already done or dropped are
   * not listed, since they are not what holds the task.
   */
  blockers?: Record<string, Task[]>;
}

const ACTIVE = [...ACTIVE_STATUSES];

function compareByDue(a: Task, b: Task): number {
  const NO_DUE = '￿'; // sorts after any real due date string
  const ad = a.dueAt ?? NO_DUE;
  const bd = b.dueAt ?? NO_DUE;
  if (ad !== bd) return ad < bd ? -1 : 1;
  const rank: Record<Task['priority'], number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
  if (rank[a.priority] !== rank[b.priority]) return rank[a.priority] - rank[b.priority];
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function mergeUnique(...lists: Task[][]): Task[] {
  const seen = new Set<string>();
  const out: Task[] = [];
  for (const list of lists) {
    for (const t of list) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
  }
  return out.sort(compareByDue);
}

/**
 * Every built-in view says how many rows it wants. Left unset, searchTasks defaults to 100, so a
 * backlog past that was silently cut off -- and buildDigest publishes the length of what it got as
 * the section count, which turned a query artefact into a number the owner reads as their real backlog.
 * 1000 is searchTasks' hard ceiling, so this is as much as one query can return.
 */
const VIEW_LIMIT = 1000;

/**
 * Built-in views, computed for a given day. Names: today, upcoming, later, overdue, waiting, ready,
 * blocked, inbox, milestones, recently-completed.
 *
 * ready is "what could be started right now", from what the model records. A task is ready when all
 * of these hold:
 * - status is open (not inbox, which awaits triage; not waiting; not in_progress, which has
 *   started; not done or dropped);
 * - no incomplete blocker: every task that blocks it is done or dropped (the `blocked: false`
 *   filter, the same NOT EXISTS that search_tasks uses);
 * - it is not a subtask of a done or dropped parent (`parentClosed: false`);
 * - its start date, if it has one, is today or earlier (`startBefore: tomorrow`).
 * Ordered by priority, then due date with undated tasks last.
 *
 * blocked is the other half: open or in_progress tasks with at least one incomplete blocker,
 * ordered by due date. runView lists each task's blockers alongside.
 */
export function builtinViews(today: string): ViewDefinition[] {
  const tomorrow = addDays(today, 1);
  const weekOut = addDays(today, 8); // exclusive upper bound for "through today+7"
  return [
    {
      name: 'today',
      description: 'Open, in-progress, or waiting tasks (and subtasks) due today or earlier.',
      filter: { status: ACTIVE, dueBefore: tomorrow, orderBy: 'due', limit: VIEW_LIMIT },
    },
    {
      name: 'upcoming',
      description: 'Active tasks due in the next 7 days.',
      filter: { status: ACTIVE, dueAfter: tomorrow, dueBefore: weekOut, orderBy: 'due', limit: VIEW_LIMIT },
    },
    {
      name: 'later',
      // Approximate single-filter form (no due date OR due date far out cannot be a single
      // TaskFilter). runView special-cases this name; see the module comment.
      description: 'Active tasks with no due date, or due more than 7 days out.',
      filter: { status: ACTIVE, dueAfter: weekOut, orderBy: 'due', limit: VIEW_LIMIT },
    },
    {
      name: 'overdue',
      description: 'Active tasks due before today.',
      filter: { status: ACTIVE, dueBefore: today, orderBy: 'due', limit: VIEW_LIMIT },
    },
    {
      name: 'waiting',
      // Approximate single-filter form (status = waiting OR blocked cannot be a single
      // TaskFilter). runView special-cases this name; see the module comment.
      description: 'Tasks marked waiting, or blocked by an incomplete dependency.',
      filter: { status: ['waiting'], orderBy: 'due', limit: VIEW_LIMIT },
    },
    {
      name: 'ready',
      description: 'Open tasks that could be started now: no incomplete blocker, not under a done or dropped parent, and no start date later than today. Priority first, then due date.',
      filter: { status: ['open'], blocked: false, parentClosed: false, startBefore: tomorrow, orderBy: 'priority', limit: VIEW_LIMIT },
    },
    {
      name: 'blocked',
      description: 'Open or in-progress tasks held by at least one incomplete blocker, with the blockers listed.',
      filter: { status: ['open', 'in_progress'], blocked: true, orderBy: 'due', limit: VIEW_LIMIT },
    },
    {
      name: 'inbox',
      description: 'Unreviewed items awaiting triage.',
      filter: { status: ['inbox'], orderBy: 'created', limit: VIEW_LIMIT },
    },
    {
      name: 'milestones',
      description: 'Active milestones, soonest due first.',
      filter: { status: ACTIVE, isMilestone: true, orderBy: 'due', limit: VIEW_LIMIT },
    },
    {
      name: 'recently-completed',
      description: 'Tasks completed in the last 7 days.',
      filter: { status: ['done'], completedAfter: `${addDays(today, -7)}T00:00:00.000Z`, orderBy: 'updated', limit: VIEW_LIMIT },
    },
  ];
}

function executeBuiltinView(store: Store, view: ViewDefinition, today: string): Task[] {
  switch (view.name) {
    case 'later':
      return mergeUnique(
        store.searchTasks({ status: ACTIVE, hasDue: false, limit: 1000 }),
        store.searchTasks({ status: ACTIVE, dueAfter: addDays(today, 8), limit: 1000 }),
      );
    case 'waiting':
      return mergeUnique(
        store.searchTasks({ status: ['waiting'], limit: 1000 }),
        store.searchTasks({ status: ACTIVE, blocked: true, limit: 1000 }),
      );
    default:
      return store.searchTasks(view.filter);
  }
}

const CLOSED = new Set<Task['status']>(['done', 'dropped']);

/** Each blocked task's incomplete blockers, keyed by task id. Never empty for a task the blocked view returned. */
function incompleteBlockers(store: Store, tasks: Task[]): Record<string, Task[]> {
  const out: Record<string, Task[]> = {};
  for (const t of tasks) out[t.id] = store.blockersOf(t.id).filter((b) => !CLOSED.has(b.status));
  return out;
}

/** Resolve a built-in or saved view by name/id and run it. The blocked view also carries `blockers`. */
export function runView(store: Store, nameOrId: string, today: string): ViewResult {
  const builtins = builtinViews(today);
  const builtin = builtins.find((v) => v.name === nameOrId);
  if (builtin) {
    const tasks = executeBuiltinView(store, builtin, today);
    if (builtin.name === 'blocked') return { view: builtin, tasks, blockers: incompleteBlockers(store, tasks) };
    return { view: builtin, tasks };
  }

  const saved = store.listViews().find((v) => v.name === nameOrId || v.id === nameOrId);
  if (saved) {
    const view: ViewDefinition = { name: saved.name, description: `Saved view "${saved.name}".`, filter: saved.filter };
    return { view, tasks: store.searchTasks(saved.filter) };
  }

  const names = [...builtins.map((v) => v.name), ...store.listViews().map((v) => v.name)];
  throw new NotFoundError(`view '${nameOrId}' not found. Valid views: ${names.join(', ')}`);
}

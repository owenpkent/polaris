import { useCallback, useState } from 'react'
import { plainTitle } from './dueDates'

// Filter/sort/group state for the My Tasks list (the toolbar's Filter, Sort
// and Group dropdowns, plus each column header menu's own sort shortcut),
// persisted to localStorage. Grouping by due date keeps the existing
// Overdue/Today/Tomorrow/... behavior in MyTasksTab; Project and Priority
// grouping use groupByProject/groupByPriority below instead.

export const NO_PROJECT = '__no_project__'
// The assignee filter's value for a task nobody has claimed (no assignee).
export const UNASSIGNED = '__unassigned__'

const VIEW_STORAGE_KEY = 'cc-mytasks-view-v1'

export const SORT_FIELDS = [
  { id: 'due', label: 'Due date' },
  { id: 'priority', label: 'Priority' },
  { id: 'project', label: 'Project' },
  { id: 'name', label: 'Name' },
]

export const GROUP_MODES = [
  { id: 'due', label: 'Due date' },
  { id: 'project', label: 'Project' },
  { id: 'priority', label: 'Priority' },
  { id: 'none', label: 'None' },
]

// The Readiness filter: each choice is a built-in server view (GET /api/views/:name), and the
// list keeps the tasks that view returns. Ready is what could be started now (open, no incomplete
// blocker, no future start date, not under a done or dropped parent); Blocked is what an
// incomplete blocker holds. The server owns both definitions, so the dashboard, the MCP
// get_view tool, and the digest can never disagree about what is ready.
export const STATE_FILTER_OPTIONS = [
  { id: 'ready', label: 'Ready' },
  { id: 'blocked', label: 'Blocked' },
]

const DEFAULT_VIEW = {
  sort: { field: 'due', dir: 'asc' },
  group: 'due',
  filters: { projectIds: [], priorities: [], sources: [], goalIds: [], states: [], assignees: [] },
}

function loadView() {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function saveView(state) {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Ignore storage errors (private browsing, quota, disabled storage, etc).
  }
}

function normalizeView(loaded) {
  if (!loaded) return DEFAULT_VIEW
  return {
    sort: {
      field: SORT_FIELDS.some((f) => f.id === loaded.sort?.field) ? loaded.sort.field : DEFAULT_VIEW.sort.field,
      dir: loaded.sort?.dir === 'desc' ? 'desc' : 'asc',
    },
    group: GROUP_MODES.some((g) => g.id === loaded.group) ? loaded.group : DEFAULT_VIEW.group,
    filters: {
      projectIds: Array.isArray(loaded.filters?.projectIds) ? loaded.filters.projectIds : [],
      priorities: Array.isArray(loaded.filters?.priorities) ? loaded.filters.priorities : [],
      sources: Array.isArray(loaded.filters?.sources) ? loaded.filters.sources : [],
      goalIds: Array.isArray(loaded.filters?.goalIds) ? loaded.filters.goalIds : [],
      states: Array.isArray(loaded.filters?.states)
        ? loaded.filters.states.filter((id) => STATE_FILTER_OPTIONS.some((o) => o.id === id))
        : [],
      assignees: Array.isArray(loaded.filters?.assignees) ? loaded.filters.assignees : [],
    },
  }
}

export function useViewState() {
  const [view, setView] = useState(() => normalizeView(loadView()))

  const commit = useCallback((updater) => {
    setView((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...updater }
      saveView(next)
      return next
    })
  }, [])

  // Toggling the same field flips direction; picking a new field starts
  // ascending, unless a direction is passed explicitly (the toolbar's Sort
  // menu offers both directions for every field directly).
  const setSort = useCallback((field, dir) => {
    commit((prev) => ({
      ...prev,
      sort: { field, dir: dir ?? (prev.sort.field === field && prev.sort.dir === 'asc' ? 'desc' : 'asc') },
    }))
  }, [commit])

  const setGroup = useCallback((group) => commit((prev) => ({ ...prev, group })), [commit])

  const toggleFilter = useCallback((key, value) => {
    commit((prev) => {
      const set = new Set(prev.filters[key])
      if (set.has(value)) set.delete(value)
      else set.add(value)
      return { ...prev, filters: { ...prev.filters, [key]: [...set] } }
    })
  }, [commit])

  const clearFilters = useCallback(() => {
    commit((prev) => ({ ...prev, filters: { projectIds: [], priorities: [], sources: [], goalIds: [], states: [], assignees: [] } }))
  }, [commit])

  return { view, setSort, setGroup, toggleFilter, clearFilters }
}

export function activeFilterCount(filters) {
  return filters.projectIds.length + filters.priorities.length + filters.sources.length
    + (filters.goalIds?.length ?? 0) + (filters.states?.length ?? 0) + (filters.assignees?.length ?? 0)
}

// What moves each goal, from the goals list's linkedWork: the tasks and projects linked to the
// goal or to any of its sub-goals. Whether a given task is in that work is decided here, from the
// task as the list has it now, not from a list of task ids the server made earlier: a project
// change queued offline then moves the task into or out of the goal at once.
export function goalWorkIndex(goals) {
  const index = new Map()
  for (const goal of goals) {
    index.set(goal.id, {
      taskIds: new Set(goal.linkedWork?.taskIds || []),
      projectIds: new Set(goal.linkedWork?.projectIds || []),
    })
  }
  return index
}

export function taskMovesGoal(task, work) {
  if (!work) return false
  return work.taskIds.has(task.id) || (task.projectId != null && work.projectIds.has(task.projectId))
}

// The task ids each Readiness view returned, from the `/api/views/:name` answers keyed by view
// name. Membership is decided by the server and looked up here by id, since whether a task is
// blocked depends on other tasks, which the list does not carry.
export function stateIndex(viewsByName) {
  const index = new Map()
  for (const [name, result] of Object.entries(viewsByName)) {
    index.set(name, new Set((result?.tasks || []).map((t) => t.id)))
  }
  return index
}

// A goal filter keeps a task that moves any of the chosen goals. A chosen goal the index does not
// know (closed, deleted, or not loaded yet) matches nothing rather than everything. The Readiness
// filter works the same way: a chosen state whose view has not answered matches nothing.
export function applyFilters(tasks, filters, goalWork = new Map(), states = new Map()) {
  const { projectIds, priorities, sources, goalIds = [], states: stateIds = [], assignees = [] } = filters
  if (projectIds.length === 0 && priorities.length === 0 && sources.length === 0 && goalIds.length === 0 && stateIds.length === 0 && assignees.length === 0) return tasks
  return tasks.filter((t) => {
    if (projectIds.length > 0 && !projectIds.includes(t.projectId || NO_PROJECT)) return false
    if (priorities.length > 0 && !priorities.includes(t.priority || 'none')) return false
    if (sources.length > 0 && !sources.includes(t.sourceType || 'manual')) return false
    if (goalIds.length > 0 && !goalIds.some((id) => taskMovesGoal(t, goalWork.get(id)))) return false
    if (stateIds.length > 0 && !stateIds.some((id) => states.get(id)?.has(t.id))) return false
    if (assignees.length > 0 && !assignees.includes(t.assignee || UNASSIGNED)) return false
    return true
  })
}

const PRIORITY_SORT_RANK = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 }

function compareTasks(a, b, field, projectNameById) {
  if (field === 'priority') {
    return (PRIORITY_SORT_RANK[a.priority || 'none'] ?? 4) - (PRIORITY_SORT_RANK[b.priority || 'none'] ?? 4)
  }
  if (field === 'project') {
    const na = (projectNameById.get(a.projectId) || '').toLowerCase()
    const nb = (projectNameById.get(b.projectId) || '').toLowerCase()
    if (!na && nb) return 1
    if (na && !nb) return -1
    return na.localeCompare(nb)
  }
  if (field === 'name') {
    return plainTitle(a.title).toLowerCase().localeCompare(plainTitle(b.title).toLowerCase())
  }
  // 'due': tasks with no due date sort last regardless of direction.
  const da = a.dueAt || '9999-99-99'
  const db = b.dueAt || '9999-99-99'
  return da < db ? -1 : da > db ? 1 : 0
}

export function sortTasks(tasks, sort, projectNameById) {
  // For 'due', only the dated tasks take part in the direction flip; undated tasks are
  // appended afterwards so reversing for 'desc' cannot move them to the front.
  const pool = sort.field === 'due' ? tasks.filter((t) => t.dueAt) : [...tasks]
  const sorted = pool.sort((a, b) => compareTasks(a, b, sort.field, projectNameById))
  if (sort.dir === 'desc') sorted.reverse()
  if (sort.field === 'due') sorted.push(...tasks.filter((t) => !t.dueAt))
  return sorted
}

// Project/priority grouping for the toolbar's Group dropdown. Due-date
// grouping stays in MyTasksTab/dueDates.js since it also drives the inline
// "Add task" rows; these two are display-only (no addRow, no inline add).
// The group a task falls in under the Project and Priority groupings, so a caller can expand
// that group before the task appears (MyTasksTab reveals a task the phone sheet just made).
export function projectGroupId(task) {
  return task.projectId || NO_PROJECT
}

export function priorityGroupId(task) {
  // An unrecognized priority is shown under "No priority" (the same rank sorting gives it)
  // rather than landing in a bucket that is never rendered.
  return PRIORITY_GROUP_ORDER.includes(task.priority) ? task.priority : 'none'
}

export function groupByProject(tasks, projectNameById) {
  const buckets = new Map()
  for (const task of tasks) {
    const key = projectGroupId(task)
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(task)
  }
  const groups = [...buckets.entries()].map(([id, groupTasks]) => ({
    id,
    label: id === NO_PROJECT ? 'No project' : (projectNameById.get(id) || 'Unknown project'),
    tasks: groupTasks,
  }))
  groups.sort((a, b) => {
    if (a.id === NO_PROJECT) return 1
    if (b.id === NO_PROJECT) return -1
    return a.label.localeCompare(b.label)
  })
  return groups
}

const PRIORITY_GROUP_ORDER = ['urgent', 'high', 'medium', 'low', 'none']
const PRIORITY_GROUP_LABELS = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low', none: 'No priority' }

export function groupByPriority(tasks) {
  const buckets = new Map()
  for (const task of tasks) {
    const key = priorityGroupId(task)
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(task)
  }
  return PRIORITY_GROUP_ORDER
    .filter((id) => buckets.has(id))
    .map((id) => ({ id, label: PRIORITY_GROUP_LABELS[id], tasks: buckets.get(id) }))
}

import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react'
import { Plus } from 'lucide-react'
import { useConnection } from './ConnectionContext'
import { useEventRefresh } from './useEvents'
import { MY_TASKS_QUERY } from './api'
import { shareToTaskFields } from './shareIntake'
import NotConnected from './NotConnected'
import TaskDetailPanel from './TaskDetailPanel'
import TaskGroupSection from './TaskGroupSection'
import { TaskTree, indexSubtasks } from './TaskRow'
import { completeExitDelay } from './CompleteBurst'
import TaskListToolbar from './TaskListToolbar'
import ColumnHeader from './ColumnHeader'
import InlineTaskInput from './InlineTaskInput'
import NewTaskSheet from './NewTaskSheet'
import KeyboardLegendDialog from './KeyboardLegendDialog'
import { Loading, ErrorBanner } from './shared'
import { getDueBounds, groupTasks, bucketForTask, dueForDrop, dropStartDay, withDueDate } from './dueDates'
import DueDateMenu from './DueDateMenu'
import { useColumnsState, useNarrowBreakpoints, getVisibleColumns, buildGridTemplate } from './columnsState'
import { useViewState, applyFilters, goalWorkIndex, stateIndex, sortTasks, groupByProject, groupByPriority, projectGroupId, priorityGroupId, isManualSort, STATE_FILTER_OPTIONS } from './viewState'
import ReorderableRows, { ReorderScope } from './ReorderableRows'
import { planInsert } from './reorder'
import { useRequestGuard } from './useRequestGuard'

const GROUPS_STORAGE_KEY = 'cc-mytasks-groups-v1'

// Overdue/Today/Tomorrow/Next7 start expanded; Later/No-due-date start
// collapsed. Used only when no stored preference exists yet for a group,
// and only for the (default) due-date grouping -- Project/Priority groups
// always start expanded.
const DEFAULT_COLLAPSED = { overdue: false, today: false, tomorrow: false, next7: false, later: true, noDue: true }

function loadCollapsed() {
  try {
    const raw = localStorage.getItem(GROUPS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveCollapsed(state) {
  try {
    localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Ignore storage errors (private browsing, quota, disabled storage, etc).
  }
}

// `closed`: a row can be reordered inside the group and moved out of it, never moved into it.
// Overdue is where a date lands by passing, not somewhere to put a task.
const GROUP_ORDER = [
  { id: 'overdue', label: 'Overdue', closed: true, addRow: null },
  { id: 'today', label: 'Today', addRow: (bounds) => ({ dueAt: bounds.today }) },
  { id: 'tomorrow', label: 'Tomorrow', addRow: (bounds) => ({ dueAt: bounds.tomorrow }) },
  { id: 'next7', label: 'Next 7 days', addRow: null },
  { id: 'later', label: 'Later', addRow: null },
  { id: 'noDue', label: 'No due date', addRow: () => ({ dueAt: null }) },
]

// The group id a task is rendered under in each grouping mode, or null for the flat list.
function groupIdFor(task, mode, dueBounds) {
  if (mode === 'due') return bucketForTask(task, dueBounds)
  if (mode === 'project') return projectGroupId(task)
  if (mode === 'priority') return priorityGroupId(task)
  return null
}

// `share` ({ title, text, url } or null) is a share handed in by App (shareIntake.js): it opens the
// new-task sheet prefilled, and `onShareConsumed(share)` tells App to drop that share once the
// sheet is done. A share that arrives while the sheet is open starts the draft again from it, and
// closing consumes only the share the draft was made from, so a newer one is never dropped unseen.
// `focusTaskId` is a task id handed in by App (a reminder tap, or ?task=): it opens that task's
// panel, and `onFocusTaskConsumed` tells App to drop it.
export default function MyTasksTab({ share = null, onShareConsumed, focusTaskId = null, onFocusTaskConsumed }) {
  const { connected, local, api } = useConnection()
  // Local mode (no connection yet) works from this device's copy, like offline.
  const usable = connected || local
  const [tasks, setTasks] = useState([])
  const [projects, setProjects] = useState([])
  const [goals, setGoals] = useState([])
  const [goalsLoaded, setGoalsLoaded] = useState(false)
  const [goalsError, setGoalsError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [actionError, setActionError] = useState(null)
  const [detailTaskId, setDetailTaskId] = useState(null)
  const [pendingIds, setPendingIds] = useState(() => new Set())
  const [collapsedOverrides, setCollapsedOverrides] = useState(() => loadCollapsed())
  const [inlineAdd, setInlineAdd] = useState(null) // { groupId, dueAt, position, seq } | null; groupId null == ungrouped top add
  // Each opening of the inline row is a new row (its key), so a row left empty that closes after
  // the click that opened another one can only close itself.
  const inlineSeq = useRef(0)
  const [legendOpen, setLegendOpen] = useState(false)
  // The phone tier creates tasks through a sheet opened by the floating Add task button; the
  // toolbar's inline row is desktop only (index.css hides it under 640px).
  const [sheetOpen, setSheetOpen] = useState(false)
  // `seq` numbers each share the sheet is seeded from, so a second share while it is open reseeds
  // the draft; `share` is the one the draft belongs to, and the only one closing consumes.
  const [sheetSeed, setSheetSeed] = useState({ seq: 0, initial: null, share: null })
  const fabRef = useRef(null)

  useEffect(() => {
    if (!share) return
    setSheetSeed((prev) => ({ seq: prev.seq + 1, initial: shareToTaskFields(share), share }))
    setSheetOpen(true)
  }, [share])

  useEffect(() => {
    if (!focusTaskId) return
    setDetailTaskId(focusTaskId)
    onFocusTaskConsumed?.()
  }, [focusTaskId, onFocusTaskConsumed])

  const closeSheet = useCallback(() => {
    const consumed = sheetSeed.share
    setSheetOpen(false)
    setSheetSeed((prev) => ({ seq: prev.seq, initial: null, share: null }))
    if (consumed) onShareConsumed?.(consumed)
  }, [onShareConsumed, sheetSeed.share])

  const columns = useColumnsState()
  const { narrow900, narrow600, phone, narrowPanel } = useNarrowBreakpoints()
  const { view, setSort, setGroup, toggleFilter, clearFilters, resetSort } = useViewState()

  const projectNameById = useMemo(() => {
    const map = new Map()
    projects.forEach((p) => map.set(p.id, p.name))
    return map
  }, [projects])

  const projectOptions = useMemo(
    () => [...projects].sort((a, b) => a.name.localeCompare(b.name)),
    [projects]
  )

  const visibleColumns = useMemo(
    () => getVisibleColumns(columns.hidden, { narrow900, narrow600, phone, narrowPanel, panelOpen: Boolean(detailTaskId) }),
    [columns.hidden, narrow900, narrow600, phone, narrowPanel, detailTaskId]
  )
  // Under the manual sort every row leads with its reorder handle (ReorderHandle.jsx), so the
  // grid, the column header, and the inline add row all take the extra 44px column.
  const reorderable = isManualSort(view.sort)
  const gridTemplateColumns = useMemo(
    () => buildGridTemplate(visibleColumns, columns.widths, { phone, handle: reorderable }),
    [visibleColumns, columns.widths, phone, reorderable]
  )

  const beginRequest = useRequestGuard()
  // The positions of moves whose writes are still on their way (handleReorder), laid over every
  // list the server answers until the queue is empty. A poll (useEventRefresh) set off by the
  // first move's event, or a load that was already in flight, would otherwise put the server's
  // in-between order back over a later move, and the next move would start from the wrong place.
  const pendingPositions = useRef(new Map())
  // The same for a due date moved with a row (moveAcross): task id -> the fields it was given.
  const pendingPatches = useRef(new Map())
  const withPendingPositions = useCallback((list) => {
    const pending = pendingPositions.current
    const patches = pendingPatches.current
    if (!pending.size && !patches.size) return list
    return list.map((t) => {
      let next = t
      if (pending.has(t.id)) next = { ...next, position: pending.get(t.id) }
      if (patches.has(t.id)) next = { ...next, ...patches.get(t.id) }
      return next
    })
  }, [])
  const fetchTasks = useCallback(async () => {
    const isCurrent = beginRequest()
    setError(null)
    try {
      const res = await api.listTasks(MY_TASKS_QUERY)
      if (isCurrent()) setTasks(withPendingPositions(res.tasks || []))
    } catch (err) {
      if (isCurrent()) setError(err.message || 'Could not load tasks.')
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [api, beginRequest, withPendingPositions])

  useEffect(() => {
    if (!usable) return
    setLoading(true)
    fetchTasks()
  }, [usable, fetchTasks])

  useEffect(() => {
    if (!usable) return
    api.listProjects().then((res) => setProjects(res.projects || [])).catch(() => {})
  }, [usable, api])

  // Open goals for the Goal filter. Each carries the tasks and projects linked to it. A failed
  // request only matters while a goal is chosen: then the list cannot be filtered, and the
  // banner says so rather than showing an empty list. Without a chosen goal there is simply no
  // Goal group to offer, as in local mode, and the rest of the list works.
  const beginGoalsRequest = useRequestGuard()
  const fetchGoals = useCallback(async () => {
    const isCurrent = beginGoalsRequest()
    try {
      const res = await api.listGoals()
      if (!isCurrent()) return
      setGoals(res.goals || [])
      setGoalsLoaded(true)
      setGoalsError(null)
    } catch (err) {
      if (isCurrent()) setGoalsError(err.message || 'Could not load goals.')
    }
  }, [api, beginGoalsRequest])

  useEffect(() => {
    if (usable) fetchGoals()
  }, [usable, fetchGoals])

  // The Readiness filter's views, fetched only while a state is chosen: which tasks are ready or
  // blocked is the server's call (automation/views.ts), since it depends on other tasks. The
  // chosen names are joined into one string so the effect below reruns only when the choice
  // changes, not on every render that makes a new array.
  const chosenStates = view.filters.states || []
  const stateKey = chosenStates.join(',')
  const [stateViews, setStateViews] = useState({}) // view name -> { view, tasks, blockers? }
  const [statesLoadedFor, setStatesLoadedFor] = useState('')
  const [statesError, setStatesError] = useState(null)
  const beginStatesRequest = useRequestGuard()
  const fetchStates = useCallback(async () => {
    const names = stateKey ? stateKey.split(',') : []
    const isCurrent = beginStatesRequest()
    if (names.length === 0) {
      setStateViews({})
      setStatesLoadedFor('')
      setStatesError(null)
      return
    }
    try {
      const answers = await Promise.all(names.map((name) => api.getView(name)))
      if (!isCurrent()) return
      setStateViews(Object.fromEntries(names.map((name, i) => [name, answers[i]])))
      setStatesLoadedFor(stateKey)
      setStatesError(null)
    } catch (err) {
      if (isCurrent()) setStatesError(err.message || 'Could not load the view.')
    }
  }, [api, beginStatesRequest, stateKey])

  useEffect(() => {
    if (usable) fetchStates()
  }, [usable, fetchStates])

  // One poll refreshes all three: linking a task to a goal changes what the Goal filter shows, and
  // completing a blocker changes what Ready and Blocked show.
  const refresh = useCallback(() => {
    fetchTasks()
    fetchGoals()
    fetchStates()
  }, [fetchTasks, fetchGoals, fetchStates])
  useEventRefresh(refresh, { enabled: connected })

  const goalWork = useMemo(() => goalWorkIndex(goals), [goals])
  // Each task's open subtasks, from the whole list rather than the filtered one, for the count
  // after a row's name and the rows it shows under it (TaskTree in TaskRow.jsx).
  const subtasksByParent = useMemo(() => indexSubtasks(tasks), [tasks])
  const states = useMemo(() => stateIndex(stateViews), [stateViews])

  // Global "?" toggles the shortcuts dialog, unless the user is typing.
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key !== '?') return
      const tag = (e.target?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return
      e.preventDefault()
      setLegendOpen((v) => !v)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Collapse state is namespaced by group mode ("due:today", "project:<id>",
  // ...) so a project or priority value can never collide with one of the
  // fixed due-date group ids. Due-date groups fall back to a flat legacy key
  // (just the group id) so preferences saved before grouping modes existed
  // still apply.
  const isCollapsed = useCallback((mode, groupId) => {
    const key = `${mode}:${groupId}`
    if (key in collapsedOverrides) return collapsedOverrides[key]
    if (mode === 'due' && groupId in collapsedOverrides) return collapsedOverrides[groupId]
    return mode === 'due' ? DEFAULT_COLLAPSED[groupId] : false
  }, [collapsedOverrides])

  const toggleGroup = useCallback((mode, groupId) => {
    setCollapsedOverrides((prev) => {
      const current = isCollapsed(mode, groupId)
      const next = { ...prev, [`${mode}:${groupId}`]: !current }
      saveCollapsed(next)
      return next
    })
  }, [isCollapsed])

  const ensureExpanded = useCallback((mode, groupId) => {
    setCollapsedOverrides((prev) => {
      if (!isCollapsed(mode, groupId)) return prev
      const next = { ...prev, [`${mode}:${groupId}`]: false }
      saveCollapsed(next)
      return next
    })
  }, [isCollapsed])

  const openInlineAdd = useCallback((groupId, dueAt, position) => {
    ensureExpanded('due', groupId)
    setInlineAdd({ groupId, dueAt, position, seq: ++inlineSeq.current })
  }, [ensureExpanded])

  const closeInlineAdd = useCallback(() => setInlineAdd(null), [])

  const handleAddTaskClick = useCallback(() => {
    const dueBounds = getDueBounds()
    if (view.group === 'due') {
      openInlineAdd('today', dueBounds.today, 'top')
    } else {
      setInlineAdd({ groupId: null, dueAt: dueBounds.today, position: 'top', seq: ++inlineSeq.current })
    }
  }, [view.group, openInlineAdd])

  // The inline row (InlineTaskInput.jsx) hands over the group's date, or the date and repeat
  // picked in its "When is it due?" step. The row stays open for the next task, as Asana's does;
  // Esc or leaving it empty closes it, and a click elsewhere adds what was typed and closes it.
  const submitInlineAdd = useCallback(async (title, { dueAt = inlineAdd?.dueAt ?? null, recurrence = null } = {}) => {
    const payload = { title }
    if (dueAt) payload.dueAt = dueAt
    if (recurrence) payload.recurrence = recurrence
    await api.createTask(payload)
    await fetchTasks()
  }, [api, fetchTasks, inlineAdd])

  // The sheet closes itself once this resolves, and only if it is still the opening that sent
  // the request (NewTaskSheet.jsx), so a slow create never closes a newer draft.
  // The sheet's default is no due date, and that group starts collapsed (Later too), so the
  // new task's group is expanded before the list reloads, and the row is scrolled to once it is
  // there: a task saved out of sight looks like a task not saved.
  const [revealTaskId, setRevealTaskId] = useState(null)
  const submitSheet = useCallback(async (payload) => {
    const { task } = await api.createTask(payload)
    if (task) {
      const groupId = groupIdFor(task, view.group, getDueBounds())
      if (groupId !== null) ensureExpanded(view.group, groupId)
    }
    await fetchTasks()
    if (task) setRevealTaskId(task.id)
  }, [api, fetchTasks, ensureExpanded, view.group])

  useEffect(() => {
    if (!revealTaskId || loading) return
    const row = document.querySelector(`[data-task-id="${revealTaskId}"]`)
    // jsdom has no scrollIntoView; a row not rendered (filtered out) is left alone.
    row?.scrollIntoView?.({ block: 'nearest' })
    setRevealTaskId(null)
  }, [revealTaskId, loading])

  const handleToggleComplete = useCallback(async (task) => {
    const wasDone = task.status === 'done'
    setActionError(null)
    setPendingIds((prev) => new Set(prev).add(task.id))
    // Optimistic: flip the visible state immediately.
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: wasDone ? 'open' : 'done' } : t)))
    try {
      if (wasDone) {
        await api.reopenTask(task.id)
      } else {
        // The row stays while its check celebrates and it fades (TaskRow, CompleteBurst.jsx).
        const exit = new Promise((resolve) => setTimeout(resolve, completeExitDelay()))
        await api.completeTask(task.id)
        await exit
      }
      await fetchTasks()
    } catch (err) {
      // Roll back on failure.
      setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: task.status } : t)))
      setActionError(err.message || 'Could not update that task.')
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev)
        next.delete(task.id)
        return next
      })
    }
  }, [api, fetchTasks])

  // Due date/Project/Priority quick edits from a TaskRow's inline dropdowns:
  // optimistic update, roll back and surface the error banner on failure,
  // then refetch either way (mirrors handleToggleComplete above).
  const handleQuickUpdate = useCallback(async (task, patch) => {
    setActionError(null)
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, ...patch } : t)))
    try {
      await api.updateTask(task.id, patch)
      await fetchTasks()
    } catch (err) {
      setTasks((prev) => prev.map((t) => (t.id === task.id ? task : t)))
      setActionError(err.message || 'Could not update that task.')
    }
  }, [api, fetchTasks])

  // A drag or a handle's menu (reorder.js, ReorderableRows.jsx): the plan names each task's new
  // position, shown at once, and its moves are sent one after another. Moves queue behind each
  // other, so two quick arrow presses reach the server in the order they were made and the
  // later one cannot be overwritten by the earlier one's write arriving late. The list reloads
  // once the queue is empty, and until then a list from anywhere else keeps the pending numbers
  // (withPendingPositions), so the order shown never slips back between two moves. Failure puts
  // that plan's old numbers back.
  const reorderQueue = useRef(Promise.resolve())
  const reorderPending = useRef(0)
  // `patch` is a due date (and rule) that moves with the row (moveAcross): it is written first, and
  // a failure puts back the old fields along with the old positions.
  const handleReorder = useCallback((plan, patch = null, task = null) => {
    setActionError(null)
    const next = new Map(plan.updates.map((u) => [u.id, u.position]))
    for (const [id, position] of next) pendingPositions.current.set(id, position)
    if (patch) pendingPatches.current.set(task.id, { ...pendingPatches.current.get(task.id), ...patch })
    let before = new Map()
    setTasks((prev) => {
      before = new Map(prev.filter((t) => next.has(t.id) || (patch && t.id === task.id)).map((t) => [t.id, t]))
      return prev.map((t) => {
        let out = t
        if (next.has(t.id)) out = { ...out, position: next.get(t.id) }
        if (patch && t.id === task.id) out = { ...out, ...patch }
        return out
      })
    })
    reorderPending.current += 1
    const run = async () => {
      try {
        if (patch) await api.updateTask(task.id, patch)
        for (const u of plan.updates) await api.moveTask(u.id, { position: u.position })
      } catch (err) {
        for (const [id, position] of next) if (pendingPositions.current.get(id) === position) pendingPositions.current.delete(id)
        if (patch) pendingPatches.current.delete(task.id)
        setTasks((prev) => prev.map((t) => {
          const old = before.get(t.id)
          if (!old) return t
          let out = { ...t, position: old.position }
          if (patch && t.id === task.id) for (const key of Object.keys(patch)) out[key] = old[key]
          return out
        }))
        setActionError(err.message || 'Could not move that task.')
      }
      reorderPending.current -= 1
      if (reorderPending.current === 0) {
        pendingPositions.current.clear()
        pendingPatches.current.clear()
        await fetchTasks()
      }
    }
    reorderQueue.current = reorderQueue.current.then(run)
    return reorderQueue.current
  }, [api, fetchTasks])

  // A row moved into another due-date group, by drag, arrow key, or the handle's menu (the due-date
  // grouping under the manual sort; never into Overdue, which is closed). The group sets the date
  // (dueForDrop): Today and Tomorrow set that day, No due date clears it, and a range (Next 7
  // days, Later) opens the due date picker on the row, starting on the day of the row it was dropped next to. Until a day is picked
  // the row shows at the drop with that day; Esc or closing the picker takes the move back whole.
  // The position is the drop slot's, and both writes go through handleReorder's queue.
  const [pendingMove, setPendingMove] = useState(null) // { task, plan, startDay, dueAt } | null
  const pendingMoveRef = useRef(null)
  const closedMoveRef = useRef(null)
  const [refocusId, setRefocusId] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [moveAnchorEl, setMoveAnchorEl] = useState(null)
  const moveAnchorRef = useMemo(() => ({ current: moveAnchorEl }), [moveAnchorEl])
  const moveId = pendingMove?.task.id ?? null
  useLayoutEffect(() => {
    setMoveAnchorEl(moveId ? document.querySelector(`[data-task-id="${moveId}"] .reorder-handle`) : null)
  }, [moveId])
  const groupRowsRef = useRef({})
  const moveAcross = useCallback(({ task, toId, slot }) => {
    const bounds = getDueBounds()
    const rows = (groupRowsRef.current[toId] || []).filter((t) => t.id !== task.id)
    const plan = planInsert(rows, task.id, slot)
    const rule = dueForDrop(toId, task.dueAt, bounds)
    ensureExpanded('due', toId)
    setRefocusId(task.id)
    if (rule.mode === 'set') {
      handleReorder(plan, { dueAt: rule.dueAt }, task)
      return
    }
    const near = rows[plan.index - 1] ?? rows[plan.index]
    const startDay = dropStartDay(toId, bounds, near?.dueAt)
    const move = { task, plan, startDay, dueAt: withDueDate(task.dueAt, startDay) }
    pendingMoveRef.current = move
    closedMoveRef.current = null
    setPendingMove(move)
  }, [ensureExpanded, handleReorder])

  const cancelMove = useCallback(() => {
    closedMoveRef.current = pendingMoveRef.current
    pendingMoveRef.current = null
    setPendingMove(null)
    // The preview's handle goes away with it, so the row's handle takes focus where it returns.
    if (closedMoveRef.current) setRefocusId(closedMoveRef.current.task.id)
  }, [])
  // The picker closes itself before it reports a pick, so the move is read from the one it closed.
  const confirmMove = useCallback((dueAt) => {
    const move = pendingMoveRef.current ?? closedMoveRef.current
    pendingMoveRef.current = null
    closedMoveRef.current = null
    setPendingMove(null)
    if (move) {
      setRefocusId(move.task.id)
      handleReorder(move.plan, { dueAt }, move.task)
    }
  }, [handleReorder])

  // The moved row is a new element in its new group, so its handle takes focus again.
  useEffect(() => {
    if (!refocusId) return
    const handle = document.querySelector(`[data-task-id="${refocusId}"] .reorder-handle`)
    if (handle) {
      handle.focus()
      setRefocusId(null)
    }
  }, [refocusId, tasks, pendingMove])

  if (!usable) return <NotConnected />

  const dueBounds = getDueBounds()
  // A chosen goal needs the goals before the list can be filtered: until they answer the list
  // is still loading, and when they fail the banner below explains the empty list.
  const goalFilterActive = view.filters.goalIds.length > 0
  const goalsPending = goalFilterActive && !goalsLoaded && !goalsError
  const goalFilterError = goalFilterActive && !goalsLoaded && goalsError
    ? `The Goal filter is on, but the goals could not be loaded. ${goalsError}`
    : null
  // The same for Ready and Blocked: their views must answer before the list can be filtered.
  const stateFilterActive = chosenStates.length > 0
  const statesLoaded = statesLoadedFor === stateKey
  const statesPending = stateFilterActive && !statesLoaded && !statesError
  const stateFilterLabel = STATE_FILTER_OPTIONS.filter((o) => chosenStates.includes(o.id)).map((o) => o.label).join(' and ')
  const stateFilterError = stateFilterActive && !statesLoaded && statesError
    ? `The ${stateFilterLabel} filter is on, but its tasks could not be loaded. ${statesError}`
    : null
  const listLoading = loading || goalsPending || statesPending
  // A row waiting on the picker shows at its drop, with the day the picker opens on.
  const shownTasks = pendingMove
    ? tasks.map((t) => (t.id === pendingMove.task.id ? { ...t, dueAt: pendingMove.dueAt, position: pendingMove.plan.updates.find((u) => u.id === t.id)?.position ?? t.position } : t))
    : tasks
  const filteredTasks = applyFilters(shownTasks, view.filters, goalWork, states)
  const sortedTasks = sortTasks(filteredTasks, view.sort, projectNameById)

  const commonRowProps = {
    dueBounds,
    projectNameById,
    subtasksByParent,
    projectOptions,
    visibleColumns,
    gridTemplateColumns,
    phone,
    pendingIds,
    openTaskId: detailTaskId,
    onToggleComplete: handleToggleComplete,
    onOpenTask: setDetailTaskId,
    onQuickUpdate: handleQuickUpdate,
    api,
    handleColumn: reorderable,
    reorderable,
    onReorder: handleReorder,
  }

  let content = null
  let scopeGroups = []
  let crossGroup = false
  if (!listLoading) {
    if (view.group === 'due') {
      const groups = groupTasks(sortedTasks, dueBounds)
      // An empty group is hidden, except the one a new task is being typed into: the toolbar's Add
      // task opens the inline row in Today, which owns that row and must be on the page to show it.
      // Under the manual sort a row can be dropped into any day group, so the empty ones show
      // while a row is held, as drop targets (not a closed one, which takes no drop).
      crossGroup = reorderable
      const shown = GROUP_ORDER.filter((g) => groups[g.id].length > 0 || inlineAdd?.groupId === g.id || (crossGroup && dragging && !g.closed))
      scopeGroups = GROUP_ORDER.map((g) => ({ id: g.id, label: g.label, tasks: groups[g.id], closed: Boolean(g.closed) }))
      groupRowsRef.current = groups
      content = shown.map((g) => {
        const groupTasksList = groups[g.id]
        const addRow = g.addRow ? g.addRow(dueBounds) : null
        return (
          <TaskGroupSection
            key={g.id}
            groupId={g.id}
            title={g.label}
            tasks={groupTasksList}
            collapsed={isCollapsed('due', g.id)}
            onToggleCollapse={() => toggleGroup('due', g.id)}
            {...commonRowProps}
            addRow={addRow}
            inlineAdd={inlineAdd?.groupId === g.id ? inlineAdd : null}
            onOpenInlineAdd={(position) => openInlineAdd(g.id, addRow?.dueAt ?? null, position)}
            onSubmitInlineAdd={submitInlineAdd}
            onCancelInlineAdd={closeInlineAdd}
          />
        )
      })
    } else if (view.group === 'project') {
      const groups = groupByProject(sortedTasks, projectNameById)
      scopeGroups = groups
      content = groups.map((g) => (
        <TaskGroupSection
          key={g.id}
          groupId={g.id}
          title={g.label}
          tasks={g.tasks}
          collapsed={isCollapsed('project', g.id)}
          onToggleCollapse={() => toggleGroup('project', g.id)}
          {...commonRowProps}
        />
      ))
    } else if (view.group === 'priority') {
      const groups = groupByPriority(sortedTasks)
      scopeGroups = groups
      content = groups.map((g) => (
        <TaskGroupSection
          key={g.id}
          groupId={g.id}
          title={g.label}
          tasks={g.tasks}
          collapsed={isCollapsed('priority', g.id)}
          onToggleCollapse={() => toggleGroup('priority', g.id)}
          {...commonRowProps}
        />
      ))
    } else {
      // 'none': a flat, ungrouped list.
      scopeGroups = [{ id: '_all', label: 'the list', tasks: sortedTasks }]
      content = (
        <div data-reorder-group="_all">
          <ReorderableRows groupId="_all" tasks={sortedTasks} enabled={reorderable} onReorder={handleReorder}>
            {(task, reorder, rowClass) => (
              <TaskTree key={task.id} task={task} {...commonRowProps} onOpen={setDetailTaskId} reorder={reorder} rowClass={rowClass} />
            )}
          </ReorderableRows>
        </div>
      )
    }
  }

  return (
    <div>
      <div style={{ marginRight: detailTaskId ? 560 : 0 }}>
        <TaskListToolbar
          onAddTask={handleAddTaskClick}
          projects={projects}
          goals={goals}
          goalsLoaded={goalsLoaded}
          tasks={tasks}
          view={view}
          onSetSort={setSort}
          onResetSort={resetSort}
          onSetGroup={setGroup}
          onToggleFilter={toggleFilter}
          onClearFilters={clearFilters}
          hiddenColumns={columns.hidden}
          onSetColumnHidden={columns.setHidden}
        />

        <ErrorBanner
          message={error || goalFilterError || stateFilterError || actionError}
          onRetry={error ? fetchTasks : goalFilterError ? fetchGoals : stateFilterError ? fetchStates : undefined}
        />

        {/* A flat column header stuck under the top bar, then the list: one panel holding every
            group in turn (TaskGroupSection), or the flat rows when ungrouped. */}
        <div className={reorderable ? 'mytasks-reorderable' : undefined} style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ position: 'sticky', top: 56, zIndex: 10, background: 'var(--bg)' }}>
            <div className="mytasks-grid mytasks-colhead" style={{ gridTemplateColumns }}>
              {reorderable && <div />}
              <div />
              {visibleColumns.map((col) => (
                <ColumnHeader
                  key={col.id}
                  column={col}
                  phone={phone}
                  sort={view.sort}
                  onSetSort={setSort}
                  onSetWidth={columns.setWidth}
                  onResetWidth={columns.resetWidth}
                  onHide={(id) => columns.setHidden(id, true)}
                />
              ))}
            </div>
          </div>

          {listLoading ? (
            <div style={{ paddingTop: 16 }}>
              <Loading label="Loading tasks…" />
            </div>
          ) : (
            <div className="mytasks-list">
              {inlineAdd?.groupId === null && (
                <InlineTaskInput key={inlineAdd.seq} gridTemplateColumns={gridTemplateColumns} dueColumn={visibleColumns.some((c) => c.id === 'due')} phone={phone} handleColumn={reorderable} onSubmit={submitInlineAdd} onCancel={closeInlineAdd} defaultDueAt={inlineAdd.dueAt ?? null} api={api} />
              )}
              <ReorderScope enabled={reorderable} crossGroup={crossGroup} groups={scopeGroups} onReorder={handleReorder} onMoveAcross={moveAcross} onDragChange={setDragging}>
                {content}
              </ReorderScope>
            </div>
          )}
        </div>
      </div>

      {detailTaskId && (
        <TaskDetailPanel
          taskId={detailTaskId}
          onClose={() => setDetailTaskId(null)}
          onChanged={refresh}
          onOpenTask={setDetailTaskId}
        />
      )}

      {pendingMove && moveAnchorEl && (
        <DueDateMenu
          anchorRef={moveAnchorRef}
          open
          onClose={cancelMove}
          value={pendingMove.task.dueAt}
          startDay={pendingMove.startDay}
          dueBounds={dueBounds}
          onChange={confirmMove}
          label={`Due date for ${pendingMove.task.title}`}
          api={api}
        />
      )}

      {legendOpen && <KeyboardLegendDialog onClose={() => setLegendOpen(false)} />}

      {phone && !detailTaskId && (
        <button ref={fabRef} type="button" className="fab" aria-label="New task" onClick={() => setSheetOpen(true)}>
          <Plus size={28} aria-hidden="true" />
        </button>
      )}
      {/* Always mounted: the draft lives inside the sheet, and a phone turned to landscape crosses
          the 640px breakpoint while it is open. index.css centres it like a modal above 640px. */}
      <NewTaskSheet
        open={sheetOpen}
        onClose={closeSheet}
        onCreate={submitSheet}
        initial={sheetSeed.initial}
        seed={sheetSeed.seq}
        projects={projectOptions}
        openButtonRef={fabRef}
        api={api}
      />
    </div>
  )
}

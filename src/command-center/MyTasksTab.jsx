import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Plus } from 'lucide-react'
import { useConnection } from './ConnectionContext'
import { useEventRefresh } from './useEvents'
import { MY_TASKS_QUERY } from './api'
import { shareToTaskFields } from './shareIntake'
import NotConnected from './NotConnected'
import TaskDetailPanel from './TaskDetailPanel'
import TaskGroupSection from './TaskGroupSection'
import TaskRow from './TaskRow'
import TaskListToolbar from './TaskListToolbar'
import ColumnHeader from './ColumnHeader'
import InlineTaskInput from './InlineTaskInput'
import NewTaskSheet from './NewTaskSheet'
import KeyboardLegendDialog from './KeyboardLegendDialog'
import { Loading, ErrorBanner } from './shared'
import { getDueBounds, groupTasks, bucketForTask } from './dueDates'
import { useColumnsState, useNarrowBreakpoints, getVisibleColumns, buildGridTemplate } from './columnsState'
import { useViewState, applyFilters, goalWorkIndex, stateIndex, sortTasks, groupByProject, groupByPriority, projectGroupId, priorityGroupId, STATE_FILTER_OPTIONS } from './viewState'
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

const GROUP_ORDER = [
  { id: 'overdue', label: 'Overdue', alwaysShow: false, addRow: null },
  { id: 'today', label: 'Today', alwaysShow: true, addRow: (bounds) => ({ dueAt: bounds.today }) },
  { id: 'tomorrow', label: 'Tomorrow', alwaysShow: true, addRow: (bounds) => ({ dueAt: bounds.tomorrow }) },
  { id: 'next7', label: 'Next 7 days', alwaysShow: false, addRow: null },
  { id: 'later', label: 'Later', alwaysShow: false, addRow: null },
  { id: 'noDue', label: 'No due date', alwaysShow: false, addRow: () => ({ dueAt: null }) },
]

// The group id a task is rendered under in each grouping mode, or null for the flat list.
function groupIdFor(task, mode, dueBounds) {
  if (mode === 'due') return bucketForTask(task, dueBounds)
  if (mode === 'project') return projectGroupId(task)
  if (mode === 'priority') return priorityGroupId(task)
  return null
}

// `share` ({ title, text, url } or null) is a share handed in by App (shareIntake.js): it opens the
// new-task sheet prefilled, and `onShareConsumed` tells App to drop it once the sheet is done.
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
  const [inlineAdd, setInlineAdd] = useState(null) // { groupId, dueAt, position } | null; groupId null == ungrouped top add
  const [legendOpen, setLegendOpen] = useState(false)
  // The phone tier creates tasks through a sheet opened by the floating Add task button; the
  // toolbar's inline row is desktop only (index.css hides it under 640px).
  const [sheetOpen, setSheetOpen] = useState(false)
  const [sheetInitial, setSheetInitial] = useState(null)
  const fabRef = useRef(null)

  useEffect(() => {
    if (!share) return
    setSheetInitial(shareToTaskFields(share))
    setSheetOpen(true)
  }, [share])

  useEffect(() => {
    if (!focusTaskId) return
    setDetailTaskId(focusTaskId)
    onFocusTaskConsumed?.()
  }, [focusTaskId, onFocusTaskConsumed])

  const closeSheet = useCallback(() => {
    setSheetOpen(false)
    setSheetInitial(null)
    onShareConsumed?.()
  }, [onShareConsumed])

  const columns = useColumnsState()
  const { narrow900, narrow600, phone } = useNarrowBreakpoints()
  const { view, setSort, setGroup, toggleFilter, clearFilters } = useViewState()

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
    () => getVisibleColumns(columns.hidden, { narrow900, narrow600, phone, panelOpen: Boolean(detailTaskId) }),
    [columns.hidden, narrow900, narrow600, phone, detailTaskId]
  )
  const gridTemplateColumns = useMemo(
    () => buildGridTemplate(visibleColumns, columns.widths, { phone }),
    [visibleColumns, columns.widths, phone]
  )

  const beginRequest = useRequestGuard()
  const fetchTasks = useCallback(async () => {
    const isCurrent = beginRequest()
    setError(null)
    try {
      const res = await api.listTasks(MY_TASKS_QUERY)
      if (isCurrent()) setTasks(res.tasks || [])
    } catch (err) {
      if (isCurrent()) setError(err.message || 'Could not load tasks.')
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [api, beginRequest])

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
    setInlineAdd({ groupId, dueAt, position })
  }, [ensureExpanded])

  const closeInlineAdd = useCallback(() => setInlineAdd(null), [])

  const handleAddTaskClick = useCallback(() => {
    const dueBounds = getDueBounds()
    if (view.group === 'due') {
      openInlineAdd('today', dueBounds.today, 'top')
    } else {
      setInlineAdd({ groupId: null, dueAt: dueBounds.today, position: 'top' })
    }
  }, [view.group, openInlineAdd])

  const submitInlineAdd = useCallback(async (title) => {
    const payload = { title }
    if (inlineAdd?.dueAt) payload.dueAt = inlineAdd.dueAt
    await api.createTask(payload)
    await fetchTasks()
    setInlineAdd(null)
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
        await api.completeTask(task.id)
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
  const filteredTasks = applyFilters(tasks, view.filters, goalWork, states)
  const sortedTasks = sortTasks(filteredTasks, view.sort, projectNameById)

  const commonRowProps = {
    dueBounds,
    projectNameById,
    projectOptions,
    visibleColumns,
    gridTemplateColumns,
    phone,
    pendingIds,
    openTaskId: detailTaskId,
    onToggleComplete: handleToggleComplete,
    onOpenTask: setDetailTaskId,
    onQuickUpdate: handleQuickUpdate,
  }

  let content = null
  if (!listLoading) {
    if (view.group === 'due') {
      const groups = groupTasks(sortedTasks, dueBounds)
      content = GROUP_ORDER.map((g) => {
        const groupTasksList = groups[g.id]
        if (!g.alwaysShow && groupTasksList.length === 0) return null
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
      content = groupByProject(sortedTasks, projectNameById).map((g) => (
        <TaskGroupSection
          key={g.id}
          title={g.label}
          tasks={g.tasks}
          collapsed={isCollapsed('project', g.id)}
          onToggleCollapse={() => toggleGroup('project', g.id)}
          {...commonRowProps}
        />
      ))
    } else if (view.group === 'priority') {
      content = groupByPriority(sortedTasks).map((g) => (
        <TaskGroupSection
          key={g.id}
          title={g.label}
          tasks={g.tasks}
          collapsed={isCollapsed('priority', g.id)}
          onToggleCollapse={() => toggleGroup('priority', g.id)}
          {...commonRowProps}
        />
      ))
    } else {
      // 'none': a flat, ungrouped list.
      content = (
        <div className="surface flush-last" style={{ overflow: 'hidden' }}>
          {sortedTasks.map((task, index) => (
            <TaskRow
              key={task.id}
              task={task}
              striped={index % 2 === 1}
              projectName={projectNameById.get(task.projectId)}
              projectOptions={projectOptions}
              visibleColumns={visibleColumns}
              gridTemplateColumns={gridTemplateColumns}
              phone={phone}
              dueBounds={dueBounds}
              pending={pendingIds.has(task.id)}
              open={task.id === detailTaskId}
              onToggleComplete={handleToggleComplete}
              onOpen={setDetailTaskId}
              onQuickUpdate={handleQuickUpdate}
            />
          ))}
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

        {/* Column header bar, then each group as its own panel with a gap between. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* The page-colored band keeps scrolled panels from peeking out
              around the header's rounded corners while it is stuck. */}
          <div style={{ position: 'sticky', top: 56, zIndex: 10, background: 'var(--bg)', padding: '8px 0', margin: '-8px 0' }}>
            <div
              className="mytasks-grid surface"
              style={{
                background: 'var(--bg3)',
                minHeight: 44,
                alignItems: 'stretch',
                fontSize: 13,
                color: 'var(--t2)',
                gridTemplateColumns,
              }}
            >
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

          {inlineAdd?.groupId === null && (
            <div className="surface" style={{ overflow: 'hidden' }}>
              <InlineTaskInput gridTemplateColumns={gridTemplateColumns} onSubmit={submitInlineAdd} onCancel={closeInlineAdd} />
            </div>
          )}

          {listLoading ? <Loading label="Loading tasks…" /> : content}
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
        initial={sheetInitial}
        projects={projectOptions}
        openButtonRef={fabRef}
      />
    </div>
  )
}

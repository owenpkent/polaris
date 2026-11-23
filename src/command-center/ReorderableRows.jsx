import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { dropMarkClass, useReorderDrag } from './useReorderDrag'
import { planReorder, stepSlot, tieRun } from './reorder'

// The rows of the list, each with what its handle needs to move it. A
// ReorderScope wraps every group of the list: it owns the one drag (useReorderDrag.js) and the
// handle's moves, which end in `onReorder(plan)` for a move inside a group, where the plan
// (reorder.js) names the tasks and the positions that put the row in its new slot, or in
// `onMoveAcross({ task, fromId, toId, slot })` for a move into another group (only with
// `crossGroup`, the due-date grouping, where the group is the row's date). `groups` are
// `{ id, label, tasks, closed }` in the order shown, empty ones too, since a drop on an empty or
// collapsed group goes to its top. A `closed` group (Overdue) takes no row from another group: a
// drag passes over it as if it were not there, and the arrow keys skip it. A move is read out for a screen reader, since the row keeps its handle
// and its focus and nothing else says it moved.
//
// `tie` is null under the manual sort, where any row can go anywhere in its group. Under another
// sort it says which rows the sort ranks the same (viewState.sortTie): a row moves only among the
// run of rows it ties with, since the sort would put it straight back anywhere else, and a move
// into another group is a drop on the group as a whole (`drag.whole`), which the sort places.
const ScopeContext = createContext(null)

/** The scope the rows are in, or null; a group's header reads `drag` from it to mark a drop on it. */
export function useReorderScope() {
  return useContext(ScopeContext)
}

export function ReorderScope({ enabled, crossGroup = false, tie = null, groups, onReorder, onMoveAcross, onDragChange, onMoved, children }) {
  const [notice, setNotice] = useState('')
  const groupsRef = useRef(groups)
  groupsRef.current = groups
  const isClosed = useCallback((id) => groupsRef.current.some((g) => g.id === id && g.closed), [])

  const moveAcross = useCallback((task, fromId, toId, slot) => {
    const target = groupsRef.current.find((g) => g.id === toId)
    if (!target || (target.closed && fromId !== toId)) return
    setNotice(`${task.title} moved to ${target.label ?? target.id}`)
    onMoveAcross?.({ task, fromId, toId, slot })
  }, [onMoveAcross])

  const commit = useCallback((task, fromId, toId, slot) => {
    if (fromId !== toId) {
      if (crossGroup) moveAcross(task, fromId, toId, slot)
      return
    }
    const tasks = groupsRef.current.find((g) => g.id === fromId)?.tasks ?? []
    const run = tieRun(tasks, tasks.findIndex((t) => t.id === task.id), tie)
    if (!run) return
    const rows = tasks.slice(run.start, run.end)
    const plan = planReorder(rows, task.id, Math.max(run.start, Math.min(run.end, slot)) - run.start)
    if (!plan) return
    setNotice(`${task.title} moved to ${run.start + plan.index + 1} of ${tasks.length}`)
    onMoved?.(task.id)
    onReorder(plan)
  }, [crossGroup, tie, moveAcross, onReorder, onMoved])

  const { containerRef, drag, startDrag, wasDrag } = useReorderDrag({ enabled, crossGroup, whole: tie !== null, isClosed, onRelease: commit })

  const dragging = drag !== null
  useEffect(() => { onDragChange?.(dragging) }, [dragging, onDragChange])

  const value = useMemo(
    () => ({ enabled, crossGroup, tie, groups, drag, startDrag, wasDrag, commit, moveAcross }),
    [enabled, crossGroup, tie, groups, drag, startDrag, wasDrag, commit, moveAcross],
  )

  return (
    <ScopeContext.Provider value={value}>
      <div ref={containerRef} className={drag ? 'reorder-rows is-reordering' : 'reorder-rows'}>
        {children}
        {enabled && <div role="status" aria-live="polite" className="sr-only">{notice}</div>}
      </div>
    </ScopeContext.Provider>
  )
}

// One group's rows, from its top-level tasks in the order shown; subtasks shown under a row
// (TaskTree) are not slots. `children(task, reorder, rowClass)` renders each row, with `reorder`
// null when the rows cannot be moved; its `index` and `count` are the row's place in its run of
// tied rows (the whole group under the manual sort). Outside a ReorderScope it makes its own, so a
// flat list needs nothing around it.
export default function ReorderableRows({ groupId = '_all', tasks, enabled, onReorder, children }) {
  const scope = useContext(ScopeContext)
  const own = useMemo(() => [{ id: groupId, tasks }], [groupId, tasks])
  if (!scope) {
    return (
      <ReorderScope enabled={enabled} groups={own} onReorder={onReorder}>
        <div data-reorder-group={groupId}>
          <Rows groupId={groupId} tasks={tasks}>{children}</Rows>
        </div>
      </ReorderScope>
    )
  }
  return <Rows groupId={groupId} tasks={tasks}>{children}</Rows>
}

const QUICK_GROUPS = ['today', 'tomorrow', 'noDue']

function Rows({ groupId, tasks, children }) {
  const { enabled, crossGroup, tie, groups, drag, startDrag, wasDrag, commit, moveAcross } = useContext(ScopeContext)
  const groupIndex = groups.findIndex((g) => g.id === groupId)
  const runs = useMemo(() => tasks.map((_, i) => tieRun(tasks, i, tie)), [tasks, tie])

  // The handle knows its place in its run; the drag and the drop marks go by its place in the group.
  const onPointerDown = useCallback((e, task) => {
    const index = tasks.findIndex((t) => t.id === task.id)
    if (index !== -1) startDrag(e, task, index, groupId, runs[index])
  }, [startDrag, groupId, tasks, runs])
  const onMove = useCallback((task, action) => {
    const index = tasks.findIndex((t) => t.id === task.id)
    if (index === -1) return
    const run = runs[index]
    // Past the first or last row of a group the row goes to the bottom of the group before, or the
    // top of the one after, and takes that group's date (MyTasksTab.moveAcross). A closed group is
    // skipped; with no open group that way the move stays inside the group.
    if (crossGroup && action === 'up' && index === 0 && groupIndex > 0) {
      const to = groups.slice(0, groupIndex).reverse().find((g) => !g.closed)
      if (to) {
        moveAcross(task, groupId, to.id, to.tasks.length)
        return
      }
    }
    if (crossGroup && action === 'down' && index === tasks.length - 1 && groupIndex !== -1) {
      const to = groups.slice(groupIndex + 1).find((g) => !g.closed)
      if (to) {
        moveAcross(task, groupId, to.id, 0)
        return
      }
    }
    commit(task, groupId, groupId, run.start + stepSlot(index - run.start, run.end - run.start, action))
  }, [tasks, runs, crossGroup, groups, groupIndex, groupId, commit, moveAcross])
  const onMoveTo = useCallback((task, toId) => moveAcross(task, groupId, toId, 0), [moveAcross, groupId])

  return tasks.map((task, index) => children(
    task,
    enabled
      ? {
          index: index - runs[index].start,
          count: runs[index].end - runs[index].start,
          groupId,
          onPointerDown,
          onMove,
          wasDrag,
          // What the handle's menu adds under the due-date grouping: moves to a day.
          quick: crossGroup ? { groups: QUICK_GROUPS.filter((id) => groups.some((g) => g.id === id)), onMoveTo } : null,
        }
      : null,
    enabled ? dropMarkClass(drag, groupId, index, tasks.length) : '',
  ))
}

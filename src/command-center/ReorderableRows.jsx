import { useCallback, useState } from 'react'
import { dropMarkClass, useReorderDrag } from './useReorderDrag'
import { planReorder, stepSlot } from './reorder'

// The rows of one group of the list, each with what its handle needs to move it: the drag
// (useReorderDrag.js) and the menu's moves (ReorderHandle.jsx) both end in `onReorder(plan)`,
// where the plan (reorder.js) names the tasks and the positions that put the row in its new
// slot. `tasks` are the group's top-level rows in the order shown; subtasks shown under a row
// (TaskTree) are not slots. `children(task, reorder, rowClass)` renders each row, with
// `reorder` null when the list is not under the manual sort. A move is read out for a screen
// reader, since the row keeps its handle and its focus and nothing else says it moved.
export default function ReorderableRows({ tasks, enabled, onReorder, children }) {
  const [notice, setNotice] = useState('')

  const commit = useCallback((task, slot) => {
    const plan = planReorder(tasks, task.id, slot)
    if (!plan) return
    setNotice(`${task.title} moved to ${plan.index + 1} of ${tasks.length}`)
    onReorder(plan)
  }, [tasks, onReorder])

  const { containerRef, drag, startDrag, wasDrag } = useReorderDrag({ enabled, onRelease: commit })
  const onMove = useCallback((task, action) => {
    const index = tasks.findIndex((t) => t.id === task.id)
    if (index === -1) return
    commit(task, stepSlot(index, tasks.length, action))
  }, [tasks, commit])

  return (
    <div ref={containerRef} className={drag ? 'reorder-rows is-reordering' : 'reorder-rows'}>
      {tasks.map((task, index) => children(
        task,
        enabled ? { index, count: tasks.length, onPointerDown: startDrag, onMove, wasDrag } : null,
        enabled ? dropMarkClass(drag, index, tasks.length) : '',
      ))}
      {enabled && <div role="status" aria-live="polite" className="sr-only">{notice}</div>}
    </div>
  )
}

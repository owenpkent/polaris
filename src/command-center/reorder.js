// The arithmetic behind dragging a row to a new place in the list's manual sort (viewState.js,
// ReorderHandle.jsx, useReorderDrag.js). Nothing here touches the DOM or the API: a plan says
// which tasks get which position, and MyTasksTab sends it through api.moveTask.
//
// A task's position is one number across every project and section (Store.nextPosition). A
// move sets the dragged task's number to the midpoint of its new neighbours', so one request
// moves it and nothing else changes. The gap halves with every drop into the same slot, so once
// it is used up the group is renumbered whole, in its new order, with a step of one.

export const DRAG_THRESHOLD_PX = 4

/** A number strictly between two neighbours, or past the one that exists. */
export function positionBetween(prev, next) {
  if (prev === undefined && next === undefined) return 0
  if (prev === undefined) return next - 1
  if (next === undefined) return prev + 1
  return (prev + next) / 2
}

/**
 * The slot the pointer is over, for rows laid out top to bottom: 0 before the first row, n
 * after the last, and i for the gap above row i. The upper half of a row drops before it, the
 * lower half after it.
 */
export function dropIndexAt(rects, y) {
  for (let i = 0; i < rects.length; i += 1) {
    const r = rects[i]
    if (y < r.top + r.height / 2) return i
  }
  return rects.length
}

/** The slot a row at `index` of `count` moves to for the handle's menu and arrow keys. */
export function stepSlot(index, count, action) {
  if (action === 'up') return Math.max(0, index - 1)
  if (action === 'down') return Math.min(count, index + 2)
  if (action === 'top') return 0
  if (action === 'bottom') return count
  return index
}

/**
 * What to send so `taskId` lands in slot `toSlot` of `tasks` (the group's rows in the order
 * shown). null when it is already there. Otherwise `updates`, each a task id and its new
 * position: one entry for the dragged task, or every row of the group when a midpoint can no
 * longer be told apart from its neighbours. `order` is the ids in their new order, for the
 * announcement and the tests.
 */
export function planReorder(tasks, taskId, toSlot) {
  const from = tasks.findIndex((t) => t.id === taskId)
  if (from === -1) return null
  const slot = Math.max(0, Math.min(tasks.length, toSlot))
  if (slot === from || slot === from + 1) return null
  const others = tasks.filter((t) => t.id !== taskId)
  const at = slot > from ? slot - 1 : slot
  // A task with no position yet (an older copy in the offline cache) sits at 0, as the sort reads it.
  const prev = others[at - 1] === undefined ? undefined : (others[at - 1].position ?? 0)
  const next = others[at] === undefined ? undefined : (others[at].position ?? 0)
  const position = positionBetween(prev, next)
  const order = [...others.slice(0, at), tasks[from], ...others.slice(at)]
  const fits = (prev === undefined || prev < position) && (next === undefined || position < next)
  if (fits) return { updates: [{ id: taskId, position }], order: order.map((t) => t.id), index: at }
  // The gap is used up: number the whole group again from where it starts.
  const start = Math.floor(Math.min(...tasks.map((t) => t.position ?? 0)))
  return { updates: order.map((t, i) => ({ id: t.id, position: start + i })), order: order.map((t) => t.id), index: at }
}

/**
 * Where a held row would land, for a list of groups laid out top to bottom. `layout` is each
 * group's `{ id, bottom, headerBottom, rows }` (the section's bottom edge, the header's, and the
 * rects of its top-level rows), `y` the pointer, and `onlyGroup` an id that confines the drop to
 * one group (the groupings that do not change a date). The result is `{ groupId, slot, header }`:
 * the group under the pointer, the gap within it (dropIndexAt), and whether the pointer is on its
 * header, which drops at the top. A collapsed or empty group has no rows, so its slot is 0.
 */
export function dropTargetAt(layout, y, onlyGroup = null) {
  const groups = onlyGroup === null ? layout : layout.filter((g) => g.id === onlyGroup)
  if (groups.length === 0) return null
  const group = groups.find((g) => y < g.bottom) ?? groups[groups.length - 1]
  const header = y < group.headerBottom
  return { groupId: group.id, slot: header ? 0 : dropIndexAt(group.rows, y), header }
}

/**
 * What to send so `taskId` lands in slot `slot` of another group whose rows are `tasks` (the task
 * is not among them). One position for the task, or every row of the group and the task when the
 * midpoint cannot be told apart from its neighbours, as planReorder does. `index` is the slot.
 */
export function planInsert(tasks, taskId, slot) {
  const at = Math.max(0, Math.min(tasks.length, slot))
  const prev = tasks[at - 1] === undefined ? undefined : (tasks[at - 1].position ?? 0)
  const next = tasks[at] === undefined ? undefined : (tasks[at].position ?? 0)
  const position = positionBetween(prev, next)
  const fits = (prev === undefined || prev < position) && (next === undefined || position < next)
  const order = [...tasks.slice(0, at).map((t) => t.id), taskId, ...tasks.slice(at).map((t) => t.id)]
  if (fits) return { updates: [{ id: taskId, position }], order, index: at }
  const start = Math.floor(Math.min(...tasks.map((t) => t.position ?? 0)))
  return { updates: order.map((id, i) => ({ id, position: start + i })), order, index: at }
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { DRAG_THRESHOLD_PX, dropTargetAt } from './reorder'

const EDGE_PX = 72
const SCROLL_STEP_PX = 16

// The pointer side of dragging a row (reorder.js has the arithmetic, ReorderHandle.jsx the
// button). The container holds the group's rows, each marked data-task-id; the handle calls
// `startDrag` on pointerdown and the hook follows the pointer from there with pointer capture, so
// the drag survives leaving the row, the list, or the window. The container holds every group of
// the list, each marked data-reorder-group with a data-reorder-header and its rows. `drag` is null
// at rest and { id, index, group, slot, target, header } while a row is held: where it came from
// (its group and index) and what the pointer is over (dropTargetAt): the target group, the gap in
// it, and whether the header. With `crossGroup` off the target stays in the row's own group, and
// with it on a group `isClosed(id)` names is left out of the layout unless the row came from it,
// so the pointer over it lands at the top of the open group below (or the end of the one above). Esc
// drops the row where it was. A press that never moves past the threshold is a click, which
// the handle turns into its menu; `wasDrag()` tells it which one just ended.
export function useReorderDrag({ enabled, crossGroup = false, isClosed = null, onRelease }) {
  const containerRef = useRef(null)
  const [drag, setDrag] = useState(null)
  const live = useRef(null)
  const lastWasDrag = useRef(false)

  // The page's cursor and selection while a row is held.
  useEffect(() => {
    if (!drag) return undefined
    document.body.classList.add('is-reordering')
    return () => document.body.classList.remove('is-reordering')
  }, [drag])

  // Leaving the view mid-drag ends the drag, so the held row's copy does not stay on the page.
  const stopDrag = useRef(null)
  useEffect(() => () => stopDrag.current?.(), [])

  const startDrag = useCallback((e, task, index, group) => {
    if (!enabled || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return
    const handle = e.currentTarget
    const pointerId = e.pointerId
    const startY = e.clientY
    let active = false
    lastWasDrag.current = false
    // The list as it would be with no gap open. While a row is held, the rows part where it would
    // land (the margin on .is-drop-before or .is-drop-after, index.css), which moves everything
    // below the gap down by its height; measured as it is, the pointer would chase the gap it
    // opened. So everything below a gap is read back up by the margin it has right now. That means
    // every row's margin, not only the marked row's: the gap the pointer just left takes 120ms to
    // close, and until it has, it still moves what is under it.
    const readLayout = () => {
      const root = containerRef.current
      const sections = Array.from(root?.querySelectorAll('[data-reorder-group]') ?? [])
        .filter((el) => { const id = el.getAttribute('data-reorder-group'); return id === group || !isClosed?.(id) })
      const gaps = []
      for (const row of root?.querySelectorAll('[data-task-id]') ?? []) {
        const { marginTop, marginBottom } = getComputedStyle(row)
        const r = row.getBoundingClientRect()
        // The margin above a row moves the row itself, and the one below it only what follows.
        if (parseFloat(marginTop)) gaps.push({ moves: (y) => y >= r.top, size: parseFloat(marginTop) })
        if (parseFloat(marginBottom)) gaps.push({ moves: (y) => y > r.bottom, size: parseFloat(marginBottom) })
      }
      const back = (y) => gaps.reduce((rest, gap) => (gap.moves(y) ? rest - gap.size : rest), y)
      return sections.map((el) => ({
        id: el.getAttribute('data-reorder-group'),
        bottom: back(el.getBoundingClientRect().bottom),
        headerBottom: back(el.querySelector('[data-reorder-header]')?.getBoundingClientRect().bottom ?? -Infinity),
        rows: Array.from(el.querySelectorAll('[data-task-id]')).map((row) => {
          const r = row.getBoundingClientRect()
          return { top: back(r.top), height: r.height }
        }),
      }))
    }

    // The held row lifts out of the list: a copy of it, raised with a shadow, follows the pointer,
    // while the row itself stays in place, faded, as the gap it came from. The copy is only a
    // picture (aria-hidden, inert, no ids), so nothing in it can be focused or read twice.
    const row = handle.closest?.('[data-task-id]')
    let ghost = null
    let grabOffset = 0
    const lift = (y) => {
      if (!row) return
      const rect = row.getBoundingClientRect()
      grabOffset = y - rect.top
      ghost = row.cloneNode(true)
      for (const el of [ghost, ...ghost.querySelectorAll('[id]')]) el.removeAttribute('id')
      for (const el of [ghost, ...ghost.querySelectorAll('[data-task-id], [data-subtask-id], [data-testid]')]) {
        el.removeAttribute('data-task-id')
        el.removeAttribute('data-subtask-id')
        el.removeAttribute('data-testid')
      }
      ghost.setAttribute('aria-hidden', 'true')
      ghost.inert = true
      ghost.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after')
      ghost.classList.add('reorder-ghost')
      Object.assign(ghost.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` })
      document.body.appendChild(ghost)
      // The gap the rows open where it would land is the held row's own height.
      document.body.style.setProperty('--drag-gap', `${rect.height}px`)
    }
    const follow = (y) => { if (ghost) ghost.style.top = `${y - grabOffset}px` }
    const drop = () => {
      ghost?.remove()
      ghost = null
      document.body.style.removeProperty('--drag-gap')
    }

    const onMove = (ev) => {
      if (!active) {
        if (Math.abs(ev.clientY - startY) < DRAG_THRESHOLD_PX) return
        active = true
        lastWasDrag.current = true
        lift(startY)
      }
      ev.preventDefault()
      follow(ev.clientY)
      const hit = dropTargetAt(readLayout(), ev.clientY, crossGroup ? null : group)
      if (!hit) return
      live.current = { id: task.id, index, group, slot: hit.slot, target: hit.groupId, header: hit.header }
      setDrag(live.current)
      // Near the top or bottom of the window the page scrolls, so a long list can be crossed.
      if (ev.clientY < EDGE_PX) window.scrollBy(0, -SCROLL_STEP_PX)
      else if (ev.clientY > window.innerHeight - EDGE_PX) window.scrollBy(0, SCROLL_STEP_PX)
    }
    const stop = () => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onCancel)
      document.removeEventListener('lostpointercapture', onLost)
      window.removeEventListener('keydown', onKey, true)
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId)
      drop()
      live.current = null
      stopDrag.current = null
      setDrag(null)
    }
    const onUp = () => {
      const result = live.current
      stop()
      if (active && result) onRelease(task, result.group, result.target, result.slot)
    }
    const onCancel = () => stop()
    // On the document, because a handle taken out of the page (a refresh dropped the task) loses its
    // capture there, and no other pointer event would ever reach it to end the drag.
    const onLost = (ev) => { if (ev.pointerId === pointerId) stop() }
    // Esc drops the row where it was (listed in the keyboard legend as closing what is open).
    function onKey(ev) {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      ev.stopPropagation()
      stop()
    }

    handle.setPointerCapture?.(pointerId)
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onCancel)
    document.addEventListener('lostpointercapture', onLost)
    window.addEventListener('keydown', onKey, true)
    stopDrag.current = stop
  }, [enabled, crossGroup, isClosed, onRelease])

  const wasDrag = useCallback(() => {
    const was = lastWasDrag.current
    lastWasDrag.current = false
    return was
  }, [])

  return { containerRef, drag, startDrag, wasDrag }
}

/**
 * The class a row at `index` of `count` in group `groupId` wears while `drag` is on: held, or
 * marked as the drop slot when it is in the group the pointer is over.
 */
export function dropMarkClass(drag, groupId, index, count) {
  if (!drag) return ''
  const own = drag.group === groupId
  if (own && drag.id !== undefined && index === drag.index) return ' is-dragging'
  if (drag.target !== groupId) return ''
  // The slots either side of the held row would leave it where it is, so they show nothing.
  if (own && (drag.slot === drag.index || drag.slot === drag.index + 1)) return ''
  if (drag.slot === index) return ' is-drop-before'
  if (drag.slot === count && index === count - 1) return ' is-drop-after'
  return ''
}

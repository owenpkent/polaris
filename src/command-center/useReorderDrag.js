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
// it, and whether the header. With `crossGroup` off the target stays in the row's own group. Esc
// drops the row where it was. A press that never moves past the threshold is a click, which
// the handle turns into its menu; `wasDrag()` tells it which one just ended.
export function useReorderDrag({ enabled, crossGroup = false, onRelease }) {
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

  const startDrag = useCallback((e, task, index, group) => {
    if (!enabled || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return
    const handle = e.currentTarget
    const pointerId = e.pointerId
    const startY = e.clientY
    let active = false
    lastWasDrag.current = false
    const readLayout = () => {
      const sections = Array.from(containerRef.current?.querySelectorAll('[data-reorder-group]') ?? [])
      return sections.map((el) => ({
        id: el.getAttribute('data-reorder-group'),
        bottom: el.getBoundingClientRect().bottom,
        headerBottom: el.querySelector('[data-reorder-header]')?.getBoundingClientRect().bottom ?? -Infinity,
        rows: Array.from(el.querySelectorAll('[data-task-id]')).map((r) => r.getBoundingClientRect()),
      }))
    }

    const onMove = (ev) => {
      if (!active) {
        if (Math.abs(ev.clientY - startY) < DRAG_THRESHOLD_PX) return
        active = true
        lastWasDrag.current = true
      }
      ev.preventDefault()
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
      handle.removeEventListener('lostpointercapture', onCancel)
      window.removeEventListener('keydown', onKey, true)
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId)
      live.current = null
      setDrag(null)
    }
    const onUp = () => {
      const result = live.current
      stop()
      if (active && result) onRelease(task, result.group, result.target, result.slot)
    }
    const onCancel = () => stop()
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
    handle.addEventListener('lostpointercapture', onCancel)
    window.addEventListener('keydown', onKey, true)
  }, [enabled, crossGroup, onRelease])

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

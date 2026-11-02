import { useCallback, useEffect, useRef, useState } from 'react'
import { DRAG_THRESHOLD_PX, dropIndexAt } from './reorder'

const EDGE_PX = 72
const SCROLL_STEP_PX = 16

// The pointer side of dragging a row (reorder.js has the arithmetic, ReorderHandle.jsx the
// button). The container holds the group's rows, each marked data-task-id; the handle calls
// `startDrag` on pointerdown and the hook follows the pointer from there with pointer capture, so
// the drag survives leaving the row, the list, or the window. `drag` is null at rest and
// { id, index, slot } while a row is held, where slot is the gap the pointer is over (dropIndexAt).
// Esc drops the row where it was. A press that never moves past the threshold is a click, which
// the handle turns into its menu; `wasDrag()` tells it which one just ended.
export function useReorderDrag({ enabled, onRelease }) {
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

  const startDrag = useCallback((e, task, index) => {
    if (!enabled || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return
    const handle = e.currentTarget
    const pointerId = e.pointerId
    const startY = e.clientY
    let active = false
    lastWasDrag.current = false
    const rowRects = () => Array.from(containerRef.current?.querySelectorAll('[data-task-id]') ?? []).map((el) => el.getBoundingClientRect())

    const onMove = (ev) => {
      if (!active) {
        if (Math.abs(ev.clientY - startY) < DRAG_THRESHOLD_PX) return
        active = true
        lastWasDrag.current = true
      }
      ev.preventDefault()
      const slot = dropIndexAt(rowRects(), ev.clientY)
      live.current = { id: task.id, index, slot }
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
      if (active && result) onRelease(task, result.slot)
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
  }, [enabled, onRelease])

  const wasDrag = useCallback(() => {
    const was = lastWasDrag.current
    lastWasDrag.current = false
    return was
  }, [])

  return { containerRef, drag, startDrag, wasDrag }
}

/** The class a row at `index` of `count` wears while `drag` is on: held, or marked as the drop slot. */
export function dropMarkClass(drag, index, count) {
  if (!drag) return ''
  if (drag.id !== undefined && index === drag.index) return ' is-dragging'
  // The slots either side of the held row would leave it where it is, so they show nothing.
  if (drag.slot === drag.index || drag.slot === drag.index + 1) return ''
  if (drag.slot === index) return ' is-drop-before'
  if (drag.slot === count && index === count - 1) return ' is-drop-after'
  return ''
}

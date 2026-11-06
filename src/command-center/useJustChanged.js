import { useEffect, useRef, useSyncExternalStore } from 'react'

// Orientation after the owner's own change: the task they just added, moved, or edited is tinted
// where it now is (.just-changed in index.css) and scrolled into view if it left the screen. A
// handler calls markChanged(taskId); the row or card calls useJustChanged(taskId). Only handlers
// in this tab call markChanged, so a change that arrives by polling (another device, an agent)
// never flashes. Focus is never moved here.
export const JUST_CHANGED_MS = 1200

const active = new Set()
const timers = new Map()
const listeners = new Set()

function emit() {
  listeners.forEach((fn) => fn())
}

function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function markChanged(id) {
  if (!id) return
  clearTimeout(timers.get(id))
  active.add(id)
  timers.set(id, setTimeout(() => {
    timers.delete(id)
    active.delete(id)
    emit()
  }, JUST_CHANGED_MS))
  emit()
}

// For tests: forget every mark.
export function clearChanged() {
  timers.forEach((t) => clearTimeout(t))
  timers.clear()
  active.clear()
  emit()
}

function reducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

// Whether the whole element shows: inside the viewport and inside every ancestor that clips it,
// such as the Board's lanes, which scroll sideways.
function fullyInView(el) {
  const rect = el.getBoundingClientRect()
  let left = 0
  let top = 0
  let right = window.innerWidth
  let bottom = window.innerHeight
  for (let n = el.parentElement; n; n = n.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(n)
    if (overflowX === 'visible' && overflowY === 'visible') continue
    const box = n.getBoundingClientRect()
    if (overflowX !== 'visible') {
      left = Math.max(left, box.left)
      right = Math.min(right, box.right)
    }
    if (overflowY !== 'visible') {
      top = Math.max(top, box.top)
      bottom = Math.min(bottom, box.bottom)
    }
  }
  return rect.left >= left && rect.right <= right && rect.top >= top && rect.bottom <= bottom
}

// Returns { changed, ref }: put `ref` on the row's element and add 'just-changed' to its class
// while `changed`. A row that mounts after the mark (a new task, or one that moved to another
// group) is highlighted for what remains of the time.
export function useJustChanged(id) {
  const ref = useRef(null)
  const changed = useSyncExternalStore(subscribe, () => active.has(id), () => false)
  useEffect(() => {
    if (!changed) return
    const el = ref.current
    if (!el?.scrollIntoView) return
    if (fullyInView(el)) return
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' })
  }, [changed])
  return { changed, ref }
}

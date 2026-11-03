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
    const rect = el.getBoundingClientRect()
    if (rect.top >= 0 && rect.bottom <= window.innerHeight) return
    el.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' })
  }, [changed])
  return { changed, ref }
}

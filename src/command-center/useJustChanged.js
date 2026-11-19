import { useSyncExternalStore } from 'react'

// Orientation after the owner's own change: the task they just added, moved, or edited is tinted
// where it now is (.just-changed in index.css). A handler calls markChanged(taskId); the row or
// card calls useJustChanged(taskId). Only handlers in this tab call markChanged, so a change that
// arrives by polling (another device, an agent) never flashes. Focus and scroll are never moved here.
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

// True while the task's row or card should carry 'just-changed' in its class. A row that mounts
// after the mark (a new task, or one that moved to another group or lane) is tinted for what
// remains of the time. Nothing scrolls to it: a task that lands in another day's group or another
// lane stays where it lands, since following it there throws the owner out of where they were working.
export function useJustChanged(id) {
  return useSyncExternalStore(subscribe, () => active.has(id), () => false)
}

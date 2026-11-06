import { useSyncExternalStore } from 'react'

// The "Completed <task>" toast (UndoToast.jsx). The list and the board call showCompleted after a
// task is completed; a newer call replaces the one on screen. The undo callback is the caller's
// own reopen path, so nothing here talks to the server. It rejects when the reopen fails, and this
// store, not the tab, keeps that failure: the tab may be gone by then. A failure stays beside the
// current toast and never replaces it, since a reopen can fail after another task was completed.
const NONE = []
let toasts = NONE
let nextId = 1
const listeners = new Set()

function set(next) {
  toasts = next
  for (const l of listeners) l()
}

export function showCompleted(title, undo) {
  set([...toasts.filter((t) => t.failed), { id: nextId++, title: title || 'task', undo, failed: false }])
}

// Undo, or Retry after a failed one: the toast goes at once, and a failure comes back on its own.
export async function runUndo(toast) {
  dismissToast(toast.id)
  try {
    await toast.undo?.()
  } catch {
    const failed = { ...toast, id: nextId++, failed: true }
    // Failures sit above the current toast, so its Undo does not move under the pointer.
    set([...toasts.filter((t) => t.failed), failed, ...toasts.filter((t) => !t.failed)])
  }
}

export function dismissToast(id) {
  if (toasts.some((t) => t.id === id)) set(toasts.filter((t) => t.id !== id))
}

function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useUndoToasts() {
  return useSyncExternalStore(subscribe, () => toasts, () => NONE)
}

export function resetUndoToast() {
  set(NONE)
}

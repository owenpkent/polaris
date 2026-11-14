import { useSyncExternalStore } from 'react'

// The toast near the foot of the screen (UndoToast.jsx): "Completed <task>", which the list and the
// board show after a task is completed, or "Moved <task> to <where>" (showMoved). A newer toast
// replaces the one on screen. The undo callback is the caller's
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

// `nextDue` is the due date of the copy a repeating task made when it was completed, so the
// toast can say when it comes back: a copy due the day the done one was looks as if the done one
// never left. Queued offline there is no answer yet, and so no date.
export function showCompleted(title, undo, { nextDue = null } = {}) {
  show({ kind: 'completed', title: title || 'task', undo, nextDue })
}

// "Moved <task> to <where>", after the owner's own change sends a task to another group or lane,
// which nothing scrolls to (useJustChanged.js). `view` shows the task where it went and `undo`
// puts it back; both are the tab's own, so the tab clears its move toasts when it goes
// (dismissMoved), and a toast never acts on a list that is not there.
export function showMoved({ title, where, undo, view }) {
  show({ kind: 'moved', title: title || 'task', where, undo, view })
}

function show(toast) {
  set([...toasts.filter((t) => t.failed), { ...toast, id: nextId++, failed: false }])
}

// View: the toast goes, and the tab shows the task.
export function runView(toast) {
  dismissToast(toast.id)
  toast.view?.()
}

export function dismissMoved() {
  const gone = (t) => t.kind === 'moved' && !t.failed
  if (toasts.some(gone)) set(toasts.filter((t) => !gone(t)))
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

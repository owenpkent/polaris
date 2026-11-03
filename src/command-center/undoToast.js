import { useSyncExternalStore } from 'react'

// The one "Completed <task>" toast (UndoToast.jsx). The list and the board call showCompleted
// after a task is completed; a newer call replaces the one on screen. The undo callback is the
// caller's own reopen path, so nothing here talks to the server.
let current = null
let nextId = 1
const listeners = new Set()

function emit() {
  for (const l of listeners) l()
}

export function showCompleted(title, undo) {
  current = { id: nextId++, title: title || 'task', undo }
  emit()
}

export function dismissToast(id) {
  if (!current || (id !== undefined && current.id !== id)) return
  current = null
  emit()
}

function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useUndoToast() {
  return useSyncExternalStore(subscribe, () => current, () => null)
}

export function resetUndoToast() {
  current = null
  emit()
}

import { useSyncExternalStore } from 'react'

// Whether the Command Center server can be reached, as seen by the last request api.js made.
// It lives outside React so the fetch client can report into it, and every view reads the one
// value through useOfflineStatus. See initiatives/offline-clone.md.

const LAST_ONLINE_KEY = 'cc-last-online-v1'
const PERSIST_EVERY_MS = 30000

// After this long without the server the banner turns into a warning (decided 2026-09-21).
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000

function loadLastOnline() {
  try {
    const value = Number(localStorage.getItem(LAST_ONLINE_KEY))
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

// `pending` is how many offline edits are waiting in the outbox, and `lastSync` is what happened
// the last time they were sent (see outbox.js). Both are shown by the banner.
let state = { offline: false, lastOnlineAt: loadLastOnline(), pending: 0, lastSync: null }
let persistedAt = 0
const listeners = new Set()

function set(next) {
  state = next
  listeners.forEach((listener) => listener())
}

/** The server answered. Called by api.js on every response that is not a gateway error. */
export function markOnline(now = Date.now()) {
  if (now - persistedAt >= PERSIST_EVERY_MS) {
    persistedAt = now
    try { localStorage.setItem(LAST_ONLINE_KEY, String(now)) } catch { /* storage unavailable */ }
  }
  // The timestamp moves on every request, so only a change of mode is worth a re-render.
  if (state.offline) set({ ...state, offline: false, lastOnlineAt: now })
  else state.lastOnlineAt = now
}

/** The server could not be reached. */
export function markOffline() {
  if (!state.offline) set({ ...state, offline: true })
}

export function setPending(count) {
  if (count !== state.pending) set({ ...state, pending: count })
}

export function setLastSync(lastSync) {
  set({ ...state, lastSync })
}

export function getOfflineState() {
  return state
}

export function subscribeOffline(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Disconnect forgets the local copy, and with it when that copy was taken. */
export function resetOfflineStatus() {
  persistedAt = 0
  try { localStorage.removeItem(LAST_ONLINE_KEY) } catch { /* storage unavailable */ }
  set({ offline: false, lastOnlineAt: null, pending: 0, lastSync: null })
}

export function useOfflineStatus() {
  return useSyncExternalStore(subscribeOffline, getOfflineState, getOfflineState)
}

/**
 * True while the server cannot be reached: the one source a write control disables from. Task
 * edits and comments are the exception. They are queued by outbox.js, so their controls stay on.
 */
export function useOffline() {
  return useOfflineStatus().offline
}

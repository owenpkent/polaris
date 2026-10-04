import { useEffect, useSyncExternalStore } from 'react'

// The owner's default agent name, kept in one place for the whole window. Every open task panel
// shows "Assign to <name>", and without this each one would fetch GET /api/settings/agent on its
// own. Here one request is shared by every panel that mounts while it is in flight, the answer
// is refreshed each time a panel opens, and AgentSettings calls rememberDefaultAgentName after a
// save so a panel that is already open changes at once.
//
// The limit: a change made from another window or device is picked up the next time a panel
// opens. The server emits no event for a settings change, so nothing can push it sooner.

let cached = null
let inflight = null
// Bumped by every remember, so a read that started before a save cannot then undo it.
let version = 0
const subscribers = new Set()

function setName(name) {
  if (name === cached) return
  cached = name
  for (const notify of subscribers) notify()
}

function subscribe(notify) {
  subscribers.add(notify)
  return () => { subscribers.delete(notify) }
}

function getSnapshot() {
  return cached
}

function refresh(api) {
  if (inflight) return inflight
  const started = version
  inflight = Promise.resolve()
    .then(() => api.getAgentSettings())
    .then((res) => {
      if (version === started && res?.defaultAgentName) setName(res.defaultAgentName)
    })
    .catch(() => {
      // A failed read leaves the cache as it was; a click on Assign tries again.
    })
    .finally(() => { inflight = null })
  return inflight
}

export function useDefaultAgentName(api) {
  useEffect(() => { refresh(api) }, [api])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function rememberDefaultAgentName(name) {
  if (!name) return
  version += 1
  setName(name)
}

export function resetDefaultAgentNameCache() {
  cached = null
  inflight = null
  version = 0
  subscribers.clear()
}

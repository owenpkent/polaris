import { useCallback, useEffect, useRef, useState } from 'react'
import { useConnection } from './ConnectionContext'
import { useOffline } from './offlineStatus'

// What GET /api/update says (docs/update-proposal.md, section 4B): whether a newer signed release
// exists, whether the scheduled updater is installed, and the owner's current request. Polled
// every five minutes, and every thirty seconds while a request is waiting for the updater or
// being installed, so the panel follows it. Only while connected and reachable: there is no
// saved copy to fall back on, and a stale answer would show an update that is already in.
export const REFRESH_MS = 5 * 60_000
export const BUSY_REFRESH_MS = 30_000

const isBusy = (update) => update?.request?.state === 'pending' || update?.request?.state === 'picked_up'

export function useUpdateStatus() {
  const { connected, api } = useConnection()
  const offline = useOffline()
  const [update, setUpdate] = useState(null)
  const [error, setError] = useState(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const refresh = useCallback(async () => {
    if (!connected || offline) return null
    try {
      const res = await api.getUpdate()
      if (alive.current) { setUpdate(res ?? null); setError(null) }
      return res
    } catch (err) {
      if (alive.current) setError(err)
      return null
    }
  }, [connected, offline, api])

  // One fetch when the connection is there, then a timer. The two are separate effects so that a
  // change of pace (a request made or finished) resets the timer without asking again at once:
  // the answer that changed the pace is already on screen.
  useEffect(() => { refresh() }, [refresh])

  const busy = isBusy(update)
  useEffect(() => {
    if (!connected || offline) return undefined
    const timer = setInterval(refresh, busy ? BUSY_REFRESH_MS : REFRESH_MS)
    return () => clearInterval(timer)
  }, [connected, offline, refresh, busy])

  const request = useCallback(async (version) => {
    const res = await api.requestUpdate(version)
    if (alive.current && res?.request) setUpdate((u) => (u ? { ...u, request: res.request } : u))
    return res
  }, [api])

  const cancel = useCallback(async (id) => {
    const res = await api.cancelUpdateRequest(id)
    if (alive.current && res?.request) setUpdate((u) => (u ? { ...u, request: res.request } : u))
    return res
  }, [api])

  // Offline, or disconnected, there is nothing to show: the icon needs a live answer.
  return { update: connected && !offline ? update : null, error, refresh, request, cancel }
}

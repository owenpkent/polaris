import { useEffect, useRef } from 'react'
import { useConnection } from './ConnectionContext'
import { getOfflineState, subscribeOffline } from './offlineStatus'

// Polls /api/events every `intervalMs` while the owning tab is mounted (that
// only happens while it is the active, visible tab, since App.jsx unmounts
// inactive tabs). Polling pauses while the document itself is hidden and
// resumes immediately when it becomes visible again. `onChange` fires only
// when the server's newest event id actually moves, so callers can refetch
// their own data instead of polling their endpoint directly. Changes can come
// from anywhere that writes the database: the dashboard, the CLI, or an MCP
// client such as Claude Code.
export function useEventRefresh(onChange, { enabled = true, intervalMs = 10000 } = {}) {
  const { connected, api } = useConnection()
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!connected || !enabled) return undefined

    let cancelled = false
    let timer = null
    let cursor = null
    let useHead = true
    // Only the newest chain may act. Hiding and showing the tab during an in-flight fetch used to
    // start a second one: clearTimeout on an already-fired handle does nothing, and whichever
    // chain assigned `timer` last overwrote the other's handle, so cleanup could never clear it
    // and both polled forever, firing onChange twice per server change.
    let generation = 0

    async function tick(gen) {
      if (cancelled || gen !== generation) return
      if (!document.hidden) {
        try {
          // Only change detection is needed, so ask for at most one event and
          // compare the server's headId (its newest event overall). Using
          // lastId instead would take the baseline from the oldest capped page
          // on a large history and walk forward one page per poll, firing a
          // refetch every tick until it caught up. A server too old to send
          // headId falls back to that lastId cursor.
          const res = await api.getEvents(cursor ?? undefined, useHead ? 1 : undefined)
          // A response that arrived after this chain was superseded must not move the cursor:
          // the newer chain owns it, and a stale value there would hide a real change.
          if (!cancelled && gen === generation && res) {
            if (typeof res.headId !== 'number') useHead = false
            const next = useHead ? res.headId : res.lastId
            if (typeof next === 'number') {
              if (cursor !== null && next !== cursor) {
                onChangeRef.current?.()
              }
              cursor = next
            }
          }
        } catch {
          // Silent: the next tick retries. A visible fetch error would be
          // noisy for a background poll.
        }
      }
      if (!cancelled && gen === generation) timer = setTimeout(() => tick(gen), intervalMs)
    }

    function restart() {
      generation += 1
      clearTimeout(timer)
      timer = null
      tick(generation)
    }

    // Take the baseline right away rather than one interval after mount, so a
    // change made in the first few seconds is not folded into the baseline and
    // missed.
    restart()

    function handleVisibility() {
      if (!document.hidden) restart()
    }
    document.addEventListener('visibilitychange', handleVisibility)

    // A view that loaded while the server was unreachable is showing its local copy, and its
    // baseline here was taken after the server came back, so headId alone would never tell it
    // to reload. Coming back online is itself a change.
    let wasOffline = getOfflineState().offline
    const unsubscribeOffline = subscribeOffline(() => {
      const { offline } = getOfflineState()
      if (wasOffline && !offline && !cancelled) onChangeRef.current?.()
      wasOffline = offline
    })

    return () => {
      cancelled = true
      generation += 1
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', handleVisibility)
      unsubscribeOffline()
    }
  }, [connected, enabled, api, intervalMs])
}

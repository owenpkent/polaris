import { createContext, useContext, useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { createApiClient, ApiError, DEFAULT_BASE_URL } from './api'
import { cacheClear } from './offlineCache'
import { resetOfflineStatus, setLastSync } from './offlineStatus'
import { LOCAL_ORIGIN, adoptLocalOutbox, connectionOrigin, discardOutbox, refreshPendingCount } from './outbox'

const STORAGE_KEY = 'cc-connection-v1'

const ConnectionContext = createContext(null)

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function persist(data) {
  try {
    if (data) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // Ignore storage errors (private browsing, quota, disabled storage, etc).
  }
}

// scripts/mockup.mjs opens the dashboard with #cc-url=...&cc-token=... so it can connect without a
// paste. The fragment never reaches a server; it is removed from the address bar right away. Read once
// at module load: a render-time read would lose it, since StrictMode renders twice and the first
// render already cleared the fragment.
const HANDOFF = takeHandoff()

// A handoff may only point the dashboard at the machine it is already talking to. Anyone can put
// a fragment on a link, and without this a crafted one silently repoints the dashboard at another
// host, persists it over the saved connection, and keeps sending the owner's edits there until they
// notice and retype the real URL in Settings. Same-origin covers the tailnet; loopback covers
// mockup.mjs, which is what the fragment exists for.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export function isAllowedHandoffUrl(raw) {
  try {
    // No base url on purpose: a handoff has to name an absolute http(s) address. Resolving a
    // relative string against the current page would make any stray value look same-origin.
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return url.origin === window.location.origin || LOOPBACK_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

// A dashboard opened through the tailnet, from any origin that is not loopback, may be in front of
// a daemon with CC_TAILSCALE_LOGIN set, where the owner's Tailscale sign-in stands in for the token
// (docs/tailscale-identity.md). This is the origin to ask, or null on the host itself, where no
// proxy is in the path and the token is the way in.
export function tailnetOrigin(loc = window.location) {
  try {
    if (loc.protocol !== 'http:' && loc.protocol !== 'https:') return null
    if (LOOPBACK_HOSTS.has(loc.hostname)) return null
    return loc.origin
  } catch {
    return null
  }
}

function takeHandoff() {
  try {
    const params = new URLSearchParams(window.location.hash.slice(1))
    const token = params.get('cc-token')
    if (!token) return null
    const requested = params.get('cc-url')
    // Clear the fragment either way, so a refused handoff cannot be retried by reloading.
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
    if (requested && !isAllowedHandoffUrl(requested)) return null
    return { baseUrl: requested || DEFAULT_BASE_URL, token, connected: true }
  } catch {
    return null
  }
}

export function ConnectionProvider({ children }) {
  const initial = useRef(HANDOFF || loadSaved()).current

  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl || DEFAULT_BASE_URL)
  const [token, setToken] = useState(initial?.token || '')
  const [connected, setConnected] = useState(Boolean(initial?.connected))
  // A device that has never been connected, or was disconnected, starts in local mode: My tasks
  // works on this device and its task edits wait for the first server it connects to. A saved
  // connection whose test fails is not local: its copy belongs to that server, so it shows the
  // settings form instead.
  const [saved, setSaved] = useState(Boolean(initial))
  const local = !connected && !saved
  const [health, setHealth] = useState(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)

  const api = useMemo(() => createApiClient(baseUrl, token, { local }), [baseUrl, token, local])

  // `keepOnNetworkError` is for the silent re-check on load: a saved connection whose server
  // cannot be reached right now stays connected, so every tab opens on its local copy instead of
  // the settings form. A refused token still disconnects, and so does any test the owner runs themselves.
  // `silent` is for the Tailscale probe on load: a test the owner did not run shows no result either way.
  const testConnection = useCallback(async (candidateBaseUrl = baseUrl, candidateToken = token, { keepOnNetworkError = false, silent = false } = {}) => {
    setTesting(true)
    setTestResult(null)
    try {
      const client = createApiClient(candidateBaseUrl, candidateToken)
      const res = await client.health()
      // Edits wait for the server they were made against. Count the ones that belong to this
      // connection, so the next request sends them, and leave any other server's where they are.
      if (connectionOrigin(candidateBaseUrl) !== connectionOrigin(baseUrl)) setLastSync(null)
      // Edits made before this device had a connection go to the first server that answers.
      const adopted = await adoptLocalOutbox(candidateBaseUrl)
      await refreshPendingCount(candidateBaseUrl)
      setHealth(res)
      setConnected(true)
      setBaseUrl(candidateBaseUrl)
      setToken(candidateToken)
      setSaved(true)
      const sending = adopted > 0 ? ` Sending ${adopted} ${adopted === 1 ? 'change' : 'changes'} made before connecting.` : ''
      if (!silent) {
        setTestResult({
          ok: true,
          message: `Connected. Server v${res?.version ?? '?'} · today ${res?.today ?? ''} · ${res?.counts?.inbox ?? 0} in inbox.${sending}`,
        })
      }
      persist({ baseUrl: candidateBaseUrl, token: candidateToken, connected: true })
      return true
    } catch (err) {
      if (keepOnNetworkError && err instanceof ApiError && err.code === 'network_error') return false
      setConnected(false)
      const message = err instanceof ApiError ? err.message : 'Could not reach the server.'
      if (!silent) setTestResult({ ok: false, message })
      return false
    } finally {
      setTesting(false)
    }
  }, [baseUrl, token])

  const saveSettings = useCallback((nextBaseUrl, nextToken) => {
    return testConnection(nextBaseUrl, nextToken)
  }, [testConnection])

  const disconnect = useCallback(() => {
    setConnected(false)
    setHealth(null)
    setTestResult(null)
    persist(null)
    setSaved(false)
    // The local copy belongs to the connection: leaving it behind would show one server's tasks
    // under the next one's name.
    cacheClear()
    resetOfflineStatus()
    // Local mode follows: show what is still waiting from before any connection.
    discardOutbox(baseUrl).then(() => refreshPendingCount(LOCAL_ORIGIN))
  }, [baseUrl])

  // Best-effort silent re-check on first mount if a previous session was connected.
  useEffect(() => {
    // Edits queued in an earlier session are still waiting: count them so the first request
    // that reaches the server sends them.
    refreshPendingCount(initial ? initial.baseUrl : LOCAL_ORIGIN)
    if (initial?.connected && initial?.baseUrl) {
      testConnection(initial.baseUrl, initial.token || '', { keepOnNetworkError: true }).catch(() => {})
      return
    }
    // Nothing saved and no handoff: a page served through the tailnet asks its own origin, with
    // no token, whether the owner's Tailscale sign-in is enough. A 200 connects this device with
    // nothing stored on it. A 401 is the ordinary answer from a daemon without CC_TAILSCALE_LOGIN,
    // and is not shown: the owner did not run this test, and the connect form says what to do.
    const origin = initial ? null : tailnetOrigin()
    if (origin) testConnection(origin, '', { keepOnNetworkError: true, silent: true }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const value = useMemo(() => ({
    baseUrl,
    token,
    connected,
    local,
    health,
    testing,
    testResult,
    api,
    testConnection,
    saveSettings,
    disconnect,
  }), [baseUrl, token, connected, local, health, testing, testResult, api, testConnection, saveSettings, disconnect])

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>
}

export function useConnection() {
  const ctx = useContext(ConnectionContext)
  if (!ctx) throw new Error('useConnection must be used within ConnectionProvider')
  return ctx
}

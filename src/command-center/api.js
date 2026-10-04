// Small fetch client for the Polaris Command Center API.
// Base URL and token are supplied by ConnectionContext; every call here is a
// thin, typed-ish wrapper around one endpoint from the API contract.

import { cacheGet, cachePut } from './offlineCache'
import { getOfflineState, markOffline, markOnline } from './offlineStatus'
import { LOCAL_ORIGIN, connectionOrigin, deviceId, flushOutbox, newOpId, newTaskId, queueOfflineWrite } from './outbox'

const DEV_SERVER_DEFAULT = 'http://127.0.0.1:8788'

// Answers that must describe the server as it is right now, so they are never kept or replayed:
// health is the connection test, and events is the change detector.
const NEVER_CACHED = ['/api/health', '/api/events']

// A proxy in front of a stopped daemon (tailscale serve) answers for it with one of these, so
// they mean "unreachable" just as a failed fetch does.
const GATEWAY_STATUSES = new Set([502, 503, 504])

const UNREACHABLE_MESSAGE = 'Could not reach the Command Center server. Check the URL and make sure it is running.'
const OFFLINE_WRITE_MESSAGE = 'Offline. This change was not saved. Try again once the server is reachable.'
const LOCAL_MESSAGE = 'Not connected yet. Connect to a server to use this.'

// What a device with no connection shows before it has a copy: an empty task list, which the
// tasks it makes are added to. Every other read waits for a connection.
const LOCAL_EMPTY = { '/api/tasks': () => ({ tasks: [] }), '/api/projects': () => ({ projects: [] }) }

// The query My tasks loads with. useMirrorWarm requests the same one, so the copy it keeps is
// stored under the URL My tasks will ask for offline.
export const MY_TASKS_QUERY = { status: 'open,in_progress,waiting', orderBy: 'due', limit: 1000 }

// A production build is served by the Command Center server itself, so the API is on the
// page's own origin whatever host the page was opened from (127.0.0.1 on the PC, or the
// tailnet name through tailscale serve). The Vite dev server is not the Command Center
// server, so a dev build keeps the server's default address.
export function defaultBaseUrl() {
  if (import.meta.env.DEV || typeof window === 'undefined') return DEV_SERVER_DEFAULT
  return window.location.origin
}

export const DEFAULT_BASE_URL = defaultBaseUrl()

export class ApiError extends Error {
  constructor(message, code, status) {
    super(message)
    this.name = 'ApiError'
    this.code = code || 'unknown_error'
    this.status = status || 0
  }
}

function buildUrl(baseUrl, path, query) {
  const trimmed = (baseUrl || '').replace(/\/+$/, '')
  let url = `${trimmed}${path}`
  if (query) {
    const params = new URLSearchParams()
    Object.entries(query).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return
      params.set(key, String(value))
    })
    const qs = params.toString()
    if (qs) url += `?${qs}`
  }
  return url
}

// `offline` marks a task write that outbox.js can queue: { kind, taskId, opId, body }.
// `replay: false` is for the connection test: it may be aimed at a server that is not the
// connection yet, so it must not send anything.
// `local` is a device with no saved connection: nothing is fetched, and task writes are queued
// for whichever server it connects to first (outbox.js, LOCAL_ORIGIN).
async function request(baseUrl, token, path, { method = 'GET', body, query, offline, replay = true, local = false } = {}) {
  const url = buildUrl(baseUrl, path, query)
  const trimmedBase = connectionOrigin(baseUrl)
  // A text search is typed a letter at a time: keeping each one would fill the copy with noise.
  const cacheable = method === 'GET' && !NEVER_CACHED.includes(path) && !query?.text
  if (local) return localRequest(path, { query, cacheable, offline })
  let response = null
  try {
    response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (err) {
    response = null
  }

  if (!response || GATEWAY_STATUSES.has(response.status)) {
    markOffline()
    if (cacheable) {
      const cached = await cacheGet(url)
      if (cached) return fromCopy(path, query, cached.data)
    }
    if (offline) {
      return queueOfflineWrite({ ...offline, baseUrl: trimmedBase, myTasksUrl: buildUrl(baseUrl, '/api/tasks', MY_TASKS_QUERY) })
    }
    throw new ApiError(method === 'GET' ? UNREACHABLE_MESSAGE : OFFLINE_WRITE_MESSAGE, 'network_error', 0)
  }
  // The server is back. Send what was queued before anything reloads: a view that refetched
  // first would show the server's older state and the offline edits would flicker away.
  // A batch the server refused is not retried on every request. The banner offers Try again.
  if (replay) {
    const { offline: wasOffline, pending, lastSync } = getOfflineState()
    if (wasOffline || (pending > 0 && !lastSync?.failed)) await flushOutbox(trimmedBase, token)
  }
  markOnline()

  const text = await response.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }

  if (!response.ok) {
    const message = data?.error?.message || `Request failed (${response.status})`
    const code = data?.error?.code || 'unknown_error'
    throw new ApiError(message, code, response.status)
  }

  if (cacheable) cachePut(url, data)
  return data
}

// A stored answer, with the query's status filter applied again. The queued writes patch a task
// in every stored list it is in (outbox.js), so a task completed with no server to refresh from
// stays in the copy of the open list with status done. The server would have left it out, and
// so does this; the task itself, and the queued completion, are untouched, so Reopen still works.
function fromCopy(path, query, data) {
  if (path !== '/api/tasks' || typeof query?.status !== 'string' || !Array.isArray(data?.tasks)) return data
  const statuses = query.status.split(',')
  return { ...data, tasks: data.tasks.filter((t) => statuses.includes(t.status)) }
}

// Local mode keeps its copy under LOCAL_ORIGIN, never under the address the client was made with.
// That address is whatever the settings form last held, and a reload starts it at the default, so
// a copy keyed by it would be unreadable after Disconnect from a server with another address.
// The queued previews use the same keys, so a task made here is listed until a server adopts it.
async function localRequest(path, { query, cacheable, offline }) {
  markOffline()
  const key = buildUrl(LOCAL_ORIGIN, path, query)
  if (cacheable) {
    const cached = await cacheGet(key)
    if (cached) return fromCopy(path, query, cached.data)
    if (LOCAL_EMPTY[path]) {
      const data = LOCAL_EMPTY[path]()
      await cachePut(key, data)
      return data
    }
  }
  if (offline) {
    return queueOfflineWrite({ ...offline, baseUrl: LOCAL_ORIGIN, myTasksUrl: buildUrl(LOCAL_ORIGIN, '/api/tasks', MY_TASKS_QUERY) })
  }
  throw new ApiError(LOCAL_MESSAGE, 'not_connected', 0)
}

export function createApiClient(baseUrl, token, { local = false } = {}) {
  const call = (path, opts) => request(baseUrl, token, path, { ...opts, local })

  return {
    health: () => call('/api/health', { replay: false }),

    listProjects: (opts) => call('/api/projects', { query: opts?.includeArchived ? { includeArchived: 1 } : undefined }),
    getProject: (ref) => call(`/api/projects/${encodeURIComponent(ref)}`),
    createProject: (payload) => call('/api/projects', { method: 'POST', body: payload }),
    updateProject: (ref, patch) => call(`/api/projects/${encodeURIComponent(ref)}`, { method: 'PATCH', body: patch }),

    listTasks: (query) => call('/api/tasks', { query }),
    getTask: (id) => call(`/api/tasks/${encodeURIComponent(id)}`),
    // The task writes carry an `offline` description, so they are queued when the server is away.
    // A create or a comment is not safe to apply twice, so it names itself on the first attempt
    // too: if the server saved it and only the answer was lost, the replay is a duplicate.
    createTask: (payload) => {
      const ident = { opId: newOpId(), deviceId: deviceId() }
      const taskId = newTaskId()
      return call('/api/tasks', { method: 'POST', body: { ...payload, ...ident, id: taskId }, offline: { kind: 'create_task', taskId, opId: ident.opId, body: payload } })
    },
    updateTask: (id, payload) => call(`/api/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload, offline: { kind: 'update_task', taskId: id, body: payload } }),
    completeTask: (id) => call(`/api/tasks/${encodeURIComponent(id)}/complete`, { method: 'POST', offline: { kind: 'complete_task', taskId: id } }),
    reopenTask: (id) => call(`/api/tasks/${encodeURIComponent(id)}/reopen`, { method: 'POST', offline: { kind: 'reopen_task', taskId: id } }),
    // Not queued offline: it reads the server's history, so it has no offline op kind.
    restoreTask: (id, eventId) => call(`/api/tasks/${encodeURIComponent(id)}/restore`, { method: 'POST', body: { eventId } }),
    moveTask: (id, payload) => call(`/api/tasks/${encodeURIComponent(id)}/move`, { method: 'POST', body: payload, offline: { kind: 'move_task', taskId: id, body: payload } }),
    addComment: (id, body) => {
      const ident = { opId: newOpId(), deviceId: deviceId() }
      return call(`/api/tasks/${encodeURIComponent(id)}/comments`, { method: 'POST', body: { body, ...ident }, offline: { kind: 'add_comment', taskId: id, opId: ident.opId, body: { body } } })
    },

    listInbox: () => call('/api/inbox'),
    acceptInboxItem: (id, payload) => call(`/api/inbox/${encodeURIComponent(id)}/accept`, { method: 'POST', body: payload || {} }),
    rejectInboxItem: (id, payload) => call(`/api/inbox/${encodeURIComponent(id)}/reject`, { method: 'POST', body: payload || {} }),

    listViews: () => call('/api/views'),
    getView: (name) => call(`/api/views/${encodeURIComponent(name)}`),

    listRules: () => call('/api/rules'),
    createRule: (payload) => call('/api/rules', { method: 'POST', body: payload }),
    updateRule: (id, payload) => call(`/api/rules/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload }),
    deleteRule: (id) => call(`/api/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    runRules: (payload) => call('/api/rules/run', { method: 'POST', body: payload }),

    getDigest: () => call('/api/digest'),

    listGoals: (includeClosed) => call('/api/goals', { query: includeClosed ? { includeClosed: 1 } : undefined }),
    getGoal: (id) => call(`/api/goals/${encodeURIComponent(id)}`),
    createGoal: (payload) => call('/api/goals', { method: 'POST', body: payload }),
    updateGoal: (id, payload) => call(`/api/goals/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload }),
    deleteGoal: (id) => call(`/api/goals/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    linkGoal: (id, target) => call(`/api/goals/${encodeURIComponent(id)}/links`, { method: 'POST', body: target }),
    unlinkGoal: (id, target) => call(`/api/goals/${encodeURIComponent(id)}/unlink`, { method: 'POST', body: target }),
    setGoalVision: (text) => call('/api/goal-vision', { method: 'PATCH', body: { text } }),
    getEvents: (after, limit) => {
      const query = {}
      if (after) query.after = after
      if (limit) query.limit = limit
      return call('/api/events', { query: Object.keys(query).length ? query : undefined })
    },

    getSync: () => call('/api/sync'),
    runSync: (job) => call(`/api/sync/${encodeURIComponent(job)}`, { method: 'POST' }),

    // Backup settings. None of these has an `offline` kind: a passphrase is never queued on a
    // device, and the server never sends one back.
    getBackup: () => call('/api/backup'),
    setBackupEncryption: (passphrase, replace = false) => call('/api/backup/encryption', { method: 'POST', body: replace ? { passphrase, replace: true } : { passphrase } }),
    disableBackupEncryption: () => call('/api/backup/encryption', { method: 'DELETE' }),
    checkBackup: () => call('/api/backup/check', { method: 'POST' }),

    // The owner's default agent name (command-center/src/http/rest.ts): who "Assign to AI" claims a task for,
    // and the name history lines show next to "agent" (docs/assign-to-ai-options.md, stage 5B).
    // The PATCH has no `offline` kind: it is live-only, so a name typed with no server to tell
    // never sits in the outbox describing a decision the server never saw.
    getAgentSettings: () => call('/api/settings/agent'),
    updateAgentSettings: (payload) => call('/api/settings/agent', { method: 'PATCH', body: payload }),

    githubStatus: () => call('/api/github/status'),
    githubAppManifest: () => call('/api/github/app/manifest', { method: 'POST', body: {} }),
    githubLogin: () => call('/api/github/login', { method: 'POST', body: {} }),
    githubLogout: () => call('/api/github/logout', { method: 'POST' }),
    githubForgetApp: () => call('/api/github/app/forget', { method: 'POST' }),
    githubRepos: () => call('/api/github/repos'),
    updateGithubRepo: (fullName, patch) => {
      const slash = String(fullName).indexOf('/')
      const owner = slash === -1 ? fullName : fullName.slice(0, slash)
      const repo = slash === -1 ? '' : fullName.slice(slash + 1)
      return call(
        `/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        { method: 'PATCH', body: patch }
      )
    },
  }
}

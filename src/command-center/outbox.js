// Edits made while the server is unreachable (initiatives/offline-clone.md, phase 2).
//
// api.js hands a task write here when it cannot reach the server. The edit is queued in IndexedDB,
// shown at once by patching the local copy, and replayed through POST /api/outbox when the server
// answers again. The server does the merge (command-center/src/core/outbox.ts): this side only has
// to say what was changed, when, and which version of the task it was looking at.
//
// Every queued edit is stamped with the server it was made against (`origin`) and is only ever
// sent there. The browser's storage is shared by every connection this dashboard has had, so
// without the stamp, testing a second server would hand it the first one's edits.
//
// A device with no saved connection has no server to stamp with. Its edits are stamped
// LOCAL_ORIGIN, and the first server it connects to adopts them (adoptLocalOutbox): the one time
// an edit changes servers. Decided 2026-09-26, see initiatives/offline-clone.md.
//
// Only task edits and comments are queued. Inbox decisions, rules, goals, projects, and GitHub
// switches are never written offline, and the server has no op for them either.

import { cacheGet, cachePatchAll, cachePut, indexedDbBackend, memoryBackend } from './offlineCache'
import { setPending, setLastSync } from './offlineStatus'
import { notifyTaskChanges } from './taskChanges'

const DEVICE_KEY = 'cc-device-id-v1'
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
// POST /api/outbox takes at most 500 ops (http/schemas.ts) in a body of at most 1 MiB
// (http/server.ts). The byte budget leaves room for the envelope around the ops.
const MAX_BATCH_OPS = 500
const MAX_BATCH_BYTES = 900 * 1024
const CREATE_FIELDS = ['title', 'notes', 'projectId', 'sectionId', 'parentId', 'priority', 'dueAt', 'startAt', 'recurrence', 'assignee', 'sourceUrl']

/** The stamp on edits made before this device was ever connected. Never a fetchable address. */
export const LOCAL_ORIGIN = 'local:'

let queue = null

function getQueue() {
  if (!queue) queue = typeof indexedDB === 'undefined' ? memoryBackend() : indexedDbBackend('cc-outbox-v1')
  return queue
}

export function setOutboxBackend(next) {
  queue = next
}

function randomId(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  let out = ''
  for (const b of bytes) out += ID_ALPHABET[b % 36]
  return out
}

/** The form of a base URL that queued edits are stamped with and matched against. */
export function connectionOrigin(baseUrl) {
  return (baseUrl || '').replace(/\/+$/, '')
}

/** The id a write carries on its first attempt and again if it is replayed, so it applies once. */
export function newOpId() {
  return `op_${randomId(16)}`
}

/** Same shape as the server's newId('t'), so a task made offline keeps its id for good. */
export function newTaskId() {
  return `t_${randomId(10)}`
}

export function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY)
    if (!id) {
      id = `dev_${randomId(16)}`
      localStorage.setItem(DEVICE_KEY, id)
    }
    return id
  } catch {
    return `dev_${randomId(16)}`
  }
}

let seq = 0
function queueKey(now) {
  // Sorts by time, then by order within the same millisecond.
  return `${String(now).padStart(15, '0')}-${String(++seq).padStart(6, '0')}`
}

// An entry with no origin was queued before edits were stamped. Nothing says where it belongs,
// so it is never sent.
async function listOps(origin) {
  const entries = await getQueue().entries()
  return entries
    .filter(([, op]) => op?.origin === origin)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

/** Counts the edits waiting for the server at `baseUrl`. Another server's edits are not this one's to show. */
export async function refreshPendingCount(baseUrl) {
  try {
    setPending((await listOps(connectionOrigin(baseUrl))).length)
  } catch {
    setPending(0)
  }
}

async function findCachedTask(baseUrl, id) {
  const detail = await cacheGet(`${baseUrl}/api/tasks/${encodeURIComponent(id)}`)
  if (detail?.data?.task) return detail.data.task
  let found = null
  await cachePatchAll((data) => {
    if (!found && Array.isArray(data?.tasks)) found = data.tasks.find((t) => t?.id === id) || null
    return undefined
  })
  return found
}

function patchTaskEverywhere(id, fields) {
  return cachePatchAll((data) => {
    if (!data || typeof data !== 'object') return undefined
    let changed = false
    const next = { ...data }
    if (data.task?.id === id) {
      next.task = { ...data.task, ...fields }
      changed = true
    }
    for (const key of ['tasks', 'subtasks']) {
      if (Array.isArray(data[key]) && data[key].some((t) => t?.id === id)) {
        next[key] = data[key].map((t) => (t?.id === id ? { ...t, ...fields } : t))
        changed = true
      }
    }
    return changed ? next : undefined
  })
}

async function addCreatedTask(baseUrl, myTasksUrl, task) {
  const projectUrl = task.projectId ? `${baseUrl}/api/projects/${encodeURIComponent(task.projectId)}` : null
  const parentUrl = task.parentId ? `${baseUrl}/api/tasks/${encodeURIComponent(task.parentId)}` : null
  await cachePatchAll((data, key) => {
    if ((key === myTasksUrl || key === projectUrl) && Array.isArray(data?.tasks)) return { ...data, tasks: [task, ...data.tasks] }
    if (key === parentUrl && Array.isArray(data?.subtasks)) return { ...data, subtasks: [...data.subtasks, task] }
    return undefined
  })
  await cachePut(`${baseUrl}/api/tasks/${encodeURIComponent(task.id)}`, {
    task, subtasks: [], blockers: [], blocking: [], comments: [], links: [], history: [],
  })
}

/**
 * Queues one task write and returns what the server would have answered, built from the local
 * copy, so the caller carries on exactly as it does online.
 */
export async function queueOfflineWrite({ baseUrl, origin = connectionOrigin(baseUrl), myTasksUrl, kind, taskId, opId = newOpId(), body = {} }, now = Date.now()) {
  const at = new Date(now).toISOString()
  const existing = kind === 'create_task' ? null : await findCachedTask(baseUrl, taskId)
  // A task this device made offline has no server version to compare against yet.
  const base = existing && !existing.offlineCreated ? existing.updatedAt ?? null : null

  let opBody = body
  if (kind === 'create_task') {
    opBody = {}
    for (const field of CREATE_FIELDS) if (body[field] !== undefined) opBody[field] = body[field]
  }
  await getQueue().put(queueKey(now), { origin, opId, kind, taskId, at, base, body: opBody })
  await refreshPendingCount(origin)

  if (kind === 'create_task') {
    const task = {
      notes: '', priority: 'none', dueAt: null, startAt: null, projectId: null, sectionId: null, parentId: null,
      recurrence: null, assignee: null, ...opBody,
      id: taskId, status: 'open', sourceType: null, sourceUrl: opBody.sourceUrl ?? null, untrustedText: false, customFields: {},
      createdAt: at, updatedAt: at, completedAt: null, offlineCreated: true,
    }
    await addCreatedTask(baseUrl, myTasksUrl, task)
    notifyTaskChanges()
    return { task }
  }

  if (kind === 'add_comment') {
    const comment = { id: `c_${randomId(10)}`, taskId, author: 'human', body: body.body, createdAt: at }
    await cachePatchAll((data) => (
      data?.task?.id === taskId && Array.isArray(data.comments) ? { ...data, comments: [...data.comments, comment] } : undefined
    ))
    return { comment }
  }

  let fields = {}
  if (kind === 'complete_task') fields = { status: 'done', completedAt: at }
  else if (kind === 'reopen_task') fields = { status: 'open', completedAt: null }
  else if (kind === 'update_task') fields = body
  else if (kind === 'move_task') {
    // The board sends a section id (or null for "No section"). A name could not be resolved
    // here, so anything else waits for the server to place it.
    if (body.section === null || /^s_[0-9a-z]+$/.test(String(body.section))) fields = { sectionId: body.section }
  }
  await patchTaskEverywhere(taskId, fields)
  notifyTaskChanges()
  const task = { ...(existing || { id: taskId }), ...fields }
  return kind === 'complete_task' ? { task, next: null } : { task }
}

/**
 * Hands the edits made before any connection to the server at `baseUrl`, so the next request
 * sends them. Called once that server has answered a connection test. Resolves to how many moved.
 */
export async function adoptLocalOutbox(baseUrl) {
  const origin = connectionOrigin(baseUrl)
  let moved = 0
  try {
    for (const [key] of await listOps(LOCAL_ORIGIN)) {
      // The list above is a snapshot, and another tab may have connected meanwhile. Each entry is
      // read again, checked, and restamped in one step, so it goes to exactly one server: one
      // already claimed is left with its server, and one already sent and deleted is not
      // brought back.
      const claimed = await getQueue().update(key, (op) => (op?.origin === LOCAL_ORIGIN ? { ...op, origin } : undefined))
      if (claimed) moved += 1
    }
  } catch {
    // Whatever did not move stays local and is adopted on the next connection.
  }
  return moved
}

const flushing = new Map()

/**
 * Sends everything queued for the server at `baseUrl`. Resolves to true when none of it is left.
 * Never throws: a failure leaves the unsent edits queued and is reported through offlineStatus.
 */
export function flushOutbox(baseUrl, token) {
  const origin = connectionOrigin(baseUrl)
  if (!flushing.has(origin)) {
    flushing.set(origin, doFlush(origin, token).catch(() => false).finally(() => flushing.delete(origin)))
  }
  return flushing.get(origin)
}

const encoder = new TextEncoder()

// The op as the server takes it: `origin` is this side's bookkeeping and the schema is strict.
function wireOp({ origin, ...op }) {
  return op
}

/** The longest run from the front of `entries` that fits one request. Empty when the first op alone is too big. */
function takeBatch(entries) {
  const batch = []
  let bytes = 0
  for (const entry of entries) {
    const size = encoder.encode(JSON.stringify(wireOp(entry[1]))).length + 1
    if (batch.length >= MAX_BATCH_OPS || bytes + size > MAX_BATCH_BYTES) break
    batch.push(entry)
    bytes += size
  }
  return batch
}

function summarize(results) {
  return {
    failed: false,
    synced: results.filter((r) => r.status === 'applied' || r.status === 'conflict' || r.status === 'duplicate').length,
    conflicts: results.filter((r) => r.status === 'conflict')
      .map((r) => ({ taskId: r.taskId, title: r.title, fields: (r.conflicts || []).map((c) => c.field) })),
    rejected: results.filter((r) => r.status === 'rejected').map((r) => ({ taskId: r.taskId, error: r.error })),
  }
}

async function doFlush(origin, token) {
  let entries
  try {
    entries = await listOps(origin)
  } catch {
    return true
  }
  if (!entries.length) return true

  const results = []
  // An edit too big for any request can never be sent. It is set aside so the ones behind it
  // still go, and reported at the end as refused, where the owner can discard it.
  const tooBig = []
  // What was sent before a later batch failed is still worth reporting.
  const stop = async (failure) => {
    await refreshPendingCount(origin)
    if (failure) setLastSync(failure)
    else if (results.length) setLastSync(summarize(results))
    return false
  }

  while (entries.length) {
    const batch = takeBatch(entries)
    if (!batch.length) {
      tooBig.push(entries.shift())
      continue
    }

    let response
    try {
      response = await fetch(`${origin}/api/outbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ deviceId: deviceId(), ops: batch.map(([, op]) => wireOp(op)) }),
      })
    } catch {
      return stop(null)
    }
    if (!response.ok) {
      // A gateway error means still offline. Anything else is the server refusing the batch, which
      // the owner has to see: the changes are still here, and only the owner can decide to drop them.
      if ([502, 503, 504].includes(response.status)) return stop(null)
      return stop({ failed: true, status: response.status, count: entries.length + tooBig.length })
    }

    // Only what the server says it dealt with leaves the queue. The op ids make sending the
    // rest again harmless.
    const data = await response.json().catch(() => ({}))
    const answered = Array.isArray(data.results) ? data.results : []
    const acknowledged = new Set(answered.map((r) => r.opId))
    results.push(...answered)
    for (const [key, op] of batch) if (acknowledged.has(op.opId)) await getQueue().delete(key)
    if (batch.some(([, op]) => !acknowledged.has(op.opId))) {
      return stop({ failed: true, status: response.status, count: (await listOps(origin)).length })
    }
    entries = entries.slice(batch.length)
  }

  await refreshPendingCount(origin)
  if (tooBig.length) {
    setLastSync({ failed: true, status: 413, count: tooBig.length })
    return false
  }
  setLastSync(summarize(results))
  return true
}

/** Drops the edits queued for the server at `baseUrl`. Another server's edits stay for it. */
export async function discardOutbox(baseUrl) {
  try {
    for (const [key] of await listOps(connectionOrigin(baseUrl))) await getQueue().delete(key)
  } catch {
    // Nothing queued that can be dropped.
  }
  setPending(0)
  setLastSync(null)
}

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, act } from '@testing-library/react'
import { DEFAULT_BASE_URL, createApiClient, MY_TASKS_QUERY } from './api'
import { cacheGet, memoryBackend, setCacheBackend } from './offlineCache'
import { getOfflineState, resetOfflineStatus, setLastSync } from './offlineStatus'
import { LOCAL_ORIGIN, adoptLocalOutbox, discardOutbox, flushOutbox, queueOfflineWrite, refreshPendingCount, setOutboxBackend } from './outbox'

vi.mock('./ConnectionContext', () => ({ useConnection: () => ({ connected: true, baseUrl: 'http://x', token: 'tok' }) }))
vi.mock('./useMirrorWarm', () => ({ useMirrorWarm: () => {} }))

const { default: OfflineBanner } = await import('../OfflineBanner')

const MY_TASKS_URL = `http://x/api/tasks?${new URLSearchParams(Object.entries(MY_TASKS_QUERY).map(([k, v]) => [k, String(v)]))}`
const TASK = { id: 't_aaaaaaaaaa', title: 'Write the plan', status: 'open', priority: 'none', updatedAt: '2026-09-21T08:00:00.000Z' }

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body }
}
const down = () => Promise.reject(new TypeError('Failed to fetch'))

// Loads My tasks and one task's detail while online, so the copy holds them.
async function seed(client) {
  global.fetch.mockResolvedValueOnce(jsonResponse(200, { tasks: [TASK], total: 1 }))
  await client.listTasks(MY_TASKS_QUERY)
  global.fetch.mockResolvedValueOnce(jsonResponse(200, { task: TASK, subtasks: [], comments: [] }))
  await client.getTask(TASK.id)
  await vi.waitFor(async () => expect(await cacheGet(`http://x/api/tasks/${TASK.id}`)).not.toBeNull())
}

beforeEach(() => {
  global.fetch = vi.fn()
  setCacheBackend(memoryBackend())
  setOutboxBackend(memoryBackend())
  resetOfflineStatus()
})

afterEach(() => cleanup())

describe('offline task edits', () => {
  test('an edit made offline is queued, answered, and shown in every stored view', async () => {
    const client = createApiClient('http://x', 'tok')
    await seed(client)
    global.fetch.mockImplementation(down)

    const res = await client.updateTask(TASK.id, { priority: 'high' })
    expect(res.task).toMatchObject({ id: TASK.id, priority: 'high', title: 'Write the plan' })
    expect(getOfflineState()).toMatchObject({ offline: true, pending: 1 })
    expect((await client.listTasks(MY_TASKS_QUERY)).tasks[0].priority).toBe('high')
    expect((await client.getTask(TASK.id)).task.priority).toBe('high')
  })

  test('a task made offline gets a server-shaped id and joins My tasks', async () => {
    const client = createApiClient('http://x', 'tok')
    await seed(client)
    global.fetch.mockImplementation(down)

    const { task } = await client.createTask({ title: 'Made on the train', dueAt: '2026-09-21', project: 'not sent' })
    expect(task.id).toMatch(/^t_[0-9a-z]{10}$/)
    expect(task.assignee).toBeNull()
    const list = (await cacheGet(MY_TASKS_URL)).data.tasks
    expect(list.map((t) => t.title)).toEqual(['Made on the train', 'Write the plan'])
    expect((await client.getTask(task.id)).task.title).toBe('Made on the train')
  })

  test('a link shared into an offline create is kept on the task and in the queued op', async () => {
    const client = createApiClient('http://x', 'tok')
    await seed(client)
    global.fetch.mockImplementation(down)

    const { task } = await client.createTask({ title: 'Read later', sourceUrl: 'https://example.com/a' })
    expect(task.sourceUrl).toBe('https://example.com/a')
    expect(task.sourceType).toBeNull()
    expect((await client.getTask(task.id)).task.sourceUrl).toBe('https://example.com/a')
    const plain = await client.createTask({ title: 'No link' })
    expect(plain.task.sourceUrl).toBeNull()
  })

  test('an assignee set or cleared offline is kept in the copy and in the queued edit, and travels with an offline create', async () => {
    const client = createApiClient('http://x', 'tok')
    await seed(client)
    global.fetch.mockImplementation(down)

    const res = await client.updateTask(TASK.id, { assignee: 'scribe' })
    expect(res.task.assignee).toBe('scribe')
    expect((await client.getTask(TASK.id)).task.assignee).toBe('scribe')
    expect((await client.listTasks(MY_TASKS_QUERY)).tasks[0].assignee).toBe('scribe')
    expect((await client.updateTask(TASK.id, { assignee: null })).task.assignee).toBeNull()

    const { task } = await client.createTask({ title: 'Made on the train', assignee: 'scribe' })
    expect(task.assignee).toBe('scribe')
    expect((await client.getTask(task.id)).task.assignee).toBe('scribe')
  })

  test('completing and commenting offline show at once', async () => {
    const client = createApiClient('http://x', 'tok')
    await seed(client)
    global.fetch.mockImplementation(down)

    expect((await client.completeTask(TASK.id)).task.status).toBe('done')
    await client.addComment(TASK.id, 'Noted offline')
    const detail = await client.getTask(TASK.id)
    expect(detail.task.status).toBe('done')
    expect(detail.comments.map((c) => c.body)).toEqual(['Noted offline'])
    expect(getOfflineState().pending).toBe(2)
  })

  test('the first answer from the server sends the queue, in order, before offline mode ends', async () => {
    const client = createApiClient('http://x', 'tok')
    await seed(client)
    global.fetch.mockImplementation(down)
    await client.updateTask(TASK.id, { priority: 'high' })
    const { task: made } = await client.createTask({ title: 'Made offline' })

    const calls = []
    global.fetch.mockImplementation(async (url, init) => {
      calls.push(url)
      if (url === 'http://x/api/outbox') {
        const sent = JSON.parse(init.body)
        expect(sent.deviceId).toMatch(/^dev_/)
        expect(sent.ops.map((o) => [o.kind, o.taskId, o.base])).toEqual([
          ['update_task', TASK.id, TASK.updatedAt],
          ['create_task', made.id, null],
        ])
        expect(sent.ops[1].body).toEqual({ title: 'Made offline' })
        // Offline mode must still be on here: nothing may reload before the edits are in.
        expect(getOfflineState().offline).toBe(true)
        return jsonResponse(200, { results: sent.ops.map((o) => ({ opId: o.opId, taskId: o.taskId, status: 'applied', conflicts: [] })) })
      }
      return jsonResponse(200, { events: [], headId: 9 })
    })
    await client.getEvents()

    expect(calls).toEqual(['http://x/api/events', 'http://x/api/outbox'])
    expect(getOfflineState()).toMatchObject({ offline: false, pending: 0 })
    expect(getOfflineState().lastSync).toMatchObject({ failed: false, synced: 2, conflicts: [] })
  })

  test('a batch the server refuses stays queued, and is not resent on every request', async () => {
    const client = createApiClient('http://x', 'tok')
    await seed(client)
    global.fetch.mockImplementation(down)
    await client.updateTask(TASK.id, { priority: 'high' })

    let outboxCalls = 0
    global.fetch.mockImplementation(async (url) => {
      if (url === 'http://x/api/outbox') {
        outboxCalls += 1
        return jsonResponse(400, { error: { message: 'bad batch' } })
      }
      return jsonResponse(200, { events: [], headId: 9 })
    })
    await client.getEvents()
    await client.getEvents()

    expect(outboxCalls).toBe(1)
    expect(getOfflineState()).toMatchObject({ offline: false, pending: 1 })
    expect(getOfflineState().lastSync).toMatchObject({ failed: true, status: 400, count: 1 })
  })
})

describe('OfflineBanner after a sync', () => {
  test('reports what was sent and names a conflict in plain words', () => {
    render(<OfflineBanner />)
    act(() => setLastSync({
      failed: false, synced: 3, rejected: [],
      conflicts: [{ taskId: 't_1', title: 'Write the plan', fields: ['title', 'dueAt'] }],
    }))
    const text = screen.getByRole('status').textContent
    expect(text).toContain('3 offline changes sent, 1 conflict.')
    expect(text).toContain('Write the plan: a newer edit was kept for name, due date.')
    act(() => screen.getByRole('button', { name: 'Dismiss' }).click())
    expect(screen.queryByRole('status')).toBeNull()
  })

  test('a refused batch offers Try again and Discard them', () => {
    render(<OfflineBanner />)
    act(() => setLastSync({ failed: true, status: 400, count: 2 }))
    expect(screen.getByRole('status').textContent).toContain('refused 2 offline changes')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Discard them' })).toBeTruthy()
  })
})

describe('the queue belongs to the server it was made against', () => {
  test('testing another server sends it nothing, and the first server still gets its edits', async () => {
    const a = createApiClient('http://x', 'tok')
    await seed(a)
    global.fetch.mockImplementation(down)
    await a.createTask({ title: 'Task belonging to A' })
    expect(getOfflineState().pending).toBe(1)

    const calls = []
    global.fetch.mockImplementation(async (url, init) => {
      calls.push(url)
      if (url.endsWith('/api/outbox')) {
        const sent = JSON.parse(init.body)
        return jsonResponse(200, { results: sent.ops.map((o) => ({ opId: o.opId, taskId: o.taskId, status: 'applied', conflicts: [] })) })
      }
      return jsonResponse(200, { ok: true, events: [] })
    })

    // The connection test, then ordinary traffic once B is the connection.
    const b = createApiClient('http://server-b.test/', 'tok-b')
    await b.health()
    await refreshPendingCount('http://server-b.test/')
    expect(getOfflineState().pending).toBe(0)
    await b.getEvents()
    await flushOutbox('http://server-b.test', 'tok-b')
    expect(calls.filter((u) => u.endsWith('/api/outbox'))).toEqual([])

    // Back on A: its edit is still there, and goes to A.
    await refreshPendingCount('http://x')
    expect(getOfflineState().pending).toBe(1)
    await a.getEvents()
    expect(calls.filter((u) => u.endsWith('/api/outbox'))).toEqual(['http://x/api/outbox'])
    expect(getOfflineState().pending).toBe(0)
  })

  test('a health check never sends the queue, even to its own server', async () => {
    const client = createApiClient('http://x', 'tok')
    await seed(client)
    global.fetch.mockImplementation(down)
    await client.updateTask(TASK.id, { priority: 'high' })

    const calls = []
    global.fetch.mockImplementation(async (url) => {
      calls.push(url)
      return jsonResponse(200, { ok: true })
    })
    await client.health()
    expect(calls).toEqual(['http://x/api/health'])
    expect(getOfflineState().pending).toBe(1)
  })

  test('discarding drops only the current server\'s edits', async () => {
    global.fetch.mockImplementation(down)
    await createApiClient('http://x', 'tok').addComment(TASK.id, 'for x')
    await createApiClient('http://y', 'tok').addComment(TASK.id, 'for y')

    await discardOutbox('http://y')
    await refreshPendingCount('http://x')
    expect(getOfflineState().pending).toBe(1)
    await refreshPendingCount('http://y')
    expect(getOfflineState().pending).toBe(0)
  })

  test('the op sent to the server carries no origin', async () => {
    const client = createApiClient('http://x', 'tok')
    global.fetch.mockImplementation(down)
    await client.addComment(TASK.id, 'hello')
    let sent = null
    global.fetch.mockImplementation(async (url, init) => {
      sent = JSON.parse(init.body)
      return jsonResponse(200, { results: sent.ops.map((o) => ({ opId: o.opId, taskId: o.taskId, status: 'applied' })) })
    })
    await flushOutbox('http://x', 'tok')
    expect(Object.keys(sent.ops[0]).sort()).toEqual(['at', 'base', 'body', 'kind', 'opId', 'taskId'])
  })
})

describe('a device with no connection yet', () => {
  test('fetches nothing, starts with an empty My tasks, and keeps what is made on it', async () => {
    const local = createApiClient('http://x', '', { local: true })
    expect((await local.listTasks(MY_TASKS_QUERY)).tasks).toEqual([])
    const { task } = await local.createTask({ title: 'Jotted before connecting' })
    await local.updateTask(task.id, { priority: 'high' })
    await local.addComment(task.id, 'a note')

    expect(global.fetch).not.toHaveBeenCalled()
    expect((await local.listTasks(MY_TASKS_QUERY)).tasks).toMatchObject([{ id: task.id, priority: 'high' }])
    expect((await local.getTask(task.id)).comments.map((c) => c.body)).toEqual(['a note'])
    expect(getOfflineState()).toMatchObject({ offline: true, pending: 3 })
    await expect(local.listInbox()).rejects.toMatchObject({ code: 'not_connected' })
    await expect(local.health()).rejects.toMatchObject({ code: 'not_connected' })
  })

  test('its copy is under one key whatever address the client was made with', async () => {
    // After Disconnect the provider still holds the old server's address, and a reload starts
    // at the default. A copy keyed by either would be lost across the reload.
    const before = createApiClient('http://cc.test:9000', '', { local: true })
    expect((await before.listTasks(MY_TASKS_QUERY)).tasks).toEqual([])
    const { task } = await before.createTask({ title: 'Kept across the reload' })
    await before.addComment(task.id, 'a note')

    const after = createApiClient(DEFAULT_BASE_URL, '', { local: true })
    expect((await after.listTasks(MY_TASKS_QUERY)).tasks.map((t) => t.id)).toEqual([task.id])
    expect((await after.getTask(task.id)).comments.map((c) => c.body)).toEqual(['a note'])
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('a task completed here leaves the open list, and comes back when reopened', async () => {
    // There is no server to refresh the list from, so the copy is patched in place: the open
    // list must still answer to its own status filter, as the server would.
    const local = createApiClient(DEFAULT_BASE_URL, '', { local: true })
    expect((await local.listTasks(MY_TASKS_QUERY)).tasks).toEqual([])
    const { task } = await local.createTask({ title: 'Done before connecting' })
    const kept = (await local.createTask({ title: 'Still open' })).task
    await local.completeTask(task.id)

    // The list after a reload is the same read, from the same copy.
    const reloaded = createApiClient(DEFAULT_BASE_URL, '', { local: true })
    expect((await reloaded.listTasks(MY_TASKS_QUERY)).tasks.map((t) => t.id)).toEqual([kept.id])
    expect((await reloaded.getTask(task.id)).task).toMatchObject({ status: 'done' })
    expect(getOfflineState().pending).toBe(3)

    await reloaded.reopenTask(task.id)
    expect((await reloaded.listTasks(MY_TASKS_QUERY)).tasks.map((t) => t.id).sort()).toEqual([kept.id, task.id].sort())
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('its edits go to no server until one adopts them, then only to that one', async () => {
    await createApiClient('http://x', '', { local: true }).createTask({ title: 'Local' })
    const sentTo = []
    global.fetch.mockImplementation(async (url, init) => {
      sentTo.push(url)
      const sent = JSON.parse(init.body)
      return jsonResponse(200, { results: sent.ops.map((o) => ({ opId: o.opId, taskId: o.taskId, status: 'applied' })) })
    })
    await flushOutbox('http://x', 'tok')
    expect(sentTo).toEqual([])

    expect(await adoptLocalOutbox('http://x/')).toBe(1)
    expect(await adoptLocalOutbox('http://y')).toBe(0)
    await flushOutbox('http://y', 'tok')
    await flushOutbox('http://x', 'tok')
    expect(sentTo).toEqual(['http://x/api/outbox'])
    await refreshPendingCount(LOCAL_ORIGIN)
    expect(getOfflineState().pending).toBe(0)
  })
})

describe('a local edit is claimed by one server only', () => {
  // The queue is shared by every tab. This backend lets a test hold one tab's next write until
  // another tab has had its turn, which is what a second connection test in a second tab does.
  function holdingBackend(inner) {
    let held = null
    const gate = async (name, args) => {
      if (held) {
        const { arrived, released } = held
        held = null
        arrived()
        await released
      }
      return inner[name](...args)
    }
    return {
      ...inner,
      put: (...args) => gate('put', args),
      update: (...args) => gate('update', args),
      holdNextWrite: () => {
        let arrived
        let release
        const arrivedAt = new Promise((resolve) => { arrived = resolve })
        const released = new Promise((resolve) => { release = resolve })
        held = { arrived, released }
        return { arrived: arrivedAt, release }
      },
    }
  }

  function acceptingServer(sentTo) {
    global.fetch.mockImplementation(async (url, init) => {
      const sent = JSON.parse(init.body)
      sentTo.push([url, ...sent.ops.map((o) => o.opId)])
      return jsonResponse(200, { results: sent.ops.map((o) => ({ opId: o.opId, taskId: o.taskId, status: 'applied' })) })
    })
  }

  test('a late second claimant does not take it, nor bring back one already sent', async () => {
    const backend = holdingBackend(memoryBackend())
    setOutboxBackend(backend)
    await createApiClient('http://x', '', { local: true }).createTask({ title: 'Local' })
    const [[, op]] = await backend.entries()
    const sentTo = []
    acceptingServer(sentTo)

    // B reads the local entry, then is held before it writes. A adopts and sends it meanwhile.
    const hold = backend.holdNextWrite()
    const adoptingB = adoptLocalOutbox('http://b')
    await hold.arrived
    expect(await adoptLocalOutbox('http://a')).toBe(1)
    expect(await flushOutbox('http://a', 'tok')).toBe(true)
    expect(await backend.entries()).toEqual([])

    hold.release()
    expect(await adoptingB).toBe(0)
    expect(await backend.entries()).toEqual([])
    await flushOutbox('http://b', 'tok')
    expect(sentTo).toEqual([['http://a/api/outbox', op.opId]])
  })

  test('with nothing sent in between, the second claimant still claims nothing', async () => {
    const backend = holdingBackend(memoryBackend())
    setOutboxBackend(backend)
    await createApiClient('http://x', '', { local: true }).createTask({ title: 'Local' })
    const sentTo = []
    acceptingServer(sentTo)

    const hold = backend.holdNextWrite()
    const adoptingB = adoptLocalOutbox('http://b')
    await hold.arrived
    expect(await adoptLocalOutbox('http://a')).toBe(1)
    hold.release()
    expect(await adoptingB).toBe(0)
    expect((await backend.entries()).map(([, o]) => o.origin)).toEqual(['http://a'])

    await flushOutbox('http://b', 'tok')
    await flushOutbox('http://a', 'tok')
    expect(sentTo.map(([url]) => url)).toEqual(['http://a/api/outbox'])
  })
})

describe('a write whose answer was lost', () => {
  test('is replayed under the op id and task id of the first attempt', async () => {
    const client = createApiClient('http://x', 'tok')
    const first = []
    global.fetch.mockImplementation(async (url, init) => {
      first.push(JSON.parse(init.body))
      throw new TypeError('Failed to fetch')
    })
    const { task } = await client.createTask({ title: 'Submitted once' })
    await client.addComment(TASK.id, 'Said once')

    let replayed = null
    global.fetch.mockImplementation(async (url, init) => {
      replayed = JSON.parse(init.body)
      return jsonResponse(200, { results: replayed.ops.map((o) => ({ opId: o.opId, taskId: o.taskId, status: 'duplicate' })) })
    })
    await flushOutbox('http://x', 'tok')

    expect(first[0]).toMatchObject({ title: 'Submitted once', id: task.id, deviceId: replayed.deviceId })
    expect(replayed.ops.map((o) => [o.kind, o.opId, o.taskId])).toEqual([
      ['create_task', first[0].opId, first[0].id],
      ['add_comment', first[1].opId, TASK.id],
    ])
    expect(getOfflineState().lastSync).toMatchObject({ failed: false, synced: 2 })
  })
})

describe('sending a long queue', () => {
  // Answers as POST /api/outbox does: at most 500 ops and 1 MiB, each op id applied once.
  function outboxServer({ failOnCall = 0 } = {}) {
    const applied = []
    const batches = []
    let call = 0
    global.fetch.mockImplementation(async (url, init) => {
      if (!url.endsWith('/api/outbox')) return jsonResponse(200, { events: [] })
      call += 1
      if (call === failOnCall) throw new TypeError('Failed to fetch')
      const sent = JSON.parse(init.body)
      if (sent.ops.length > 500) return jsonResponse(400, { error: { message: 'too many ops' } })
      if (new TextEncoder().encode(init.body).length > 1024 * 1024) return jsonResponse(413, { error: { message: 'too large' } })
      batches.push(sent.ops.length)
      return jsonResponse(200, {
        results: sent.ops.map((o) => {
          const status = applied.includes(o.opId) ? 'duplicate' : 'applied'
          if (status === 'applied') applied.push(o.opId)
          return { opId: o.opId, taskId: o.taskId, status, conflicts: [] }
        }),
      })
    })
    return { applied, batches }
  }

  async function queueComments(count, body = 'x') {
    for (let i = 0; i < count; i += 1) {
      await queueOfflineWrite({ baseUrl: 'http://x', kind: 'add_comment', taskId: TASK.id, body: { body: `${body}${i}` } }, 1000 + i)
    }
  }

  test('501 edits go in two requests, in order', async () => {
    await queueComments(501)
    const server = outboxServer()
    expect(await flushOutbox('http://x', 'tok')).toBe(true)
    expect(server.batches).toEqual([500, 1])
    expect(server.applied).toHaveLength(501)
    expect(getOfflineState()).toMatchObject({ pending: 0, lastSync: { failed: false, synced: 501 } })
  })

  test('a failure after the first batch keeps only the unsent edits, and the retry applies nothing twice', async () => {
    await queueComments(501)
    const server = outboxServer({ failOnCall: 2 })
    expect(await flushOutbox('http://x', 'tok')).toBe(false)
    expect(getOfflineState()).toMatchObject({ pending: 1, lastSync: { failed: false, synced: 500 } })

    expect(await flushOutbox('http://x', 'tok')).toBe(true)
    expect(server.batches).toEqual([500, 1])
    expect(new Set(server.applied).size).toBe(501)
    expect(getOfflineState().pending).toBe(0)
  })

  test('a few long comments are split by size well below 500 ops', async () => {
    await queueComments(3, 'n'.repeat(400 * 1024))
    const server = outboxServer()
    expect(await flushOutbox('http://x', 'tok')).toBe(true)
    expect(server.batches).toEqual([2, 1])
  })

  test('one edit too big to send is reported and does not hold back the rest', async () => {
    await queueComments(1, 'n'.repeat(1024 * 1024))
    await queueOfflineWrite({ baseUrl: 'http://x', kind: 'add_comment', taskId: TASK.id, body: { body: 'small' } }, 5000)
    const server = outboxServer()
    expect(await flushOutbox('http://x', 'tok')).toBe(false)
    expect(server.batches).toEqual([1])
    expect(getOfflineState()).toMatchObject({ pending: 1, lastSync: { failed: true, status: 413, count: 1 } })
  })

  test('an op the server did not answer for stays queued', async () => {
    await queueComments(2)
    global.fetch.mockImplementation(async (url, init) => {
      const [first] = JSON.parse(init.body).ops
      return jsonResponse(200, { results: [{ opId: first.opId, taskId: first.taskId, status: 'applied' }] })
    })
    expect(await flushOutbox('http://x', 'tok')).toBe(false)
    expect(getOfflineState()).toMatchObject({ pending: 1, lastSync: { failed: true, count: 1 } })
  })
})

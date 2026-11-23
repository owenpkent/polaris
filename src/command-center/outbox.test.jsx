import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, act } from '@testing-library/react'
import { DEFAULT_BASE_URL, createApiClient, MY_TASKS_QUERY } from './api'
import { cacheGet, memoryBackend, setCacheBackend } from './offlineCache'
import { getOfflineState, resetOfflineStatus, setLastSync } from './offlineStatus'
import { noteServerTime, resetServerClock } from './serverClock'
import { LOCAL_ORIGIN, adoptLocalOutbox, discardOutbox, flushOutbox, newOpId, newTaskId, nextCachedPosition, queueOfflineWrite, refreshPendingCount, setOutboxBackend } from './outbox'

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
  // The server clock sample and the sent-time floor are kept in localStorage.
  localStorage.clear()
  resetServerClock()
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

  // Store.createTask gives a subtask with no project of its own the parent's project. The copy does
  // the same, so until the queue is sent the child is in the parent's project everywhere the
  // dashboard looks: its own Project field, My tasks grouped by project, and the project's board.
  test('a subtask made offline takes its parent\'s project, as the server gives it', async () => {
    const client = createApiClient('http://x', 'tok')
    const PARENT = { ...TASK, id: 't_bbbbbbbbbb', title: 'Plan the trip', projectId: 'p_one', sectionId: 's_one' }
    global.fetch.mockResolvedValueOnce(jsonResponse(200, { tasks: [PARENT], total: 1 }))
    await client.listTasks(MY_TASKS_QUERY)
    global.fetch.mockResolvedValueOnce(jsonResponse(200, { task: PARENT, subtasks: [], comments: [] }))
    await client.getTask(PARENT.id)
    global.fetch.mockResolvedValueOnce(jsonResponse(200, { project: { id: 'p_one', name: 'One' }, sections: [], tasks: [PARENT] }))
    await client.getProject('p_one')
    await vi.waitFor(async () => expect(await cacheGet('http://x/api/projects/p_one')).not.toBeNull())
    const sent = []
    global.fetch.mockImplementation(async (url, init) => {
      sent.push(JSON.parse(init.body))
      throw new TypeError('Failed to fetch')
    })

    const { task } = await client.createTask({ title: 'Book the hotel', parentId: PARENT.id })
    expect(task).toMatchObject({ parentId: PARENT.id, projectId: 'p_one', sectionId: null })
    expect((await client.getTask(task.id)).task.projectId).toBe('p_one')
    const mine = (await client.listTasks(MY_TASKS_QUERY)).tasks
    expect(mine.find((t) => t.id === task.id).projectId).toBe('p_one')
    expect((await client.getProject('p_one')).tasks.map((t) => t.id)).toEqual([task.id, PARENT.id])
    expect((await client.getTask(PARENT.id)).subtasks.map((t) => t.id)).toEqual([task.id])
    // The op goes to the server as it was written: the server works the project out itself.
    expect(sent[0]).toMatchObject({ title: 'Book the hotel', parentId: PARENT.id })
    expect(sent[0].projectId).toBeUndefined()

    // A subtask of a task made offline finds its parent in the parent's own stored detail.
    const child = await client.createTask({ title: 'Compare rooms', parentId: task.id })
    expect(child.task.projectId).toBe('p_one')
    // A project named outright is kept, and a parent the copy does not hold gives none.
    expect((await client.createTask({ title: 'Elsewhere', parentId: PARENT.id, projectId: 'p_two' })).task.projectId).toBe('p_two')
    expect((await client.createTask({ title: 'Loose', parentId: TASK.id })).task.projectId).toBeNull()
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
        // The copy's one task has no position, so the new one is numbered after 0.
        expect(sent.ops[1].body).toEqual({ title: 'Made offline', position: 1 })
        // Offline mode must still be on here: nothing may reload before the edits are in.
        expect(getOfflineState().offline).toBe(true)
        return jsonResponse(200, { results: sent.ops.map((o) => ({ opId: o.opId, taskId: o.taskId, status: 'applied', conflicts: [] })) })
      }
      return jsonResponse(200, { events: [], headId: 9 })
    })
    await client.getEvents()

    // The request itself, then the clock reading taken before the queue is sent, then the queue.
    expect(calls).toEqual(['http://x/api/events', 'http://x/api/events?limit=1', 'http://x/api/outbox'])
    expect(getOfflineState()).toMatchObject({ offline: false, pending: 0 })
    expect(getOfflineState().lastSync).toMatchObject({ failed: false, synced: 2, conflicts: [] })
  })

  test('a task made offline is numbered before the first in the copy, shows there, and carries the number to the server', async () => {
    const client = createApiClient('http://x', 'tok')
    global.fetch.mockResolvedValueOnce(jsonResponse(200, {
      tasks: [{ ...TASK, position: 1 }, { ...TASK, id: 't_bbbbbbbbbb', title: 'Second', position: 2.5 }], total: 2,
    }))
    await client.listTasks(MY_TASKS_QUERY)
    global.fetch.mockImplementation(down)

    const { task } = await client.createTask({ title: 'Made offline' })
    expect(task.position).toBe(0)
    expect((await client.listTasks(MY_TASKS_QUERY)).tasks.find((t) => t.id === task.id).position).toBe(0)

    let sent = null
    global.fetch.mockImplementation(async (url, init) => {
      if (url === 'http://x/api/outbox') {
        sent = JSON.parse(init.body)
        return jsonResponse(200, { results: sent.ops.map((o) => ({ opId: o.opId, taskId: o.taskId, status: 'applied', conflicts: [] })) })
      }
      return jsonResponse(200, { events: [], headId: 9 })
    })
    await client.getEvents()
    expect(sent.ops.map((o) => [o.kind, o.body])).toEqual([['create_task', { title: 'Made offline', position: 0 }]])
  })

  test('a subtask made offline is numbered after the last in the copy, so the steps keep their order', async () => {
    const client = createApiClient('http://x', 'tok')
    global.fetch.mockResolvedValueOnce(jsonResponse(200, {
      tasks: [{ ...TASK, position: 1 }, { ...TASK, id: 't_bbbbbbbbbb', title: 'Second', position: 2.5 }], total: 2,
    }))
    await client.listTasks(MY_TASKS_QUERY)
    global.fetch.mockImplementation(down)
    const { task } = await client.createTask({ title: 'A step', parentId: TASK.id })
    expect(task.position).toBe(3.5)
  })

  test('a due time set offline shows in the copy and is replayed as written', async () => {
    const client = createApiClient('http://x', 'tok')
    await seed(client)
    global.fetch.mockImplementation(down)
    const res = await client.updateTask(TASK.id, { dueAt: '2026-09-23T09:30' })
    expect(res.task.dueAt).toBe('2026-09-23T09:30')
    expect((await client.listTasks(MY_TASKS_QUERY)).tasks[0].dueAt).toBe('2026-09-23T09:30')
    const { task: made } = await client.createTask({ title: 'Timed offline', dueAt: '2026-09-24T17:15' })
    expect(made.dueAt).toBe('2026-09-24T17:15')

    let sent = null
    global.fetch.mockImplementation(async (url, init) => {
      if (url === 'http://x/api/outbox') {
        sent = JSON.parse(init.body)
        return jsonResponse(200, { results: sent.ops.map((o) => ({ opId: o.opId, taskId: o.taskId, status: 'applied', conflicts: [] })) })
      }
      return jsonResponse(200, { events: [], headId: 9 })
    })
    await client.getEvents()
    expect(sent.ops.map((o) => [o.kind, o.body.dueAt])).toEqual([
      ['update_task', '2026-09-23T09:30'],
      ['create_task', '2026-09-24T17:15'],
    ])
    expect(getOfflineState()).toMatchObject({ offline: false, pending: 0 })
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

  test('a completion counts as waiting only once the copy shows it', async () => {
    // The weekly UI run of 2026-11-23 reloaded the page the moment "2 changes waiting" showed,
    // which came before the copy was patched, and the completed task came back open.
    const copy = memoryBackend()
    setCacheBackend(copy)
    const local = createApiClient(DEFAULT_BASE_URL, '', { local: true })
    expect((await local.listTasks(MY_TASKS_QUERY)).tasks).toEqual([])
    const { task } = await local.createTask({ title: 'Done before the reload' })
    expect(getOfflineState().pending).toBe(1)

    let arrived
    const atPatch = new Promise((resolve) => { arrived = resolve })
    let release
    const released = new Promise((resolve) => { release = resolve })
    setCacheBackend({ ...copy, put: async (...args) => { arrived(); await released; return copy.put(...args) } })
    const completed = local.completeTask(task.id)
    await atPatch
    // Released whatever the check finds: a write left held would hold every later send too.
    try {
      expect(getOfflineState().pending).toBe(1)
    } finally {
      release()
      await completed
    }
    expect(getOfflineState().pending).toBe(2)
    const reloaded = createApiClient(DEFAULT_BASE_URL, '', { local: true })
    expect((await reloaded.listTasks(MY_TASKS_QUERY)).tasks).toEqual([])
  })

  test('a write still counts as waiting when the copy cannot show it', async () => {
    const copy = memoryBackend()
    setCacheBackend(copy)
    const local = createApiClient(DEFAULT_BASE_URL, '', { local: true })
    const { task } = await local.createTask({ title: 'Kept in the queue' })
    setCacheBackend({ ...copy, put: async () => { throw new Error('disk full') }, entries: async () => { throw new Error('disk full') } })
    await local.completeTask(task.id)
    expect(getOfflineState().pending).toBe(2)
  })

  test('its edits go to no server until one adopts them, then only to that one', async () => {
    await createApiClient('http://x', '', { local: true }).createTask({ title: 'Local' })
    const sentTo = []
    global.fetch.mockImplementation(async (url, init) => {
      // The clock reading a flush takes first is not a send.
      if (url.includes('/api/events')) return jsonResponse(200, { events: [], headId: 1 })
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

// The queue's store also holds the counter that orders it, which is not an edit.
const queuedEntries = async (backend) => (await backend.entries()).filter(([key]) => key !== '!counter')

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
    const [[, op]] = await queuedEntries(backend)
    const sentTo = []
    acceptingServer(sentTo)

    // B reads the local entry, then is held before it writes. A adopts and sends it meanwhile.
    const hold = backend.holdNextWrite()
    const adoptingB = adoptLocalOutbox('http://b')
    await hold.arrived
    expect(await adoptLocalOutbox('http://a')).toBe(1)
    expect(await flushOutbox('http://a', 'tok')).toBe(true)
    expect(await queuedEntries(backend)).toEqual([])

    hold.release()
    expect(await adoptingB).toBe(0)
    expect(await queuedEntries(backend)).toEqual([])
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
    expect((await queuedEntries(backend)).map(([, o]) => o.origin)).toEqual(['http://a'])

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

  test('a create carries the number the copy showed it at, on the first attempt and in the queued copy alike', async () => {
    // If the server saved the first attempt and only the answer was lost, the replay is a duplicate
    // and the server keeps what it has: that has to be the number the device showed, or a move
    // the owner made beside the task would come out reversed.
    const client = createApiClient('http://x', 'tok')
    global.fetch.mockResolvedValueOnce(jsonResponse(200, {
      tasks: [{ ...TASK, position: 1 }, { ...TASK, id: 't_bbbbbbbbbb', title: 'Second', position: 2.5 }], total: 2,
    }))
    await client.listTasks(MY_TASKS_QUERY)
    const first = []
    global.fetch.mockImplementation(async (url, init) => {
      first.push(JSON.parse(init.body))
      throw new TypeError('Failed to fetch')
    })
    const { task } = await client.createTask({ title: 'Submitted once' })
    expect(first[0].position).toBe(0)
    expect(task.position).toBe(0)

    let replayed = null
    global.fetch.mockImplementation(async (url, init) => {
      replayed = JSON.parse(init.body)
      return jsonResponse(200, { results: replayed.ops.map((o) => ({ opId: o.opId, taskId: o.taskId, status: 'duplicate' })) })
    })
    await flushOutbox('http://x', 'tok')
    expect(replayed.ops.map((o) => [o.kind, o.opId, o.body.position])).toEqual([['create_task', first[0].opId, 0]])
  })
})

describe('a create with no number to send', () => {
  // Storage that is present but denied or failing, as a private window or a full disk gives.
  function failingBackend() {
    const denied = async () => { throw new Error('storage denied') }
    return { ...memoryBackend(), get: denied, put: denied, entries: denied, update: denied }
  }

  test('the copy gives 1 when it is empty and no number when it cannot be read', async () => {
    expect(await nextCachedPosition()).toBe(1)
    expect(await nextCachedPosition({ subtask: true })).toBe(1)
    setCacheBackend(failingBackend())
    expect(await nextCachedPosition()).toBeUndefined()
  })

  test('with storage failing, an online create carries no number, and the server places it', async () => {
    // offlineCache.js swallows storage errors so the dashboard keeps working online. The tasks
    // the owner sees were loaded all the same, so a number made up from the copy that could not
    // be read (1, for "nothing stored") would put the new task before them.
    setCacheBackend(failingBackend())
    const client = createApiClient('http://x', 'tok')
    global.fetch.mockResolvedValueOnce(jsonResponse(200, {
      tasks: [{ ...TASK, position: 1 }, { ...TASK, id: 't_bbbbbbbbbb', title: 'Second', position: 2 }], total: 2,
    }))
    expect((await client.listTasks(MY_TASKS_QUERY)).tasks).toHaveLength(2)

    const sent = []
    global.fetch.mockImplementation(async (url, init) => {
      const body = JSON.parse(init.body)
      sent.push(body)
      return jsonResponse(201, { task: { ...TASK, id: body.id, title: body.title, position: 3 } })
    })
    const { task } = await client.createTask({ title: 'Third' })
    expect(sent).toHaveLength(1)
    expect(sent[0]).not.toHaveProperty('position')
    expect(sent[0]).toMatchObject({ title: 'Third', id: task.id, opId: expect.any(String), deviceId: expect.stringMatching(/^dev_/) })
    expect(task.position).toBe(3)
  })

  test('with storage failing, a create made offline is queued without a number too', async () => {
    setCacheBackend(failingBackend())
    const client = createApiClient('http://x', 'tok')
    global.fetch.mockImplementation(down)
    const { task } = await client.createTask({ title: 'Made offline' })
    expect(task).not.toHaveProperty('position')

    let sent = null
    global.fetch.mockImplementation(async (url, init) => {
      sent = JSON.parse(init.body)
      return jsonResponse(200, { results: sent.ops.map((o) => ({ opId: o.opId, taskId: o.taskId, status: 'applied', conflicts: [] })) })
    })
    await flushOutbox('http://x', 'tok')
    expect(sent.ops.map((o) => [o.kind, o.body])).toEqual([['create_task', { title: 'Made offline' }]])
  })

  // What parseBody (http/schemas.ts) answers for a strict schema without the field, from the
  // zod this repo runs and from the one before it.
  test.each([
    'body: Unrecognized key: "position"',
    "body: Unrecognized key(s) in object: 'position'",
  ])('a daemon from before manual ordering refuses the number (%s), and the create is sent again without it', async (message) => {
    const client = createApiClient('http://x', 'tok')
    global.fetch.mockResolvedValueOnce(jsonResponse(200, { tasks: [{ ...TASK, position: 1 }], total: 1 }))
    await client.listTasks(MY_TASKS_QUERY)

    const sent = []
    global.fetch.mockImplementation(async (url, init) => {
      const body = JSON.parse(init.body)
      sent.push(body)
      if ('position' in body) return jsonResponse(400, { error: { code: 'ValidationError', message } })
      return jsonResponse(201, { task: { ...TASK, id: body.id, title: body.title, position: 7 } })
    })
    const { task } = await client.createTask({ title: 'Plain' })
    expect(sent.map((b) => b.position)).toEqual([0, undefined])
    // The same create, so the server that saved the first attempt would call the second a duplicate.
    expect(sent[1]).toMatchObject({ title: 'Plain', id: sent[0].id, opId: sent[0].opId, deviceId: sent[0].deviceId })
    expect(task).toMatchObject({ id: sent[0].id, position: 7 })
    expect(getOfflineState()).toMatchObject({ offline: false, pending: 0 })
  })

  test('any other 400 is the caller\'s, and nothing is sent twice', async () => {
    const client = createApiClient('http://x', 'tok')
    global.fetch.mockResolvedValue(jsonResponse(400, { error: { code: 'ValidationError', message: 'title: title is required' } }))
    await expect(client.createTask({ title: '' })).rejects.toMatchObject({ status: 400, code: 'ValidationError' })
    expect(global.fetch).toHaveBeenCalledTimes(1)
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

  test('a 503 (the server is being updated, or a proxy in front of a stopped one) keeps every edit queued for a later try', async () => {
    await queueComments(2)
    global.fetch.mockImplementation(async () => jsonResponse(503, { error: { code: 'Updating', message: 'Polaris is being updated (started now). Try again in a minute.' } }))
    expect(await flushOutbox('http://x', 'tok')).toBe(false)
    expect(getOfflineState()).toMatchObject({ pending: 2, lastSync: null })
    const server = outboxServer()
    expect(await flushOutbox('http://x', 'tok')).toBe(true)
    expect(server.applied).toHaveLength(2)
    expect(getOfflineState().pending).toBe(0)
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

describe('order and time of a replayed queue', () => {
  const T = Date.now()
  const comment = (text, now) => queueOfflineWrite({ baseUrl: 'http://x', kind: 'add_comment', taskId: TASK.id, body: { body: text } }, now)
  const edit = (priority, now) => queueOfflineWrite({ baseUrl: 'http://x', kind: 'update_task', taskId: TASK.id, body: { priority } }, now)

  // `clock`: undefined answers without a time, a number answers with a server `now` that many ms
  // ahead of the device, 'down' fails the reading, 'hang' never answers it. `outbox` is the
  // status of the POST.
  function server({ clock, outbox = 200 } = {}) {
    const posted = []
    global.fetch.mockImplementation(async (url, init) => {
      if (url.includes('/api/events')) {
        if (clock === 'down') throw new TypeError('Failed to fetch')
        if (clock === 'hang') return new Promise(() => {})
        const body = typeof clock === 'number' ? { events: [], headId: 1, now: new Date(Date.now() + clock).toISOString() } : { events: [], headId: 1 }
        return jsonResponse(200, body)
      }
      if (outbox !== 200) return jsonResponse(outbox, { error: { message: 'no' } })
      const sent = JSON.parse(init.body)
      posted.push(sent.ops)
      return jsonResponse(200, { results: sent.ops.map((o) => ({ opId: o.opId, taskId: o.taskId, status: 'applied', conflicts: [] })) })
    })
    return posted
  }

  const ms = (iso) => Date.parse(iso)

  test('a clock set back while offline does not reorder edits: the first one made is sent first', async () => {
    await edit('high', T + 8 * 60 * 1000)
    await edit('low', T)
    const posted = server()
    expect(await flushOutbox('http://x', 'tok')).toBe(true)
    expect(posted).toHaveLength(1)
    expect(posted[0].map((o) => o.body.priority)).toEqual(['high', 'low'])
    // The later edit also carries the later time, so the server's merge keeps it.
    expect(ms(posted[0][1].at)).toBeGreaterThan(ms(posted[0][0].at))
  })

  test('writes made one after another without waiting are sent in the order they were made', async () => {
    // A new task takes longer to queue than an edit: it works out its place by reading the whole
    // copy, which is slow here, while an edit finds its task with one quick read. The new task
    // must still go first: its place in the queue is taken before anything else is awaited.
    const copy = memoryBackend()
    await copy.put(`http://x/api/tasks/${TASK.id}`, { data: { task: TASK, subtasks: [], comments: [] }, savedAt: T })
    setCacheBackend({ ...copy, entries: async () => { await new Promise((r) => setTimeout(r, 15)); return copy.entries() } })
    const created = queueOfflineWrite({ baseUrl: 'http://x', myTasksUrl: 'http://x/api/tasks', kind: 'create_task', taskId: 't_made0ffline', body: { title: 'First' } }, T)
    const edited = edit('high', T)
    const commented = comment('third', T)
    await Promise.all([created, edited, commented])
    const posted = server()
    await flushOutbox('http://x', 'tok')
    expect(posted[0].map((o) => o.kind)).toEqual(['create_task', 'update_task', 'add_comment'])
  })

  test('edits started together with one reading are all kept and sent in one consistent order', async () => {
    const backend = memoryBackend()
    setOutboxBackend(backend)
    await Promise.all(['a', 'b', 'c', 'd', 'e'].map((t) => comment(t, T)))
    const keys = (await backend.entries()).map(([k]) => k).filter((k) => k !== '!counter')
    expect(keys).toHaveLength(5)
    expect(new Set(keys).size).toBe(5)
    const queued = (await backend.entries()).filter(([k]) => k !== '!counter').sort(([a], [b]) => (a < b ? -1 : 1)).map(([, o]) => o.body.body)

    const posted = server()
    await flushOutbox('http://x', 'tok')
    expect(posted[0].map((o) => o.body.body)).toEqual(queued)
    expect([...queued].sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  test('an entry under the old key format is sent before the ones queued now', async () => {
    const backend = memoryBackend()
    setOutboxBackend(backend)
    await backend.put('000001700000000-000001', { origin: 'http://x', opId: 'op_old', kind: 'add_comment', taskId: TASK.id, at: new Date(T + 1000).toISOString(), base: null, body: { body: 'old' } })
    await comment('new', 1000)
    const posted = server()
    await flushOutbox('http://x', 'tok')
    expect(posted[0].map((o) => o.body.body)).toEqual(['old', 'new'])
  })

  test('an edit from a tab on the old key format, made after one from this version, is sent after it and wins', async () => {
    const backend = memoryBackend()
    setOutboxBackend(backend)
    await edit('high', T)
    // An old tab keys by its own clock, which is later than the moment the first edit was queued.
    await backend.put(`${String(Date.now() + 5).padStart(15, '0')}-000000`, { origin: 'http://x', opId: 'op_old', kind: 'update_task', taskId: TASK.id, at: new Date(T + 1000).toISOString(), base: null, body: { priority: 'low' } })
    const posted = server()
    await flushOutbox('http://x', 'tok')
    expect(posted[0].map((o) => o.body.priority)).toEqual(['high', 'low'])
    expect(ms(posted[0][1].at)).toBeGreaterThan(ms(posted[0][0].at))
  })

  test('an old tab writing in the same millisecond as this version never replaces one of its edits', async () => {
    const backend = memoryBackend()
    setOutboxBackend(backend)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(T)
      await edit('high', T)
      await edit('medium', T)
      // An old tab's first key in this millisecond, and its second: the sequences this version used.
      for (const [seq, priority] of [['000000', 'low'], ['000001', 'urgent']]) {
        await backend.put(`${String(T).padStart(15, '0')}-${seq}`, { origin: 'http://x', opId: `op_old${seq}`, kind: 'update_task', taskId: TASK.id, at: new Date(T).toISOString(), base: null, body: { priority } })
      }
      const keys = (await backend.entries()).map(([key]) => key).filter((key) => !key.startsWith('!'))
      expect(keys).toHaveLength(4)
    } finally {
      vi.useRealTimers()
    }
    const posted = server()
    await flushOutbox('http://x', 'tok')
    expect(posted[0].map((o) => o.body.priority).sort()).toEqual(['high', 'low', 'medium', 'urgent'])
  })

  test('with the server ten minutes ahead, the times sent are the device readings plus ten minutes and the stored ops are untouched', async () => {
    const backend = memoryBackend()
    setOutboxBackend(backend)
    await comment('one', T - 5000)
    await comment('two', T - 3000)
    const storedAts = async () => (await backend.entries()).filter(([k]) => k !== '!counter').sort(([a], [b]) => (a < b ? -1 : 1)).map(([, o]) => o.at)
    const before = await storedAts()
    expect(before).toEqual([new Date(T - 5000).toISOString(), new Date(T - 3000).toISOString()])

    const posted = server({ clock: 10 * 60 * 1000 })
    await flushOutbox('http://x', 'tok')
    expect(Math.abs(ms(posted[0][0].at) - (T - 5000 + 10 * 60 * 1000))).toBeLessThan(2000)
    expect(Math.abs(ms(posted[0][1].at) - (T - 3000 + 10 * 60 * 1000))).toBeLessThan(2000)

    // What stays queued keeps the device's own reading: a refused send changes nothing stored.
    await comment('three', T - 1000)
    server({ clock: 10 * 60 * 1000, outbox: 503 })
    await flushOutbox('http://x', 'tok')
    expect(await storedAts()).toEqual([new Date(T - 1000).toISOString()])
  })

  test('readings that go backwards are sent as strictly rising times', async () => {
    await comment('a', T - 1000)
    await comment('b', T - 2000)
    await comment('c', T - 2000)
    await comment('d', T - 9000)
    const posted = server()
    await flushOutbox('http://x', 'tok')
    const times = posted[0].map((o) => ms(o.at))
    expect(posted[0].map((o) => o.body.body)).toEqual(['a', 'b', 'c', 'd'])
    for (let i = 1; i < times.length; i += 1) expect(times[i]).toBeGreaterThan(times[i - 1])
  })

  test('a failed reading falls back to the stored offset, then to the raw readings', async () => {
    // Nothing stored and the reading fails: the raw readings go, in rising order.
    await comment('a', T - 4000)
    await comment('b', T - 3000)
    const posted = server({ clock: 'down' })
    await flushOutbox('http://x', 'tok')
    expect(posted[0].map((o) => o.at)).toEqual([new Date(T - 4000).toISOString(), new Date(T - 3000).toISOString()])

    // A reading that works but a POST that fails leaves an offset stored.
    await comment('c', T - 2000)
    server({ clock: 10 * 60 * 1000, outbox: 503 })
    await flushOutbox('http://x', 'tok')
    const again = server({ clock: 'down' })
    await flushOutbox('http://x', 'tok')
    expect(Math.abs(ms(again[0][0].at) - (T - 2000 + 10 * 60 * 1000))).toBeLessThan(2000)
  })

  test('a stored reading more than an hour old does not stand in for a failed one', async () => {
    // Two hours ago the server read ten minutes ahead. Nothing says that still holds.
    const then = Date.now() - 2 * 60 * 60 * 1000
    noteServerTime('http://x', new Date(then + 10 * 60 * 1000).toISOString(), then, then)
    await comment('a', T - 4000)
    const posted = server({ clock: 'down' })
    await flushOutbox('http://x', 'tok')
    expect(posted[0][0].at).toBe(new Date(T - 4000).toISOString())
  })

  test('a send that starts while a write is still being queued takes that write with it', async () => {
    // The write has its place in the queue and is still reading the copy, slowly, when the send
    // starts. Sent now, it goes before anything made after it; left for the next send, it would not.
    const copy = memoryBackend()
    setCacheBackend({ ...copy, entries: async () => { await new Promise((r) => setTimeout(r, 15)); return copy.entries() } })
    const created = queueOfflineWrite({ baseUrl: 'http://x', myTasksUrl: 'http://x/api/tasks', kind: 'create_task', taskId: 't_made0ffline', body: { title: 'First' } }, T)
    const posted = server()
    const sent = flushOutbox('http://x', 'tok')
    await created
    expect(await sent).toBe(true)
    expect(posted.flat().map((o) => o.kind)).toEqual(['create_task'])
  })

  test('a reading that never answers does not hold the send past the timeout', async () => {
    await comment('a', T - 4000)
    const posted = server({ clock: 'hang' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const done = flushOutbox('http://x', 'tok')
      await vi.advanceTimersByTimeAsync(2600)
      expect(await done).toBe(true)
    } finally {
      vi.useRealTimers()
    }
    expect(posted).toHaveLength(1)
    expect(posted[0][0].at).toBe(new Date(T - 4000).toISOString())
  })

  test('a later flush starts above the last time an earlier one sent', async () => {
    await comment('first', T - 1000)
    const posted = server()
    await flushOutbox('http://x', 'tok')
    const last = ms(posted[0][0].at)

    // The device clock was set back before this edit was made.
    await comment('second', T - 5000)
    await flushOutbox('http://x', 'tok')
    expect(ms(posted[1][0].at)).toBe(last + 1)
  })
})

describe('the floor kept between sends', () => {
  const S = Date.UTC(2026, 10, 19, 12, 0, 0)

  test('is the server time of the send, not a time that was in the future', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(S)
      const posted = []
      global.fetch.mockImplementation(async (url, init) => {
        if (url.includes('/api/events')) return jsonResponse(200, { events: [], headId: 1 })
        const sent = JSON.parse(init.body)
        posted.push(sent.ops)
        return jsonResponse(200, { results: sent.ops.map((o) => ({ opId: o.opId, taskId: o.taskId, status: 'applied', conflicts: [] })) })
      })
      // Read ten minutes ahead of the true time: the server applies it as its own now, S.
      await queueOfflineWrite({ baseUrl: 'http://x', kind: 'add_comment', taskId: TASK.id, body: { body: 'early' } }, S + 10 * 60 * 1000)
      await flushOutbox('http://x', 'tok')

      // A later offline interval. The edit was made at S + 30s and sent at S + 60s: it keeps its time,
      // so it does not beat a newer edit from another device made between the two.
      vi.setSystemTime(S + 60 * 1000)
      await queueOfflineWrite({ baseUrl: 'http://x', kind: 'add_comment', taskId: 't_other', body: { body: 'later' } }, S + 30 * 1000)
      await flushOutbox('http://x', 'tok')
      expect(posted).toHaveLength(2)
      expect(Date.parse(posted[1][0].at)).toBe(S + 30 * 1000)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('generated ids', () => {
  test('have the expected prefix, length and alphabet', () => {
    for (let i = 0; i < 50; i++) {
      expect(newOpId()).toMatch(/^op_[0-9a-z]{16}$/)
      expect(newTaskId()).toMatch(/^t_[0-9a-z]{10}$/)
    }
  })
})

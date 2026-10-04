import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { defaultBaseUrl, DEFAULT_BASE_URL, ApiError, createApiClient } from './api'
import { memoryBackend, setCacheBackend } from './offlineCache'

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  }
}

function rawResponse(status, text) {
  return { ok: status >= 200 && status < 300, status, text: async () => text }
}

beforeEach(() => {
  global.fetch = vi.fn()
  setCacheBackend(memoryBackend())
})

describe('defaultBaseUrl', () => {
  test('returns the local dev server address while import.meta.env.DEV is true', () => {
    const original = import.meta.env.DEV
    import.meta.env.DEV = true
    try {
      expect(defaultBaseUrl()).toBe('http://127.0.0.1:8788')
    } finally {
      import.meta.env.DEV = original
    }
  })

  test('returns the page origin in a non-dev build with a window present', () => {
    const original = import.meta.env.DEV
    import.meta.env.DEV = false
    try {
      expect(defaultBaseUrl()).toBe(window.location.origin)
    } finally {
      import.meta.env.DEV = original
    }
  })

  test('returns an empty string inside the Android app, where the origin is not a server', () => {
    const original = import.meta.env.DEV
    import.meta.env.DEV = false
    window.Capacitor = { isNativePlatform: () => true }
    try {
      expect(defaultBaseUrl()).toBe('')
    } finally {
      import.meta.env.DEV = original
      delete window.Capacitor
    }
  })

  test('falls back to the dev server address when window is undefined, even outside dev', () => {
    const original = import.meta.env.DEV
    import.meta.env.DEV = false
    vi.stubGlobal('window', undefined)
    try {
      expect(defaultBaseUrl()).toBe('http://127.0.0.1:8788')
    } finally {
      import.meta.env.DEV = original
      vi.unstubAllGlobals()
    }
  })
})

describe('DEFAULT_BASE_URL', () => {
  test('is precomputed at module load time using the dev default', () => {
    // The test runner loads this module in dev mode, so DEV is true at
    // import time regardless of what later tests mutate it to.
    expect(DEFAULT_BASE_URL).toBe('http://127.0.0.1:8788')
  })
})

describe('ApiError', () => {
  test('is an instance of both ApiError and Error', () => {
    const err = new ApiError('boom', 'boom_code', 500)
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.name).toBe('ApiError')
  })

  test('stores the given message, code, and status', () => {
    const err = new ApiError('Not found', 'not_found', 404)
    expect(err.message).toBe('Not found')
    expect(err.code).toBe('not_found')
    expect(err.status).toBe(404)
  })

  test('defaults code to "unknown_error" and status to 0 when omitted', () => {
    const err = new ApiError('Something broke')
    expect(err.code).toBe('unknown_error')
    expect(err.status).toBe(0)
  })

  test('defaults code to "unknown_error" for a falsy empty-string code', () => {
    const err = new ApiError('msg', '', 500)
    expect(err.code).toBe('unknown_error')
  })
})

describe('createApiClient: request construction', () => {
  test('builds the URL by joining baseUrl and path', async () => {
    global.fetch.mockResolvedValue(jsonResponse(200, { ok: true }))
    const client = createApiClient('http://localhost:9999', null)
    await client.health()
    expect(global.fetch).toHaveBeenCalledWith('http://localhost:9999/api/health', expect.any(Object))
  })

  test('trims one or more trailing slashes off the base URL', async () => {
    global.fetch.mockResolvedValue(jsonResponse(200, {}))
    const client = createApiClient('http://localhost:9999///', null)
    await client.health()
    expect(global.fetch.mock.calls[0][0]).toBe('http://localhost:9999/api/health')
  })

  test('treats a missing base URL as empty, producing a path-relative URL', async () => {
    global.fetch.mockResolvedValue(jsonResponse(200, {}))
    const client = createApiClient(undefined, null)
    await client.health()
    expect(global.fetch.mock.calls[0][0]).toBe('/api/health')
  })

  test('always sends a JSON content-type header', async () => {
    global.fetch.mockResolvedValue(jsonResponse(200, {}))
    const client = createApiClient('http://x', null)
    await client.health()
    const [, opts] = global.fetch.mock.calls[0]
    expect(opts.headers['Content-Type']).toBe('application/json')
  })

  test('adds a bearer Authorization header when a token is provided', async () => {
    global.fetch.mockResolvedValue(jsonResponse(200, {}))
    const client = createApiClient('http://x', 'secret-token')
    await client.health()
    const [, opts] = global.fetch.mock.calls[0]
    expect(opts.headers.Authorization).toBe('Bearer secret-token')
  })

  test('omits the Authorization header when there is no token', async () => {
    global.fetch.mockResolvedValue(jsonResponse(200, {}))
    const client = createApiClient('http://x', null)
    await client.health()
    const [, opts] = global.fetch.mock.calls[0]
    expect(opts.headers.Authorization).toBeUndefined()
  })

  test('omits the Authorization header for an empty-string token', async () => {
    global.fetch.mockResolvedValue(jsonResponse(200, {}))
    const client = createApiClient('http://x', '')
    await client.health()
    const [, opts] = global.fetch.mock.calls[0]
    expect(opts.headers.Authorization).toBeUndefined()
  })

  test('serializes a body object to JSON', async () => {
    global.fetch.mockResolvedValue(jsonResponse(200, {}))
    const client = createApiClient('http://x', null)
    await client.updateTask('t1', { title: 'New task', priority: 'high' })
    const [, opts] = global.fetch.mock.calls[0]
    expect(opts.body).toBe(JSON.stringify({ title: 'New task', priority: 'high' }))
  })

  test('sends no body for a call with no payload', async () => {
    global.fetch.mockResolvedValue(jsonResponse(200, {}))
    const client = createApiClient('http://x', null)
    await client.completeTask('t1')
    const [, opts] = global.fetch.mock.calls[0]
    expect(opts.body).toBeUndefined()
  })

  test('builds a query string, skipping undefined, null, and empty-string values', async () => {
    global.fetch.mockResolvedValue(jsonResponse(200, {}))
    const client = createApiClient('http://x', null)
    await client.listTasks({ status: 'open', projectId: undefined, note: null, tag: '', limit: 5 })
    const url = global.fetch.mock.calls[0][0]
    expect(url).toBe('http://x/api/tasks?status=open&limit=5')
  })

  test('includes falsy-but-meaningful query values like 0 and false', async () => {
    global.fetch.mockResolvedValue(jsonResponse(200, {}))
    const client = createApiClient('http://x', null)
    await client.listTasks({ enabled: false, count: 0 })
    const url = global.fetch.mock.calls[0][0]
    expect(url).toBe('http://x/api/tasks?enabled=false&count=0')
  })

  test('sends no query string at all when query is omitted', async () => {
    global.fetch.mockResolvedValue(jsonResponse(200, {}))
    const client = createApiClient('http://x', null)
    await client.listTasks()
    const url = global.fetch.mock.calls[0][0]
    expect(url).toBe('http://x/api/tasks')
  })
})

describe('createApiClient: response handling', () => {
  test('resolves with the parsed JSON body on a 2xx response', async () => {
    global.fetch.mockResolvedValue(jsonResponse(200, { id: 't1', title: 'Task' }))
    const client = createApiClient('http://x', null)
    const result = await client.getTask('t1')
    expect(result).toEqual({ id: 't1', title: 'Task' })
  })

  test('resolves with null when a 2xx response has an empty body', async () => {
    global.fetch.mockResolvedValue(rawResponse(200, ''))
    const client = createApiClient('http://x', null)
    const result = await client.completeTask('t1')
    expect(result).toBeNull()
  })

  test('resolves with null when a 2xx response body is not valid JSON', async () => {
    global.fetch.mockResolvedValue(rawResponse(200, 'not json at all'))
    const client = createApiClient('http://x', null)
    const result = await client.getTask('t1')
    expect(result).toBeNull()
  })

  test('rejects with an ApiError built from the response error envelope on a non-2xx status', async () => {
    global.fetch.mockResolvedValue(jsonResponse(404, { error: { message: 'Task not found', code: 'task_not_found' } }))
    const client = createApiClient('http://x', null)
    await expect(client.getTask('missing')).rejects.toMatchObject({
      name: 'ApiError',
      message: 'Task not found',
      code: 'task_not_found',
      status: 404,
    })
  })

  test('falls back to a generic message and code when the error body is empty', async () => {
    global.fetch.mockResolvedValue(rawResponse(500, ''))
    const client = createApiClient('http://x', null)
    await expect(client.getTask('t1')).rejects.toMatchObject({
      message: 'Request failed (500)',
      code: 'unknown_error',
      status: 500,
    })
  })

  test('falls back to a generic message and code when the error body is not valid JSON', async () => {
    global.fetch.mockResolvedValue(rawResponse(500, '<html>Server Error</html>'))
    const client = createApiClient('http://x', null)
    await expect(client.getTask('t1')).rejects.toMatchObject({
      message: 'Request failed (500)',
      code: 'unknown_error',
      status: 500,
    })
  })

  test('rejects with a network_error ApiError when fetch itself throws', async () => {
    global.fetch.mockRejectedValue(new TypeError('Failed to fetch'))
    const client = createApiClient('http://x', null)
    await expect(client.getTask('t1')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'network_error',
      status: 0,
      message: 'Could not reach the Command Center server. Check the URL and make sure it is running.',
    })
  })
})

describe('createApiClient: every endpoint method', () => {
  const cases = [
    ['health', (c) => c.health(), '/api/health', 'GET', undefined],
    ['listProjects (no args)', (c) => c.listProjects(), '/api/projects', 'GET', undefined],
    ['listProjects (includeArchived)', (c) => c.listProjects({ includeArchived: true }), '/api/projects?includeArchived=1', 'GET', undefined],
    ['getProject', (c) => c.getProject('proj/1'), '/api/projects/proj%2F1', 'GET', undefined],
    ['createProject', (c) => c.createProject({ name: 'Garden' }), '/api/projects', 'POST', { name: 'Garden' }],
    ['updateProject', (c) => c.updateProject('garden', { status: 'Active' }), '/api/projects/garden', 'PATCH', { status: 'Active' }],
    ['listTasks (no query)', (c) => c.listTasks(), '/api/tasks', 'GET', undefined],
    ['getTask', (c) => c.getTask('t1'), '/api/tasks/t1', 'GET', undefined],
    ['createTask', (c) => c.createTask({ title: 'New' }), '/api/tasks', 'POST', { title: 'New' }],
    ['updateTask', (c) => c.updateTask('t1', { title: 'Upd' }), '/api/tasks/t1', 'PATCH', { title: 'Upd' }],
    ['completeTask', (c) => c.completeTask('t1'), '/api/tasks/t1/complete', 'POST', undefined],
    ['reopenTask', (c) => c.reopenTask('t1'), '/api/tasks/t1/reopen', 'POST', undefined],
    ['moveTask', (c) => c.moveTask('t1', { projectId: 'p2' }), '/api/tasks/t1/move', 'POST', { projectId: 'p2' }],
    ['addComment', (c) => c.addComment('t1', 'hello'), '/api/tasks/t1/comments', 'POST', { body: 'hello' }],
    ['listInbox', (c) => c.listInbox(), '/api/inbox', 'GET', undefined],
    ['acceptInboxItem (no payload)', (c) => c.acceptInboxItem('i1'), '/api/inbox/i1/accept', 'POST', {}],
    ['acceptInboxItem (payload)', (c) => c.acceptInboxItem('i1', { note: 'ok' }), '/api/inbox/i1/accept', 'POST', { note: 'ok' }],
    ['rejectInboxItem (no payload)', (c) => c.rejectInboxItem('i1'), '/api/inbox/i1/reject', 'POST', {}],
    ['listViews', (c) => c.listViews(), '/api/views', 'GET', undefined],
    ['getView', (c) => c.getView('board'), '/api/views/board', 'GET', undefined],
    ['listRules', (c) => c.listRules(), '/api/rules', 'GET', undefined],
    ['createRule', (c) => c.createRule({ name: 'r' }), '/api/rules', 'POST', { name: 'r' }],
    ['updateRule', (c) => c.updateRule('r1', { name: 'r2' }), '/api/rules/r1', 'PATCH', { name: 'r2' }],
    ['deleteRule', (c) => c.deleteRule('r1'), '/api/rules/r1', 'DELETE', undefined],
    ['runRules', (c) => c.runRules({ dryRun: true }), '/api/rules/run', 'POST', { dryRun: true }],
    ['getDigest', (c) => c.getDigest(), '/api/digest', 'GET', undefined],
    ['listGoals (open only)', (c) => c.listGoals(), '/api/goals', 'GET', undefined],
    ['listGoals (with closed)', (c) => c.listGoals(true), '/api/goals?includeClosed=1', 'GET', undefined],
    ['getGoal', (c) => c.getGoal('g 1'), '/api/goals/g%201', 'GET', undefined],
    ['createGoal', (c) => c.createGoal({ title: 'x' }), '/api/goals', 'POST', { title: 'x' }],
    ['updateGoal', (c) => c.updateGoal('g1', { status: 'at_risk' }), '/api/goals/g1', 'PATCH', { status: 'at_risk' }],
    ['deleteGoal', (c) => c.deleteGoal('g1'), '/api/goals/g1', 'DELETE', undefined],
    ['linkGoal', (c) => c.linkGoal('g1', { project: 'octavium' }), '/api/goals/g1/links', 'POST', { project: 'octavium' }],
    ['unlinkGoal', (c) => c.unlinkGoal('g1', { taskId: 't1' }), '/api/goals/g1/unlink', 'POST', { taskId: 't1' }],
    ['setGoalVision', (c) => c.setGoalVision('Ship it'), '/api/goal-vision', 'PATCH', { text: 'Ship it' }],
    ['getEvents (no args)', (c) => c.getEvents(), '/api/events', 'GET', undefined],
    ['getEvents (after only)', (c) => c.getEvents('evt5'), '/api/events?after=evt5', 'GET', undefined],
    ['getEvents (after and limit)', (c) => c.getEvents('evt5', 10), '/api/events?after=evt5&limit=10', 'GET', undefined],
    ['getSync', (c) => c.getSync(), '/api/sync', 'GET', undefined],
    ['runSync', (c) => c.runSync('job1'), '/api/sync/job1', 'POST', undefined],
    ['getAgentSettings', (c) => c.getAgentSettings(), '/api/settings/agent', 'GET', undefined],
    ['updateAgentSettings', (c) => c.updateAgentSettings({ defaultAgentName: 'scribe' }), '/api/settings/agent', 'PATCH', { defaultAgentName: 'scribe' }],
    ['githubStatus', (c) => c.githubStatus(), '/api/github/status', 'GET', undefined],
    ['githubAppManifest', (c) => c.githubAppManifest(), '/api/github/app/manifest', 'POST', {}],
    ['githubLogin', (c) => c.githubLogin(), '/api/github/login', 'POST', {}],
    ['githubLogout', (c) => c.githubLogout(), '/api/github/logout', 'POST', undefined],
    ['githubForgetApp', (c) => c.githubForgetApp(), '/api/github/app/forget', 'POST', undefined],
    ['githubRepos', (c) => c.githubRepos(), '/api/github/repos', 'GET', undefined],
    ['updateGithubRepo (owner/repo)', (c) => c.updateGithubRepo('owner/repo', { private: true }), '/api/github/repos/owner/repo', 'PATCH', { private: true }],
    ['updateGithubRepo (tracked)', (c) => c.updateGithubRepo('owner/repo', { tracked: true }), '/api/github/repos/owner/repo', 'PATCH', { tracked: true }],
  ]

  test.each(cases)('%s calls the expected path, method, and body', async (_name, invoke, expectedPath, expectedMethod, expectedBody) => {
    global.fetch.mockResolvedValue(jsonResponse(200, { ok: true }))
    const client = createApiClient('http://x', null)
    await invoke(client)
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe(`http://x${expectedPath}`)
    expect(opts.method ?? 'GET').toBe(expectedMethod)
    if (expectedBody === undefined) {
      expect(opts.body).toBeUndefined()
    } else {
      // A create and a comment also carry the identity they would be replayed under.
      const { opId, deviceId, id, ...sent } = JSON.parse(opts.body)
      expect(sent).toEqual(expectedBody)
      if (opId !== undefined) {
        expect(opId).toMatch(/^op_[0-9a-z]{16}$/)
        expect(deviceId).toMatch(/^dev_/)
      }
    }
  })

  test('updateGithubRepo with no slash in fullName treats the whole string as owner and repo as empty', async () => {
    global.fetch.mockResolvedValue(jsonResponse(200, {}))
    const client = createApiClient('http://x', null)
    await client.updateGithubRepo('reponame', { private: true })
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe('http://x/api/github/repos/reponame/')
    expect(opts.method).toBe('PATCH')
    expect(opts.body).toBe(JSON.stringify({ private: true }))
  })
})

// Like the backup settings endpoints, updateAgentSettings carries no `offline` kind: a default
// agent name typed with no server to tell is refused outright, never queued to replay later
// against whichever server answers next.
describe('createApiClient: updateAgentSettings is live-only', () => {
  test('a PATCH sent while the server cannot be reached is refused, not queued', async () => {
    global.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const client = createApiClient('http://x', 'tok')
    await expect(client.updateAgentSettings({ defaultAgentName: 'scribe' })).rejects.toMatchObject({
      code: 'network_error',
      message: expect.stringContaining('not saved'),
    })
  })

  test('getAgentSettings is cached like other GETs, and answers from the copy when offline', async () => {
    const client = createApiClient('http://x', 'tok')
    global.fetch.mockResolvedValueOnce(jsonResponse(200, { defaultAgentName: 'claude-code' }))
    expect(await client.getAgentSettings()).toEqual({ defaultAgentName: 'claude-code' })

    global.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect(await client.getAgentSettings()).toEqual({ defaultAgentName: 'claude-code' })
  })
})

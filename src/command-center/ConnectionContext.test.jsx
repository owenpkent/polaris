import { describe, test, expect, afterEach, beforeEach, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { DEFAULT_BASE_URL, MY_TASKS_QUERY } from './api'
import { ConnectionProvider, isAllowedHandoffUrl, useConnection } from './ConnectionContext'
import { memoryBackend, setCacheBackend } from './offlineCache'
import { getOfflineState, resetOfflineStatus } from './offlineStatus'
import { setOutboxBackend } from './outbox'

// mockup.mjs opens the dashboard with #cc-url=...&cc-token=... so it can connect without a
// paste. Anyone else can append the same fragment to a link, so the url it names is only honoured
// when it points at the machine the dashboard is already talking to.
function atOrigin(origin, fn) {
  vi.stubGlobal('location', new URL(origin))
  try {
    return fn()
  } finally {
    vi.unstubAllGlobals()
  }
}

describe('isAllowedHandoffUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('accepts loopback, which is what mockup.mjs sends', () => {
    atOrigin('http://127.0.0.1:8788/', () => {
      expect(isAllowedHandoffUrl('http://127.0.0.1:8790')).toBe(true)
      expect(isAllowedHandoffUrl('http://localhost:8790')).toBe(true)
    })
  })

  test('accepts the origin the dashboard is served from, which is how the tailnet reaches it', () => {
    atOrigin('http://cc.tailnet.ts.net/', () => {
      expect(isAllowedHandoffUrl('http://cc.tailnet.ts.net/')).toBe(true)
    })
  })

  test('refuses another host', () => {
    // Accepting this would repoint the dashboard at the attacker, persist it over the saved
    // connection, and keep sending the owner's edits there until they retyped the real URL in Settings.
    atOrigin('http://cc.tailnet.ts.net/', () => {
      expect(isAllowedHandoffUrl('https://attacker.example')).toBe(false)
      expect(isAllowedHandoffUrl('http://127.0.0.1.attacker.example')).toBe(false)
    })
  })

  test('refuses a non-http scheme', () => {
    atOrigin('http://127.0.0.1:8788/', () => {
      expect(isAllowedHandoffUrl('javascript:alert(1)')).toBe(false)
      expect(isAllowedHandoffUrl('data:text/html,x')).toBe(false)
      expect(isAllowedHandoffUrl('file:///etc/passwd')).toBe(false)
    })
  })

  test('refuses anything that is not a url', () => {
    atOrigin('http://127.0.0.1:8788/', () => {
      expect(isAllowedHandoffUrl('')).toBe(false)
      expect(isAllowedHandoffUrl('not a url at all')).toBe(false)
    })
  })
})

describe('ConnectionProvider with no saved connection', () => {
  let ctx = null
  function Probe() {
    ctx = useConnection()
    return null
  }

  beforeEach(() => {
    localStorage.clear()
    setCacheBackend(memoryBackend())
    setOutboxBackend(memoryBackend())
    resetOfflineStatus()
    global.fetch = vi.fn()
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  test('starts local, and the first server it connects to gets what was made before', async () => {
    render(<ConnectionProvider><Probe /></ConnectionProvider>)
    expect(ctx).toMatchObject({ connected: false, local: true })
    await act(() => ctx.api.createTask({ title: 'Before connecting' }))
    expect(global.fetch).not.toHaveBeenCalled()

    global.fetch.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ version: '1', today: '2026-09-26', counts: { inbox: 0 } }) })
    await act(() => ctx.saveSettings('http://cc.test', 'tok'))
    expect(ctx).toMatchObject({ connected: true, local: false })
    expect(ctx.testResult.message).toMatch(/Sending 1 change made before connecting\./)
    expect(getOfflineState().pending).toBe(1)
  })

  test('tasks made after Disconnect from another address are still there after a reload', async () => {
    // Disconnect leaves the old address in the provider, and a reload starts at the default. The
    // local copy must be found under both, or the task vanishes while the banner still counts it.
    const cache = memoryBackend()
    setCacheBackend(cache)
    global.fetch.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ version: '1', today: '2026-09-26', counts: { inbox: 0 } }) })
    const { unmount } = render(<ConnectionProvider><Probe /></ConnectionProvider>)
    await act(() => ctx.saveSettings('http://cc.test:9000', 'tok'))
    expect(ctx).toMatchObject({ connected: true, baseUrl: 'http://cc.test:9000' })
    await act(async () => ctx.disconnect())
    expect(ctx).toMatchObject({ connected: false, local: true, baseUrl: 'http://cc.test:9000' })

    // Back on My tasks, which lists first, then a task due today and a comment on it.
    expect((await ctx.api.listTasks(MY_TASKS_QUERY)).tasks).toEqual([])
    let made = null
    await act(async () => { made = (await ctx.api.createTask({ title: 'Made after disconnecting', dueAt: '2026-09-26' })).task })
    await act(() => ctx.api.addComment(made.id, 'a note'))
    expect(getOfflineState().pending).toBe(2)

    // The reload: a fresh provider on the same browser storage, with nothing saved.
    unmount()
    render(<ConnectionProvider><Probe /></ConnectionProvider>)
    expect(ctx).toMatchObject({ local: true, baseUrl: DEFAULT_BASE_URL })
    expect((await ctx.api.listTasks(MY_TASKS_QUERY)).tasks.map((t) => t.id)).toEqual([made.id])
    expect((await ctx.api.getTask(made.id)).comments.map((c) => c.body)).toEqual(['a note'])
    await vi.waitFor(() => expect(getOfflineState().pending).toBe(2))
  })

  test('a saved connection that fails its test is not local', async () => {
    localStorage.setItem('cc-connection-v1', JSON.stringify({ baseUrl: 'http://cc.test', token: 'old', connected: true }))
    global.fetch.mockResolvedValue({ ok: false, status: 401, text: async () => JSON.stringify({ error: { code: 'unauthorized', message: 'no' } }) })
    render(<ConnectionProvider><Probe /></ConnectionProvider>)
    await act(() => ctx.saveSettings('http://cc.test', 'wrong'))
    expect(ctx).toMatchObject({ connected: false, local: false })
  })
})

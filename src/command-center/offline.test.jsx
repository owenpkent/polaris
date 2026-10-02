import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, act } from '@testing-library/react'
import { createApiClient } from './api'
import { cacheClear, cacheGet, memoryBackend, setCacheBackend } from './offlineCache'
import { getOfflineState, markOffline, markOnline, resetOfflineStatus, STALE_AFTER_MS } from './offlineStatus'
import { setOutboxBackend } from './outbox'

vi.mock('./ConnectionContext', () => ({ useConnection: () => ({ connected: true, baseUrl: 'http://x', token: 'tok' }) }))
vi.mock('./useMirrorWarm', () => ({ useMirrorWarm: () => {} }))

const { default: OfflineBanner } = await import('../OfflineBanner')

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }
}

beforeEach(() => {
  global.fetch = vi.fn()
  setCacheBackend(memoryBackend())
  setOutboxBackend(memoryBackend())
  resetOfflineStatus()
})

afterEach(() => cleanup())

describe('api offline fallback', () => {
  test('a GET that succeeded is answered from the local copy when the server is unreachable', async () => {
    const client = createApiClient('http://x', 'tok')
    global.fetch.mockResolvedValueOnce(jsonResponse(200, { tasks: [{ id: 't_1' }] }))
    await client.listInbox()
    await vi.waitFor(async () => expect(await cacheGet('http://x/api/inbox')).not.toBeNull())

    global.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect(await client.listInbox()).toEqual({ tasks: [{ id: 't_1' }] })
    expect(getOfflineState().offline).toBe(true)
  })

  test('a gateway error from a proxy counts as unreachable', async () => {
    const client = createApiClient('http://x', 'tok')
    global.fetch.mockResolvedValueOnce(jsonResponse(200, { rules: [] }))
    await client.listRules()
    await vi.waitFor(async () => expect(await cacheGet('http://x/api/rules')).not.toBeNull())

    global.fetch.mockResolvedValueOnce({ ok: false, status: 502, text: async () => '<html>Bad Gateway</html>' })
    expect(await client.listRules()).toEqual({ rules: [] })
    expect(getOfflineState().offline).toBe(true)
  })

  test('with no local copy the network error still reaches the caller', async () => {
    global.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(createApiClient('http://x', 'tok').listGoals()).rejects.toMatchObject({ code: 'network_error' })
  })

  test('health and events are never stored or replayed', async () => {
    const client = createApiClient('http://x', 'tok')
    global.fetch.mockResolvedValue(jsonResponse(200, { ok: true, headId: 4 }))
    await client.health()
    await client.getEvents()
    expect(await cacheGet('http://x/api/health')).toBeNull()
    expect(await cacheGet('http://x/api/events')).toBeNull()

    global.fetch.mockReset()
    global.fetch.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(client.health()).rejects.toMatchObject({ code: 'network_error' })
    await expect(client.getEvents()).rejects.toMatchObject({ code: 'network_error' })
  })

  test('a text search is not stored', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse(200, { tasks: [] }))
    await createApiClient('http://x', 'tok').listTasks({ text: 'swe', limit: 8 })
    expect(await cacheGet('http://x/api/tasks?text=swe&limit=8')).toBeNull()
  })

  test('a write that cannot be queued is refused, and says it was not saved', async () => {
    global.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(createApiClient('http://x', 'tok').createRule({ name: 'r' })).rejects.toMatchObject({
      code: 'network_error',
      message: expect.stringContaining('not saved'),
    })
  })

  test('an error the server itself sent is not replaced by the copy', async () => {
    const client = createApiClient('http://x', 'tok')
    global.fetch.mockResolvedValueOnce(jsonResponse(200, { tasks: [] }))
    await client.listInbox()
    global.fetch.mockResolvedValueOnce(jsonResponse(401, { error: { code: 'unauthorized', message: 'bad token' } }))
    await expect(client.listInbox()).rejects.toMatchObject({ status: 401 })
    expect(getOfflineState().offline).toBe(false)
  })

  test('any answer from the server ends offline mode', async () => {
    markOffline()
    global.fetch.mockResolvedValueOnce(jsonResponse(200, { ok: true }))
    await createApiClient('http://x', 'tok').health()
    expect(getOfflineState().offline).toBe(false)
  })

  test('clearing the copy removes every stored answer', async () => {
    const client = createApiClient('http://x', 'tok')
    global.fetch.mockResolvedValueOnce(jsonResponse(200, { tasks: [] }))
    await client.listInbox()
    await vi.waitFor(async () => expect(await cacheGet('http://x/api/inbox')).not.toBeNull())
    await cacheClear()
    expect(await cacheGet('http://x/api/inbox')).toBeNull()
  })
})

describe('OfflineBanner', () => {
  const NOON = new Date(2026, 8, 21, 12, 0).getTime()

  test('renders nothing while the server is reachable', () => {
    render(<OfflineBanner now={NOON} />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  test('appears when the server drops, with the time of the last contact', () => {
    markOnline(NOON - 60 * 60 * 1000)
    render(<OfflineBanner now={NOON} />)
    act(() => markOffline())
    const banner = screen.getByRole('status')
    expect(banner.textContent).toContain('Offline.')
    expect(banner.textContent).toContain('Showing data from')
    expect(banner.textContent).not.toContain('more than a day old')
  })

  test('warns once the copy is more than 24 hours old', () => {
    markOnline(NOON - STALE_AFTER_MS - 60000)
    markOffline()
    render(<OfflineBanner now={NOON} />)
    expect(screen.getByRole('status').textContent).toContain('more than a day old')
  })

  test('goes away when the server answers again', () => {
    markOnline(NOON - 1000)
    markOffline()
    render(<OfflineBanner now={NOON} />)
    expect(screen.getByRole('status')).toBeTruthy()
    act(() => markOnline(NOON))
    expect(screen.queryByRole('status')).toBeNull()
  })
})

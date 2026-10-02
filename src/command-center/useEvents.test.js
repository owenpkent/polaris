import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useEventRefresh } from './useEvents'
import { markOffline, markOnline, resetOfflineStatus } from './offlineStatus'

let connected = true
const api = { getEvents: vi.fn() }

vi.mock('./ConnectionContext', () => ({ useConnection: () => ({ connected, api }) }))

// Flushes the microtask queue a timer callback's async body is waiting on, without
// advancing the fake clock (the first tick fires from the effect itself, not a timeout).
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

function setHidden(value) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => value })
}

beforeEach(() => {
  connected = true
  api.getEvents.mockReset()
  vi.useFakeTimers()
  setHidden(false)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  setHidden(false)
  resetOfflineStatus()
})

describe('useEventRefresh', () => {
  test('does not call onChange for the first response, which only sets the baseline', async () => {
    const onChange = vi.fn()
    api.getEvents.mockResolvedValueOnce({ headId: 5 })
    renderHook(() => useEventRefresh(onChange, { intervalMs: 1000 }))
    await flush()
    expect(onChange).not.toHaveBeenCalled()
  })

  test('calls onChange only once the server head id actually moves', async () => {
    const onChange = vi.fn()
    api.getEvents.mockResolvedValueOnce({ headId: 5 })
    renderHook(() => useEventRefresh(onChange, { intervalMs: 1000 }))
    await flush()

    api.getEvents.mockResolvedValueOnce({ headId: 5 })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(onChange).not.toHaveBeenCalled()

    api.getEvents.mockResolvedValueOnce({ headId: 6 })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  test('falls back to lastId when the server sends no headId', async () => {
    const onChange = vi.fn()
    api.getEvents.mockResolvedValueOnce({ lastId: 10 })
    renderHook(() => useEventRefresh(onChange, { intervalMs: 1000 }))
    await flush()
    expect(onChange).not.toHaveBeenCalled()

    api.getEvents.mockResolvedValueOnce({ lastId: 11 })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  test('does not poll at all when enabled is false', async () => {
    const onChange = vi.fn()
    renderHook(() => useEventRefresh(onChange, { enabled: false, intervalMs: 1000 }))
    await flush()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(api.getEvents).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })

  test('does not call the server while the document is hidden, and resumes when it is shown again', async () => {
    setHidden(true)
    const onChange = vi.fn()
    renderHook(() => useEventRefresh(onChange, { intervalMs: 1000 }))
    await flush()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(api.getEvents).not.toHaveBeenCalled()

    api.getEvents.mockResolvedValueOnce({ headId: 1 })
    setHidden(false)
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(api.getEvents).toHaveBeenCalledTimes(1)
  })

  test('stops polling once the component unmounts', async () => {
    const onChange = vi.fn()
    api.getEvents.mockResolvedValueOnce({ headId: 1 })
    const { unmount } = renderHook(() => useEventRefresh(onChange, { intervalMs: 1000 }))
    await flush()
    expect(api.getEvents).toHaveBeenCalledTimes(1)

    unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
    expect(api.getEvents).toHaveBeenCalledTimes(1)
  })

  test('coming back online after being offline while this view stayed open counts as a change', async () => {
    markOffline()
    const onChange = vi.fn()
    api.getEvents.mockResolvedValue({ headId: 1 })
    renderHook(() => useEventRefresh(onChange, { intervalMs: 1000 }))
    await flush()
    expect(onChange).not.toHaveBeenCalled()

    act(() => markOnline())
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  test('does not treat an already-online mount as a change', async () => {
    const onChange = vi.fn()
    api.getEvents.mockResolvedValue({ headId: 1 })
    renderHook(() => useEventRefresh(onChange, { intervalMs: 1000 }))
    await flush()

    act(() => markOnline())
    expect(onChange).not.toHaveBeenCalled()
  })
})

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { BUSY_REFRESH_MS, REFRESH_MS, useUpdateStatus } from './useUpdateStatus'
import { markOffline, markOnline, resetOfflineStatus } from './offlineStatus'

let connected = true
const api = { getUpdate: vi.fn(), requestUpdate: vi.fn(), cancelUpdateRequest: vi.fn() }

vi.mock('./ConnectionContext', () => ({ useConnection: () => ({ connected, api }) }))

const IDLE = { running: '2.0.0', updaterInstalled: true, available: { version: '2.1.0', notes: '', touchesSchema: false }, request: null, lastResult: null, command: 'npm run cc -- update --release' }
const PENDING = { ...IDLE, request: { id: 'up_1', state: 'pending', version: '2.1.0' } }

async function flush() {
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}

beforeEach(() => {
  connected = true
  api.getUpdate.mockReset()
  api.requestUpdate.mockReset()
  api.cancelUpdateRequest.mockReset()
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  resetOfflineStatus()
})

describe('useUpdateStatus', () => {
  test('asks once on mount and again every five minutes while nothing is requested', async () => {
    api.getUpdate.mockResolvedValue(IDLE)
    const { result } = renderHook(() => useUpdateStatus())
    await flush()
    expect(api.getUpdate).toHaveBeenCalledTimes(1)
    expect(result.current.update).toEqual(IDLE)

    await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_MS - 1000) })
    expect(api.getUpdate).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(api.getUpdate).toHaveBeenCalledTimes(2)
  })

  test('asks every thirty seconds while a request is pending or picked up, and slows down again once it is finished', async () => {
    api.getUpdate.mockResolvedValue(PENDING)
    renderHook(() => useUpdateStatus())
    await flush()
    expect(api.getUpdate).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(BUSY_REFRESH_MS) })
    expect(api.getUpdate).toHaveBeenCalledTimes(2)

    api.getUpdate.mockResolvedValue({ ...PENDING, request: { ...PENDING.request, state: 'picked_up' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(BUSY_REFRESH_MS) })
    expect(api.getUpdate).toHaveBeenCalledTimes(3)

    api.getUpdate.mockResolvedValue({ ...PENDING, request: { ...PENDING.request, state: 'done', result: 'Updated to v2.1.0' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(BUSY_REFRESH_MS) })
    expect(api.getUpdate).toHaveBeenCalledTimes(4)
    // Finished: back to the slow poll.
    await act(async () => { await vi.advanceTimersByTimeAsync(BUSY_REFRESH_MS * 2) })
    expect(api.getUpdate).toHaveBeenCalledTimes(4)
    await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_MS) })
    expect(api.getUpdate).toHaveBeenCalledTimes(5)
  })

  test('does not ask, and reports nothing, while disconnected or offline', async () => {
    connected = false
    const { result, unmount } = renderHook(() => useUpdateStatus())
    await flush()
    expect(api.getUpdate).not.toHaveBeenCalled()
    expect(result.current.update).toBeNull()
    unmount()

    connected = true
    markOffline()
    const second = renderHook(() => useUpdateStatus())
    await flush()
    expect(api.getUpdate).not.toHaveBeenCalled()
    expect(second.result.current.update).toBeNull()

    // Back online: it asks at once, so the icon does not wait five minutes.
    api.getUpdate.mockResolvedValue(IDLE)
    await act(async () => { markOnline() })
    await flush()
    expect(api.getUpdate).toHaveBeenCalledTimes(1)
    expect(second.result.current.update).toEqual(IDLE)
  })

  test('a failed poll keeps the last answer and the manual refresh asks again', async () => {
    api.getUpdate.mockResolvedValueOnce(IDLE).mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(PENDING)
    const { result } = renderHook(() => useUpdateStatus())
    await flush()
    expect(result.current.update).toEqual(IDLE)
    await act(async () => { await result.current.refresh() })
    expect(result.current.update).toEqual(IDLE)
    expect(result.current.error).toBeInstanceOf(Error)
    await act(async () => { await result.current.refresh() })
    expect(result.current.update).toEqual(PENDING)
    expect(result.current.error).toBeNull()
  })

  test('request and cancel go to the server live and fold the returned row into the state', async () => {
    api.getUpdate.mockResolvedValue(IDLE)
    api.requestUpdate.mockResolvedValue({ request: PENDING.request })
    api.cancelUpdateRequest.mockResolvedValue({ request: { ...PENDING.request, state: 'cancelled' } })
    const { result } = renderHook(() => useUpdateStatus())
    await flush()

    await act(async () => { await result.current.request('2.1.0') })
    expect(api.requestUpdate).toHaveBeenCalledWith('2.1.0')
    expect(result.current.update.request.state).toBe('pending')

    await act(async () => { await result.current.cancel('up_1') })
    expect(api.cancelUpdateRequest).toHaveBeenCalledWith('up_1')
    expect(result.current.update.request.state).toBe('cancelled')
  })
})

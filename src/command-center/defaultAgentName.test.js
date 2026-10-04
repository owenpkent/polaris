import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import {
  useDefaultAgentName, rememberDefaultAgentName, resetDefaultAgentNameCache,
} from './defaultAgentName'

const api = { getAgentSettings: vi.fn() }

beforeEach(() => {
  api.getAgentSettings.mockReset()
  resetDefaultAgentNameCache()
})

afterEach(() => {
  cleanup()
  resetDefaultAgentNameCache()
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('useDefaultAgentName', () => {
  test('two hooks mounted at once make one request and both get the name', async () => {
    const pending = deferred()
    api.getAgentSettings.mockReturnValue(pending.promise)
    const a = renderHook(() => useDefaultAgentName(api))
    const b = renderHook(() => useDefaultAgentName(api))
    expect(a.result.current).toBeNull()
    expect(b.result.current).toBeNull()

    await act(async () => { pending.resolve({ defaultAgentName: 'scribe' }) })

    expect(api.getAgentSettings).toHaveBeenCalledTimes(1)
    expect(a.result.current).toBe('scribe')
    expect(b.result.current).toBe('scribe')
  })

  test('a hook mounted later starts from the cached name and refreshes it', async () => {
    api.getAgentSettings.mockResolvedValue({ defaultAgentName: 'scribe' })
    const first = renderHook(() => useDefaultAgentName(api))
    await act(async () => {})
    expect(first.result.current).toBe('scribe')

    api.getAgentSettings.mockResolvedValue({ defaultAgentName: 'reviewer' })
    const second = renderHook(() => useDefaultAgentName(api))
    expect(second.result.current).toBe('scribe')
    await act(async () => {})

    expect(api.getAgentSettings).toHaveBeenCalledTimes(2)
    expect(second.result.current).toBe('reviewer')
    expect(first.result.current).toBe('reviewer')
  })

  test('rememberDefaultAgentName updates a mounted hook', async () => {
    api.getAgentSettings.mockResolvedValue({ defaultAgentName: 'scribe' })
    const { result } = renderHook(() => useDefaultAgentName(api))
    await act(async () => {})
    expect(result.current).toBe('scribe')

    act(() => { rememberDefaultAgentName('reviewer') })

    expect(result.current).toBe('reviewer')
  })

  test('a read that started before a save does not undo it', async () => {
    const pending = deferred()
    api.getAgentSettings.mockReturnValue(pending.promise)
    const { result } = renderHook(() => useDefaultAgentName(api))

    act(() => { rememberDefaultAgentName('reviewer') })
    await act(async () => { pending.resolve({ defaultAgentName: 'scribe' }) })

    expect(result.current).toBe('reviewer')
  })

  test('a rejected fetch keeps the old value', async () => {
    api.getAgentSettings.mockResolvedValue({ defaultAgentName: 'scribe' })
    const first = renderHook(() => useDefaultAgentName(api))
    await act(async () => {})
    expect(first.result.current).toBe('scribe')

    api.getAgentSettings.mockRejectedValue(new Error('offline'))
    const second = renderHook(() => useDefaultAgentName(api))
    await act(async () => {})

    expect(api.getAgentSettings).toHaveBeenCalledTimes(2)
    expect(second.result.current).toBe('scribe')
    expect(first.result.current).toBe('scribe')
  })
})

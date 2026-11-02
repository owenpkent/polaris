import { describe, test, expect, afterEach, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { SIDEBAR_STORAGE_KEY, readStoredSidebarHidden, useSidebarHidden } from './sidebarState'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('readStoredSidebarHidden', () => {
  test('the sidebar is shown when nothing is stored', () => {
    expect(readStoredSidebarHidden()).toBe(false)
  })
  test('reads a stored choice, and treats anything else as shown', () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, 'hidden')
    expect(readStoredSidebarHidden()).toBe(true)
    localStorage.setItem(SIDEBAR_STORAGE_KEY, 'sideways')
    expect(readStoredSidebarHidden()).toBe(false)
  })
  test('is shown when storage cannot be read', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('disabled') })
    expect(readStoredSidebarHidden()).toBe(false)
    spy.mockRestore()
  })
})

describe('useSidebarHidden', () => {
  test('starts shown, and a choice is stored', () => {
    const { result } = renderHook(() => useSidebarHidden())
    expect(result.current.hidden).toBe(false)
    act(() => result.current.setHidden(true))
    expect(result.current.hidden).toBe(true)
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('hidden')
    act(() => result.current.setHidden(false))
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('shown')
  })
  test('a stored choice is where a new page starts', () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, 'hidden')
    const { result } = renderHook(() => useSidebarHidden())
    expect(result.current.hidden).toBe(true)
  })
  test("another tab's change is followed", () => {
    const { result } = renderHook(() => useSidebarHidden())
    localStorage.setItem(SIDEBAR_STORAGE_KEY, 'hidden')
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: SIDEBAR_STORAGE_KEY })) })
    expect(result.current.hidden).toBe(true)
  })
})

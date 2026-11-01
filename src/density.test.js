import { describe, test, expect, afterEach } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { DENSITY_STORAGE_KEY, applyDensity, readStoredDensity, useDensity } from './density'

afterEach(() => {
  cleanup()
  localStorage.clear()
  delete document.documentElement.dataset.density
})

describe('readStoredDensity', () => {
  test('is comfortable when nothing is stored', () => {
    expect(readStoredDensity()).toBe('comfortable')
  })

  test('reads a stored choice', () => {
    localStorage.setItem(DENSITY_STORAGE_KEY, 'compact')
    expect(readStoredDensity()).toBe('compact')
  })

  test('treats an unknown value as no choice', () => {
    localStorage.setItem(DENSITY_STORAGE_KEY, 'tiny')
    expect(readStoredDensity()).toBe('comfortable')
  })
})

describe('applyDensity', () => {
  test('writes the choice to data-density on <html>', () => {
    applyDensity('compact')
    expect(document.documentElement.dataset.density).toBe('compact')
  })
})

describe('useDensity', () => {
  test('starts comfortable and paints it', () => {
    const { result } = renderHook(() => useDensity())
    expect(result.current.density).toBe('comfortable')
    expect(document.documentElement.dataset.density).toBe('comfortable')
  })

  test('a choice is stored and painted', () => {
    const { result } = renderHook(() => useDensity())
    act(() => result.current.setDensity('compact'))
    expect(result.current.density).toBe('compact')
    expect(localStorage.getItem(DENSITY_STORAGE_KEY)).toBe('compact')
    expect(document.documentElement.dataset.density).toBe('compact')
  })

  test('an unknown choice falls back to comfortable', () => {
    const { result } = renderHook(() => useDensity())
    act(() => result.current.setDensity('tiny'))
    expect(result.current.density).toBe('comfortable')
  })

  test("follows another tab's change", () => {
    const { result } = renderHook(() => useDensity())
    localStorage.setItem(DENSITY_STORAGE_KEY, 'compact')
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: DENSITY_STORAGE_KEY }))
    })
    expect(result.current.density).toBe('compact')
  })
})

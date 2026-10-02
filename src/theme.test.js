import { describe, test, expect, afterEach, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import {
  THEME_STORAGE_KEY,
  applyTheme,
  readStoredTheme,
  resolveTheme,
  useTheme,
} from './theme'

const realMatchMedia = window.matchMedia

// A controllable (prefers-color-scheme: dark) stand-in: jsdom's own always
// answers false and never changes.
function stubSystemDark(initial) {
  const listeners = new Set()
  const query = {
    matches: initial,
    addEventListener: (_type, fn) => listeners.add(fn),
    removeEventListener: (_type, fn) => listeners.delete(fn),
  }
  window.matchMedia = () => query
  return {
    change(matches) {
      query.matches = matches
      act(() => {
        listeners.forEach((fn) => fn({ matches }))
      })
    },
    get listenerCount() {
      return listeners.size
    },
  }
}

afterEach(() => {
  cleanup()
  window.matchMedia = realMatchMedia
  localStorage.clear()
  delete document.documentElement.dataset.theme
})

describe('resolveTheme', () => {
  test('an explicit choice wins over the system setting', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  test('system follows the system setting', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })
})

describe('readStoredTheme', () => {
  test('is system when nothing is stored', () => {
    expect(readStoredTheme()).toBe('system')
  })

  test('returns a stored choice', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light')
    expect(readStoredTheme()).toBe('light')
  })

  test('falls back to system for an unrecognized value', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia')
    expect(readStoredTheme()).toBe('system')
  })

  test('falls back to system when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    expect(readStoredTheme()).toBe('system')
  })
})

describe('applyTheme', () => {
  test('writes data-theme onto the document element', () => {
    applyTheme('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    applyTheme('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})

describe('useTheme', () => {
  test('defaults to system and applies what the system asks for', () => {
    stubSystemDark(false)
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe('system')
    expect(result.current.resolvedTheme).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  test('setTheme applies and persists the choice', () => {
    stubSystemDark(false)
    const { result } = renderHook(() => useTheme())
    act(() => {
      result.current.setTheme('dark')
    })
    expect(result.current.theme).toBe('dark')
    expect(result.current.resolvedTheme).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
  })

  test('ignores an unrecognized choice and stores system instead', () => {
    stubSystemDark(true)
    const { result } = renderHook(() => useTheme())
    act(() => {
      result.current.setTheme('sepia')
    })
    expect(result.current.theme).toBe('system')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')
  })

  test('a system choice follows the OS while the tab is open', () => {
    const system = stubSystemDark(false)
    const { result } = renderHook(() => useTheme())
    expect(result.current.resolvedTheme).toBe('light')
    system.change(true)
    expect(result.current.resolvedTheme).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  test('an explicit choice does not follow the OS', () => {
    const system = stubSystemDark(false)
    const { result } = renderHook(() => useTheme())
    act(() => {
      result.current.setTheme('light')
    })
    system.change(true)
    expect(result.current.resolvedTheme).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  test('stops listening to the OS when unmounted', () => {
    const system = stubSystemDark(false)
    const { unmount } = renderHook(() => useTheme())
    expect(system.listenerCount).toBe(1)
    unmount()
    expect(system.listenerCount).toBe(0)
  })

  test('another tab picking a theme is followed here', () => {
    stubSystemDark(true)
    const { result } = renderHook(() => useTheme())
    expect(result.current.resolvedTheme).toBe('dark')

    // What the browser does when the other tab writes the key.
    localStorage.setItem(THEME_STORAGE_KEY, 'light')
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'light' }))
    })
    expect(result.current.theme).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  test('an unrelated storage key is ignored', () => {
    stubSystemDark(true)
    const { result } = renderHook(() => useTheme())
    localStorage.setItem('something-else', 'light')
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'something-else', newValue: 'light' }))
    })
    expect(result.current.theme).toBe('system')
    expect(result.current.resolvedTheme).toBe('dark')
  })

  test('stops listening for other tabs when unmounted', () => {
    stubSystemDark(false)
    const { unmount } = renderHook(() => useTheme())
    unmount()
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'dark' }))
    })
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  test('still resolves when storage and matchMedia are unavailable', () => {
    window.matchMedia = () => {
      throw new Error('no matchMedia')
    }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe('system')
    expect(result.current.resolvedTheme).toBe('dark')
  })
})

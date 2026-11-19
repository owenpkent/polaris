import { describe, test, expect, afterEach, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import {
  THEME_STORAGE_KEY,
  applyTheme,
  barColour,
  readStoredTheme,
  resolveTheme,
  systemBarStyle,
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

describe('systemBarStyle', () => {
  test('under the bars the dashboard is behind them, so the theme decides', () => {
    expect(systemBarStyle('dark', false, true)).toBe('DARK')
    expect(systemBarStyle('dark', true, true)).toBe('DARK')
    expect(systemBarStyle('light', false, true)).toBe('LIGHT')
    expect(systemBarStyle('light', true, true)).toBe('LIGHT')
  })

  test('in a padded window the window is behind them, so the phone decides', () => {
    expect(systemBarStyle('dark', false, false)).toBe('LIGHT')
    expect(systemBarStyle('light', true, false)).toBe('DARK')
    expect(systemBarStyle('dark', true, false)).toBe('DARK')
    expect(systemBarStyle('light', false, false)).toBe('LIGHT')
  })
})

const OLD_WEBVIEW = 'Mozilla/5.0 (Linux; Android 16; sdk_gphone64_x86_64 Build/BP22; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/133.0.6943.137 Mobile Safari/537.36'
const CURRENT_WEBVIEW = OLD_WEBVIEW.replace('Chrome/133.0.6943.137', 'Chrome/142.0.7444.102')
const realUserAgent = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent')

function stubUserAgent(value) {
  Object.defineProperty(window.navigator, 'userAgent', { configurable: true, get: () => value })
}

// The token the bars are painted with. No stylesheet is loaded here, so a test sets it by hand.
function stubBarColour(value) {
  document.documentElement.style.setProperty('--bg2', value)
}

// Lets the chain of bridge calls in applySystemBars run to its end.
async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

describe('barColour', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('style')
  })

  test('reads the token of the bars as six hex digits, in lower case', () => {
    stubBarColour('#252931')
    expect(barColour()).toBe('#252931')
    stubBarColour(' #FCFCFD ')
    expect(barColour()).toBe('#fcfcfd')
  })

  test('is null for anything the app would refuse, and with no token at all', () => {
    expect(barColour()).toBeNull()
    for (const value of ['#fff', 'red', 'rgb(37, 41, 49)', '#25293180', 'color-mix(in srgb, #252931 50%, white)']) {
      stubBarColour(value)
      expect(barColour()).toBeNull()
    }
  })
})

describe('applyTheme inside the Android app', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('style')
    delete window.Capacitor
    if (realUserAgent) Object.defineProperty(window.navigator, 'userAgent', realUserAgent)
    else delete window.navigator.userAgent
  })

  test('tells the status bar which theme it sits over, and nothing in a browser', () => {
    applyTheme('dark')
    expect(window.Capacitor).toBeUndefined()
    const nativePromise = vi.fn().mockResolvedValue({})
    window.Capacitor = { isNativePlatform: () => true, nativePromise }
    applyTheme('dark')
    expect(nativePromise).toHaveBeenLastCalledWith('SystemBars', 'setStyle', { style: 'DARK' })
    applyTheme('light')
    expect(nativePromise).toHaveBeenLastCalledWith('SystemBars', 'setStyle', { style: 'LIGHT' })
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  test('on an old WebView the window takes the colour of the bars and the icons follow the theme', async () => {
    const nativePromise = vi.fn().mockResolvedValue({})
    window.Capacitor = { isNativePlatform: () => true, nativePromise }
    stubUserAgent(OLD_WEBVIEW)
    stubBarColour('#252931')
    applyTheme('dark', false)
    await flush()
    // The style first: setting it puts the window's own background back.
    expect(nativePromise.mock.calls).toEqual([
      ['SystemBars', 'setStyle', { style: 'DARK' }],
      ['AppWindow', 'setBackground', { color: '#252931' }],
    ])

    nativePromise.mockClear()
    stubBarColour('#FCFCFD')
    applyTheme('light', true)
    await flush()
    expect(nativePromise.mock.calls).toEqual([
      ['SystemBars', 'setStyle', { style: 'LIGHT' }],
      ['AppWindow', 'setBackground', { color: '#fcfcfd' }],
    ])
  })

  test('an app that refuses the colour: the icons go back to following the phone', async () => {
    const nativePromise = vi.fn((plugin) => (plugin === 'AppWindow' ? Promise.reject(new Error('no plugin')) : Promise.resolve({})))
    window.Capacitor = { isNativePlatform: () => true, nativePromise }
    stubUserAgent(OLD_WEBVIEW)
    stubBarColour('#252931')
    applyTheme('dark', false)
    await flush()
    expect(nativePromise.mock.calls).toEqual([
      ['SystemBars', 'setStyle', { style: 'DARK' }],
      ['AppWindow', 'setBackground', { color: '#252931' }],
      ['SystemBars', 'setStyle', { style: 'LIGHT' }],
    ])
  })

  test('an app that refuses the style too: the fallback is tried and nothing is thrown', async () => {
    const nativePromise = vi.fn().mockRejectedValue(new Error('no plugin'))
    window.Capacitor = { isNativePlatform: () => true, nativePromise }
    stubUserAgent(OLD_WEBVIEW)
    stubBarColour('#252931')
    expect(() => applyTheme('dark', false)).not.toThrow()
    await flush()
    expect(nativePromise.mock.calls).toEqual([
      ['SystemBars', 'setStyle', { style: 'DARK' }],
      ['SystemBars', 'setStyle', { style: 'LIGHT' }],
    ])
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  test('a theme switched again before the app answered: only the last one colours the window', async () => {
    const nativePromise = vi.fn().mockResolvedValue({})
    window.Capacitor = { isNativePlatform: () => true, nativePromise }
    stubUserAgent(OLD_WEBVIEW)
    stubBarColour('#252931')
    applyTheme('dark', false)
    stubBarColour('#fcfcfd')
    applyTheme('light', false)
    await flush()
    expect(nativePromise.mock.calls).toEqual([
      ['SystemBars', 'setStyle', { style: 'DARK' }],
      ['SystemBars', 'setStyle', { style: 'LIGHT' }],
      ['AppWindow', 'setBackground', { color: '#fcfcfd' }],
    ])
  })

  test('on a current WebView the window is never coloured', async () => {
    const nativePromise = vi.fn().mockResolvedValue({})
    window.Capacitor = { isNativePlatform: () => true, nativePromise }
    stubUserAgent(CURRENT_WEBVIEW)
    stubBarColour('#252931')
    applyTheme('dark', false)
    await flush()
    expect(nativePromise.mock.calls).toEqual([['SystemBars', 'setStyle', { style: 'DARK' }]])
  })

  test('an explicit theme on an old WebView: the window is coloured again when the phone changes its setting', async () => {
    const nativePromise = vi.fn().mockResolvedValue({})
    window.Capacitor = { isNativePlatform: () => true, nativePromise }
    stubUserAgent(OLD_WEBVIEW)
    stubBarColour('#252931')
    const system = stubSystemDark(false)
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    renderHook(() => useTheme())
    await flush()
    nativePromise.mockClear()
    // The app has put its window's own background back by now; the page has to answer.
    system.change(true)
    await flush()
    expect(nativePromise.mock.calls).toEqual([
      ['SystemBars', 'setStyle', { style: 'DARK' }],
      ['AppWindow', 'setBackground', { color: '#252931' }],
    ])
  })

  test('on an old WebView with no colour to give, the icons follow the phone, not the theme', () => {
    const nativePromise = vi.fn().mockResolvedValue({})
    window.Capacitor = { isNativePlatform: () => true, nativePromise }
    stubUserAgent(OLD_WEBVIEW)
    // The strip behind the bars is the window's background there, light on a phone set to light.
    applyTheme('dark', false)
    expect(nativePromise).toHaveBeenLastCalledWith('SystemBars', 'setStyle', { style: 'LIGHT' })
    applyTheme('light', true)
    expect(nativePromise).toHaveBeenLastCalledWith('SystemBars', 'setStyle', { style: 'DARK' })
    applyTheme('dark', true)
    expect(nativePromise).toHaveBeenLastCalledWith('SystemBars', 'setStyle', { style: 'DARK' })
    // The page itself still gets the theme that was picked.
    applyTheme('dark', false)
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  test('on a current WebView the icons follow the theme whatever the phone is set to', () => {
    const nativePromise = vi.fn().mockResolvedValue({})
    window.Capacitor = { isNativePlatform: () => true, nativePromise }
    stubUserAgent(CURRENT_WEBVIEW)
    applyTheme('dark', false)
    expect(nativePromise).toHaveBeenLastCalledWith('SystemBars', 'setStyle', { style: 'DARK' })
    applyTheme('light', true)
    expect(nativePromise).toHaveBeenLastCalledWith('SystemBars', 'setStyle', { style: 'LIGHT' })
  })

  test('with no setting given and no colour to give, the phone is asked', () => {
    const nativePromise = vi.fn().mockResolvedValue({})
    window.Capacitor = { isNativePlatform: () => true, nativePromise }
    stubUserAgent(OLD_WEBVIEW)
    stubSystemDark(true)
    applyTheme('light')
    expect(nativePromise).toHaveBeenLastCalledWith('SystemBars', 'setStyle', { style: 'DARK' })
  })

  test('an explicit theme on an old WebView with no colour to give: the bars change when the phone changes, the page does not', () => {
    const nativePromise = vi.fn().mockResolvedValue({})
    window.Capacitor = { isNativePlatform: () => true, nativePromise }
    stubUserAgent(OLD_WEBVIEW)
    const system = stubSystemDark(false)
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    const { result } = renderHook(() => useTheme())
    expect(nativePromise).toHaveBeenLastCalledWith('SystemBars', 'setStyle', { style: 'LIGHT' })
    system.change(true)
    expect(nativePromise).toHaveBeenLastCalledWith('SystemBars', 'setStyle', { style: 'DARK' })
    expect(result.current.resolvedTheme).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  test('a bridge that refuses does not break the theme switch', async () => {
    window.Capacitor = { isNativePlatform: () => true, nativePromise: vi.fn().mockRejectedValue(new Error('no plugin')) }
    expect(() => applyTheme('dark')).not.toThrow()
    await Promise.resolve()
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})

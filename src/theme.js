import { useCallback, useEffect, useState } from 'react'
import { drawsUnderSystemBars, isNativeApp, nativeCall } from './command-center/nativeApp'

// Light/dark theme. The choice is one of THEME_CHOICES and lives in
// localStorage; what it resolves to ('light' or 'dark') is written to
// data-theme on <html>, which is the only thing src/index.css looks at.
//
// index.html carries a copy of this resolution in a pre-paint script, so a
// reload never flashes the wrong theme. Keep the two in step: the storage key
// and the fallback are named there too.
export const THEME_STORAGE_KEY = 'cc-theme-v1'
export const THEME_CHOICES = ['system', 'light', 'dark']

const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)'

// Anything unrecognized (or unreadable, in private browsing) means no choice
// has been made, which is 'system'.
export function readStoredTheme() {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY)
    return THEME_CHOICES.includes(raw) ? raw : 'system'
  } catch {
    return 'system'
  }
}

function persistTheme(choice) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, choice)
  } catch {
    // Ignore storage errors (private browsing, quota, disabled storage, etc).
  }
}

// Dark is the fallback when the browser cannot answer, matching :root.
export function systemPrefersDark() {
  try {
    return window.matchMedia(SYSTEM_DARK_QUERY).matches
  } catch {
    return true
  }
}

export function resolveTheme(choice, prefersDark) {
  if (choice === 'light' || choice === 'dark') return choice
  return prefersDark ? 'dark' : 'light'
}

// Which icons the Android app's status bar and gesture bar get: 'DARK' is light icons, for a dark
// surface behind them, and 'LIGHT' is dark icons (Capacitor's SystemBars plugin names the styles
// after the theme they suit). Where the page is drawn under the bars, what is behind them is the
// dashboard, so the icons follow the dashboard's theme, not the phone's. On a WebView too old
// for that, what is behind them is the app window's own background, which follows the phone's
// setting whatever theme was picked here, so there the icons follow the phone. Otherwise the dark
// theme on a phone set to light put white icons on a white strip, and the light theme on a phone
// set to dark put dark icons on a dark one.
export function systemBarStyle(resolved, prefersDark, underBars = drawsUnderSystemBars()) {
  const dark = underBars ? resolved === 'dark' : Boolean(prefersDark)
  return dark ? 'DARK' : 'LIGHT'
}

export function applyTheme(resolved, prefersDark = systemPrefersDark()) {
  try {
    document.documentElement.dataset.theme = resolved
  } catch {
    // No document (server render, bare test harness): nothing to paint.
  }
  if (isNativeApp()) nativeCall('SystemBars', 'setStyle', { style: systemBarStyle(resolved, prefersDark) }).catch(() => {})
}

// Watches the OS setting so a 'system' choice follows it while the tab is
// open. Returns the stored choice, what it currently resolves to, and a
// setter; App passes all three to TopBar.
export function useTheme() {
  const [theme, setThemeState] = useState(readStoredTheme)
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark)

  useEffect(() => {
    let query
    try {
      query = window.matchMedia(SYSTEM_DARK_QUERY)
    } catch {
      return undefined
    }
    const onChange = (e) => setPrefersDark(e.matches)
    // addListener is the pre-2021 Safari spelling of addEventListener here.
    if (query.addEventListener) {
      query.addEventListener('change', onChange)
      return () => query.removeEventListener('change', onChange)
    }
    if (query.addListener) {
      query.addListener(onChange)
      return () => query.removeListener(onChange)
    }
    return undefined
  }, [])

  // A second tab is a normal way to use this: the daemon serves the dashboard
  // on loopback and over the tailnet. Without this, the other tab keeps the old
  // theme until it reloads, and its next change overwrites this one.
  useEffect(() => {
    const onStorage = (e) => {
      // A null key means storage was cleared wholesale.
      if (e.key !== null && e.key !== THEME_STORAGE_KEY) return
      setThemeState(readStoredTheme())
    }
    try {
      window.addEventListener('storage', onStorage)
    } catch {
      return undefined
    }
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const resolvedTheme = resolveTheme(theme, prefersDark)

  // The phone's own setting is a dependency too: on an old WebView the app's bars follow it even
  // under an explicit choice (systemBarStyle).
  useEffect(() => {
    applyTheme(resolvedTheme, prefersDark)
  }, [resolvedTheme, prefersDark])

  const setTheme = useCallback((choice) => {
    const next = THEME_CHOICES.includes(choice) ? choice : 'system'
    persistTheme(next)
    setThemeState(next)
  }, [])

  return { theme, resolvedTheme, setTheme }
}

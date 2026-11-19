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
// setting whatever theme was picked here, so there the icons follow the phone, unless the window
// has been given the dashboard's colour (applySystemBars). Otherwise the dark theme on a phone
// set to light put white icons on a white strip, and the light theme on a phone set to dark put
// dark icons on a dark one.
export function systemBarStyle(resolved, prefersDark, underBars = drawsUnderSystemBars()) {
  const dark = underBars ? resolved === 'dark' : Boolean(prefersDark)
  return dark ? 'DARK' : 'LIGHT'
}

// The colour of the dashboard's top bar and tab bar in the theme now on <html>, as '#rrggbb', or
// null when it cannot be read as one. Both bars are var(--bg2) (TopBar.jsx, .bottom-nav).
export function barColour() {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--bg2').trim()
    return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null
  } catch {
    return null
  }
}

// Only the last request for the bars goes on after a wait: the theme may be switched again while
// an earlier request is still talking to the app.
let barsRequest = 0

// Sets the Android app's bars for the theme. Where the page is drawn under them, that is the icons
// alone. On an older WebView the strips behind the bars are the app window's, so the window is
// given the bars' colour (the app's AppWindow plugin) and the icons follow the theme there too:
// the strips then look as they do on a current WebView. The style is set first, because setting
// it puts the window's own background back. If the colour cannot be read or the app refuses it,
// the icons follow the phone's setting instead, so they can always be read.
export async function applySystemBars(resolved, prefersDark) {
  const request = ++barsRequest
  const themed = systemBarStyle(resolved, prefersDark, true)
  if (drawsUnderSystemBars()) {
    await nativeCall('SystemBars', 'setStyle', { style: themed })
    return
  }
  const fallback = systemBarStyle(resolved, prefersDark, false)
  const color = barColour()
  if (!color) {
    await nativeCall('SystemBars', 'setStyle', { style: fallback })
    return
  }
  try {
    await nativeCall('SystemBars', 'setStyle', { style: themed })
    if (request !== barsRequest) return
    await nativeCall('AppWindow', 'setBackground', { color })
  } catch {
    if (request !== barsRequest) return
    await nativeCall('SystemBars', 'setStyle', { style: fallback })
  }
}

export function applyTheme(resolved, prefersDark = systemPrefersDark()) {
  try {
    document.documentElement.dataset.theme = resolved
  } catch {
    // No document (server render, bare test harness): nothing to paint.
  }
  if (isNativeApp()) applySystemBars(resolved, prefersDark).catch(() => {})
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

  // The phone's own setting is a dependency too, also under an explicit choice: on an old WebView
  // the app puts its window's own background back when that setting changes, so the bars are set
  // again (applySystemBars).
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

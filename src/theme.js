import { useCallback, useEffect, useState } from 'react'

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

export function applyTheme(resolved) {
  try {
    document.documentElement.dataset.theme = resolved
  } catch {
    // No document (server render, bare test harness): nothing to paint.
  }
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

  useEffect(() => {
    applyTheme(resolvedTheme)
  }, [resolvedTheme])

  const setTheme = useCallback((choice) => {
    const next = THEME_CHOICES.includes(choice) ? choice : 'system'
    persistTheme(next)
    setThemeState(next)
  }, [])

  return { theme, resolvedTheme, setTheme }
}

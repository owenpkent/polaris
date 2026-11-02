import { useCallback, useEffect, useState } from 'react'

// Whether the desktop sidebar (src/Sidebar.jsx) is hidden, the owner's choice per device, kept in
// localStorage as density.js and theme.js keep theirs. Shown is the default, and anything
// unrecognized (or unreadable, in private browsing) means no choice has been made. Hidden means
// gone, not a rail: the content takes the whole width. Under 640px the sidebar is not shown at
// all (the tab bar and drawer take over), so this choice changes nothing there.
export const SIDEBAR_STORAGE_KEY = 'cc-sidebar-v1'

export function readStoredSidebarHidden() {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'hidden'
  } catch {
    return false
  }
}

function persistSidebarHidden(hidden) {
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, hidden ? 'hidden' : 'shown')
  } catch {
    // Ignore storage errors (private browsing, quota, disabled storage, etc).
  }
}

// The stored choice and a setter. Another tab's change is followed, as useDensity does.
export function useSidebarHidden() {
  const [hidden, setHiddenState] = useState(readStoredSidebarHidden)

  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== null && e.key !== SIDEBAR_STORAGE_KEY) return
      setHiddenState(readStoredSidebarHidden())
    }
    try {
      window.addEventListener('storage', onStorage)
    } catch {
      return undefined
    }
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const setHidden = useCallback((next) => {
    setHiddenState((prev) => {
      const value = typeof next === 'function' ? next(prev) : next
      persistSidebarHidden(value)
      return value
    })
  }, [])

  return { hidden, setHidden }
}

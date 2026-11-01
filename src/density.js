import { useCallback, useEffect, useState } from 'react'

// How tightly task rows and board cards are packed, the owner's choice per device (Settings,
// Appearance). Comfortable, the default, keeps every list control a 44px target. Compact packs
// rows to 32px so more tasks fit on screen, as a desktop tracker does; its targets stay at
// least 32px tall, past the 24px of WCAG 2.2's minimum. The choice lives in localStorage and
// is written to data-density on <html>, which src/index.css reads to set --row and --row-head.
//
// index.html carries a copy of this in its pre-paint script, so a reload never jumps from one
// row height to the other. Keep the two in step: the storage key is named there too.
export const DENSITY_STORAGE_KEY = 'cc-density-v1'
export const DENSITY_CHOICES = ['comfortable', 'compact']

// Anything unrecognized (or unreadable, in private browsing) means no choice has been made.
export function readStoredDensity() {
  try {
    const raw = localStorage.getItem(DENSITY_STORAGE_KEY)
    return DENSITY_CHOICES.includes(raw) ? raw : 'comfortable'
  } catch {
    return 'comfortable'
  }
}

function persistDensity(choice) {
  try {
    localStorage.setItem(DENSITY_STORAGE_KEY, choice)
  } catch {
    // Ignore storage errors (private browsing, quota, disabled storage, etc).
  }
}

export function applyDensity(choice) {
  try {
    document.documentElement.dataset.density = choice
  } catch {
    // No document (server render, bare test harness): nothing to paint.
  }
}

// The stored choice and a setter; App passes both to Settings. Another tab's change is
// followed, as useTheme does, so two open tabs never disagree.
export function useDensity() {
  const [density, setDensityState] = useState(readStoredDensity)

  useEffect(() => {
    const onStorage = (e) => {
      // A null key means storage was cleared wholesale.
      if (e.key !== null && e.key !== DENSITY_STORAGE_KEY) return
      setDensityState(readStoredDensity())
    }
    try {
      window.addEventListener('storage', onStorage)
    } catch {
      return undefined
    }
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  useEffect(() => {
    applyDensity(density)
  }, [density])

  const setDensity = useCallback((choice) => {
    const next = DENSITY_CHOICES.includes(choice) ? choice : 'comfortable'
    persistDensity(next)
    setDensityState(next)
  }, [])

  return { density, setDensity }
}

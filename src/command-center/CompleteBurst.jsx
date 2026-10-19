import { useCallback, useEffect, useRef, useState } from 'react'

// How long a completed row stays on screen so its check can pop and the row can fade (the
// .is-completing animation in index.css) before the refetch drops it from the list.
export const COMPLETE_EXIT_MS = 700

// The wait before a completed row leaves the list: none when the owner asked for reduced motion,
// and none without matchMedia (jsdom), where no animation runs to wait for.
export function completeExitDelay() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 0
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : COMPLETE_EXIT_MS
}

// The little celebration on a check when a task is completed: `celebrate()` starts it and it
// ends itself once the burst has finished. With `hold` it lasts until the component unmounts,
// for a row the refetch is about to drop. `key` changes on every start, so completing again
// replays the animation instead of leaving the old one in place.
export function useCelebration({ hold = false } = {}) {
  const [key, setKey] = useState(0)
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  const celebrate = useCallback(() => {
    clearTimeout(timer.current)
    setKey((k) => k + 1)
    if (!hold) timer.current = setTimeout(() => setKey(0), COMPLETE_EXIT_MS)
  }, [hold])
  return { celebrating: key > 0, key, celebrate }
}

// A ring of coloured dots that bursts out of the check. Its parent must be position: relative;
// the dots, their angles, and their colours are in index.css (.complete-burst), and they stay
// inside a 44px target so nothing is clipped.
export default function CompleteBurst() {
  return (
    <span aria-hidden="true" className="complete-burst">
      <i /><i /><i /><i /><i /><i /><i /><i />
    </span>
  )
}

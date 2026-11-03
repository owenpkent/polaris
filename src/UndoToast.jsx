import { useEffect, useRef, useState } from 'react'
import { dismissToast, useUndoToast } from './command-center/undoToast'

export const TOAST_MS = 6000

// "Completed <task>" with an Undo button, near the bottom of the screen (undoToast.js). The live
// region is always mounted so a screen reader announces each new toast; focus is never moved
// here. The timer restarts for each toast and waits while the pointer is over it or focus is in it.
// The title is third-party text at times: it is rendered as text only.
export default function UndoToast() {
  const toast = useUndoToast()
  const [held, setHeld] = useState(false)
  const ref = useRef(null)
  const id = toast?.id

  useEffect(() => {
    setHeld(false)
  }, [id])

  useEffect(() => {
    if (id === undefined || held) return undefined
    const timer = setTimeout(() => dismissToast(id), TOAST_MS)
    return () => clearTimeout(timer)
  }, [id, held])

  const onBlur = (e) => {
    if (ref.current?.contains(e.relatedTarget)) return
    setHeld(false)
  }

  const undo = () => {
    const fn = toast.undo
    dismissToast(toast.id)
    fn?.()
  }

  return (
    <div className="undo-toast-region" role="status" aria-live="polite" aria-atomic="true">
      {toast && (
        <div
          key={toast.id}
          ref={ref}
          className="undo-toast"
          onMouseEnter={() => setHeld(true)}
          onMouseLeave={() => { if (!ref.current?.contains(document.activeElement)) setHeld(false) }}
          onFocus={() => setHeld(true)}
          onBlur={onBlur}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              dismissToast(toast.id)
            }
          }}
        >
          <span className="undo-toast-text">
            Completed <span className="undo-toast-title">{toast.title}</span>
          </span>
          <button type="button" className="btn undo-toast-btn" aria-label={`Undo completing ${toast.title}`} onClick={undo}>
            Undo
          </button>
        </div>
      )}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { dismissToast, runUndo, useUndoToast } from './command-center/undoToast'

export const TOAST_MS = 6000

// "Completed <task>" with an Undo button, near the bottom of the screen (undoToast.js). The live
// region is always mounted so a screen reader announces each new toast; focus is never moved
// here. The timer restarts for each toast and waits while the pointer is over it or focus is in it.
// A failed Undo has no timer: it says so, with Retry and Dismiss, until the owner chooses. This is
// mounted by App, so it still shows after the tab the task was completed on has gone.
// The title is third-party text at times: it is rendered as text only.
export default function UndoToast() {
  const toast = useUndoToast()
  const [held, setHeld] = useState(false)
  const ref = useRef(null)
  const id = toast?.id
  const failed = Boolean(toast?.failed)

  useEffect(() => {
    setHeld(false)
  }, [id])

  useEffect(() => {
    if (id === undefined || held || failed) return undefined
    const timer = setTimeout(() => dismissToast(id), TOAST_MS)
    return () => clearTimeout(timer)
  }, [id, held, failed])

  const onBlur = (e) => {
    if (ref.current?.contains(e.relatedTarget)) return
    setHeld(false)
  }

  return (
    <div className="undo-toast-region" role="status" aria-live="polite" aria-atomic="true">
      {toast && (
        <div
          key={toast.id}
          ref={ref}
          className={`undo-toast${failed ? ' is-failed' : ''}`}
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
            {failed ? 'Could not reopen' : 'Completed'} <span className="undo-toast-title">{toast.title}</span>
          </span>
          {failed ? (
            <span className="undo-toast-actions">
              <button type="button" className="btn undo-toast-btn" aria-label={`Retry reopening ${toast.title}`} onClick={() => runUndo(toast)}>
                Retry
              </button>
              <button type="button" className="btn undo-toast-btn" aria-label={`Dismiss, ${toast.title} stays completed`} onClick={() => dismissToast(toast.id)}>
                Dismiss
              </button>
            </span>
          ) : (
            <button type="button" className="btn undo-toast-btn" aria-label={`Undo completing ${toast.title}`} onClick={() => runUndo(toast)}>
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  )
}

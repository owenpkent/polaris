import { useEffect, useRef, useState } from 'react'
import { dismissToast, runUndo, runView, useUndoToasts } from './command-center/undoToast'

export const TOAST_MS = 6000

// What a toast says, and its buttons' names, which carry the title so each is told apart.
function toastWords({ kind, title, where, failed }) {
  if (kind === 'moved') {
    return failed
      ? { lead: 'Could not move back', tail: '', retry: `Retry moving ${title} back`, dismiss: `Dismiss, ${title} stays in ${where}` }
      : { lead: 'Moved', tail: `to ${where}`, undo: `Undo moving ${title} to ${where}` }
  }
  return failed
    ? { lead: 'Could not reopen', tail: '', retry: `Retry reopening ${title}`, dismiss: `Dismiss, ${title} stays completed` }
    : { lead: 'Completed', tail: '', undo: `Undo completing ${title}` }
}

// "Completed <task>" with an Undo button, or "Moved <task> to <where>" with View and Undo, near
// the bottom of the screen (undoToast.js). The live
// region is always mounted so a screen reader announces each new toast; focus is never moved
// here. The timer restarts for each toast and waits while the pointer is over it or focus is in it.
// A failed Undo has no timer: it says so, with Retry and Dismiss, until the owner chooses, and it
// stacks above the current toast. This is mounted by App, so it still shows after the tab the task
// was completed on has gone. The title is third-party text at times: it is rendered as text only.
export default function UndoToast() {
  const toasts = useUndoToasts()
  const failures = toasts.filter((t) => t.failed)
  return (
    <div className="undo-toast-region" role="status" aria-live="polite" aria-atomic="true">
      {failures.length > 0 && <FailureStack failures={failures} />}
      {toasts.filter((t) => !t.failed).map((toast) => <Toast key={toast.id} toast={toast} />)}
    </div>
  )
}

// Failures do not expire, so there can be more than fit. They scroll in a box of their own, which
// the page cannot do for a fixed layer, and the newest, at the bottom, is the one in view.
function FailureStack({ failures }) {
  const ref = useRef(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [failures.length])
  return (
    <div ref={ref} className="undo-toast-failures">
      {failures.map((toast) => <Toast key={toast.id} toast={toast} />)}
    </div>
  )
}

function Toast({ toast }) {
  const { id, title, failed } = toast
  const moved = toast.kind === 'moved'
  const words = toastWords(toast)
  const [held, setHeld] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (held || failed) return undefined
    const timer = setTimeout(() => dismissToast(id), TOAST_MS)
    return () => clearTimeout(timer)
  }, [id, held, failed])

  const onBlur = (e) => {
    if (ref.current?.contains(e.relatedTarget)) return
    setHeld(false)
  }

  return (
    <div
      ref={ref}
      className={`undo-toast${failed ? ' is-failed' : ''}${moved && !failed ? ' is-moved' : ''}`}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => { if (!ref.current?.contains(document.activeElement)) setHeld(false) }}
      onFocus={() => setHeld(true)}
      onBlur={onBlur}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          dismissToast(id)
        }
      }}
    >
      <span className="undo-toast-text">
        {words.lead} <span className="undo-toast-title">{title}</span>{words.tail && ` ${words.tail}`}
      </span>
      {failed ? (
        <span className="undo-toast-actions">
          <button type="button" className="btn undo-toast-btn" aria-label={words.retry} onClick={() => runUndo(toast)}>
            Retry
          </button>
          <button type="button" className="btn undo-toast-btn" aria-label={words.dismiss} onClick={() => dismissToast(id)}>
            Dismiss
          </button>
        </span>
      ) : moved ? (
        <span className="undo-toast-actions">
          <button type="button" className="btn undo-toast-btn" aria-label={`View ${title} in ${toast.where}`} onClick={() => runView(toast)}>
            View
          </button>
          <button type="button" className="btn undo-toast-btn" aria-label={words.undo} onClick={() => runUndo(toast)}>
            Undo
          </button>
        </span>
      ) : (
        <button type="button" className="btn undo-toast-btn" aria-label={words.undo} onClick={() => runUndo(toast)}>
          Undo
        </button>
      )}
    </div>
  )
}

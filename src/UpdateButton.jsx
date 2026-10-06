import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Copy, Download, X } from 'lucide-react'
import { useOffline } from './command-center/offlineStatus'
import { useUpdateStatus } from './command-center/useUpdateStatus'

// The update icon and its panel (docs/update-proposal.md, section 4B). The icon sits in the top
// bar only while GET /api/update names a newer signed release. The panel shows the two versions
// and the release notes, and offers Update now, which records a request for the scheduled
// updater (outside the daemon) to install that exact version. It never carries a path or a URL.
// With no updater installed there is no button: the `cc update --release` line to copy instead.

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
const SEEN_KEY = 'cc.update.seenResult'

// A finished request's result is shown once. The id of the one shown is kept per device, so a
// private window or a cleared store shows it again, which is harmless.
function seenResult() {
  try { return localStorage.getItem(SEEN_KEY) } catch { return null }
}
function markSeen(id) {
  try { localStorage.setItem(SEEN_KEY, id) } catch { /* no storage: shown again next time */ }
}

export default function UpdateButton() {
  const { update, request, cancel } = useUpdateStatus()
  const [open, setOpen] = useState(false)
  const buttonRef = useRef(null)
  const available = update?.available ?? null

  // The icon goes with the release: when the update is in, the panel has nothing to say.
  useEffect(() => { if (!available) setOpen(false) }, [available])

  if (!available) return null

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Update available"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="icon-btn"
        style={{ color: 'var(--blue)' }}
      >
        <Download size={20} aria-hidden="true" />
      </button>
      {open && (
        <UpdatePanel
          update={update}
          onClose={() => { setOpen(false); buttonRef.current?.focus() }}
          onRequest={request}
          onCancel={cancel}
        />
      )}
    </>
  )
}

export function UpdatePanel({ update, onClose, onRequest, onCancel }) {
  const offline = useOffline()
  const containerRef = useRef(null)
  const closeRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)
  const [seen, setSeen] = useState(seenResult)
  const { running, available, updaterInstalled, request, command } = update

  useEffect(() => { closeRef.current?.focus() }, [])

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !containerRef.current) return
      const focusables = Array.from(containerRef.current.querySelectorAll(FOCUSABLE))
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      const inside = containerRef.current.contains(active)
      if (e.shiftKey) {
        if (active === first || !inside) { e.preventDefault(); last.focus() }
      } else if (active === last || !inside) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [onClose])

  async function act(fn) {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err?.message || 'The server did not take that.')
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  const finished = request && (request.state === 'done' || request.state === 'failed') && request.id !== seen ? request : null
  const dismiss = () => { markSeen(finished.id); setSeen(finished.id) }

  let state
  if (request?.state === 'pending') {
    state = (
      <>
        <p role="status" style={{ margin: '0 0 0.75rem', color: 'var(--t1)' }}>Requested. The updater picks it up within five minutes.</p>
        <button type="button" className="btn" disabled={busy || offline} onClick={() => act(() => onCancel(request.id))}>Cancel request</button>
      </>
    )
  } else if (request?.state === 'picked_up') {
    state = <p role="status" style={{ margin: 0, color: 'var(--t1)', fontWeight: 500 }}>Updating. The dashboard reconnects when the daemon is back.</p>
  } else if (finished) {
    state = (
      <>
        <p role="status" style={{ margin: '0 0 0.75rem', color: finished.state === 'done' ? 'var(--green)' : 'var(--red)', fontWeight: 500 }}>
          {finished.result || (finished.state === 'done' ? `Updated to v${finished.version}` : 'The update failed.')}
        </p>
        <button type="button" className="btn" onClick={dismiss}>Dismiss</button>
      </>
    )
  } else if (updaterInstalled) {
    state = (
      <button type="button" className="btn btn-primary" disabled={busy || offline} onClick={() => act(() => onRequest(available.version))}>
        Update now
      </button>
    )
  } else {
    state = (
      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor="cc-update-command">No scheduled updater is installed on the server. Run this there instead:</label>
        <input id="cc-update-command" type="text" readOnly value={command} onFocus={(e) => e.target.select()} style={{ fontFamily: 'ui-monospace, monospace' }} />
        <div>
          <button type="button" className="btn" onClick={copy}><Copy size={14} aria-hidden="true" /> {copied ? 'Copied' : 'Copy'}</button>
        </div>
      </div>
    )
  }

  // Portaled to <body>, as Menu.jsx's Popover is: the top bar is its own stacking context, and a
  // backdrop drawn inside it would sit under the task panel and the phone's tab bar.
  return createPortal(
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby="cc-update-title" className="sheet">
        <div className="sheet-header">
          <h2 id="cc-update-title" className="sheet-title">Update available</h2>
          <button ref={closeRef} type="button" className="icon-btn" aria-label="Close update panel" onClick={onClose} style={{ color: 'var(--t1)' }}>
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.25rem 1rem', margin: '0 0 0.75rem', fontSize: '0.9rem' }}>
          <dt style={{ color: 'var(--t2)' }}>Running</dt>
          <dd style={{ margin: 0, color: 'var(--t1)', fontVariantNumeric: 'tabular-nums' }}>{running}</dd>
          <dt style={{ color: 'var(--t2)' }}>New</dt>
          <dd style={{ margin: 0, color: 'var(--t1)', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{available.version}</dd>
        </dl>

        <section aria-label="Release notes" style={{ marginBottom: '0.75rem' }}>
          <div style={{ fontSize: '0.85rem', color: 'var(--t2)', fontWeight: 500, marginBottom: '0.3rem' }}>Release notes</div>
          <div
            style={{
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              maxHeight: 220,
              overflowY: 'auto',
              padding: '0.6rem 0.75rem',
              fontSize: '0.875rem',
              lineHeight: 1.5,
              color: 'var(--t1)',
              background: 'var(--bg3)',
              border: '1px solid var(--bd)',
              borderRadius: 'var(--radius)',
            }}
          >
            {available.notes?.trim() ? available.notes : 'No release notes.'}
          </div>
        </section>

        {available.touchesSchema && (
          <p style={{ margin: '0 0 0.75rem', fontSize: '0.875rem', color: 'var(--t2)' }}>
            This update changes the database; a snapshot is taken first.
          </p>
        )}

        {error && <p className="sheet-error" role="alert">{error}</p>}

        <div className="sheet-actions" style={{ display: 'block' }}>{state}</div>
      </div>
    </>,
    document.body
  )
}

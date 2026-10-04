import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { getDueBounds, localIso, addDays } from './dueDates'

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)'

// The next Monday as a local YYYY-MM-DD, never today.
function nextMondayIso(now = new Date()) {
  const days = ((1 - now.getDay() + 7) % 7) || 7
  return localIso(addDays(now, days))
}

// A link shown as host and path; the full address is in the line's title.
function linkLabel(url) {
  try {
    const u = new URL(url)
    const path = u.pathname === '/' ? '' : u.pathname
    return u.hostname + path
  } catch {
    return url
  }
}

// The phone's "new task" dialog, opened by the floating Add task button on My tasks. Title, a due
// date picked from chips or the date field, project, and notes; Enter in the title creates the
// task like the desktop's inline row does. Esc closes it, Tab stays inside, and focus goes back
// to the button that opened it. `onCreate` receives the create payload and may throw. When it
// resolves the sheet closes itself through `onClose`. Each opening is numbered, and a create that
// finishes after the sheet was closed and opened again leaves the new draft alone: it neither
// closes it nor puts the old request's error or busy state on it.
//
// `initial` ({ title, notes, sourceUrl } or null) starts the draft from a share (shareIntake.js).
// Its link is kept with the draft, shown as one read-only line, and sent as `sourceUrl`.
export default function NewTaskSheet({ open, onClose, onCreate, projects = [], openButtonRef, initial = null }) {
  const [title, setTitle] = useState('')
  const [dueAt, setDueAt] = useState(null)
  const [projectId, setProjectId] = useState('')
  const [notes, setNotes] = useState('')
  const [sourceUrl, setSourceUrl] = useState(null)
  const initialRef = useRef(initial)
  initialRef.current = initial
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const containerRef = useRef(null)
  const titleRef = useRef(null)
  const wasOpenRef = useRef(open)
  const openingRef = useRef(0)

  // A fresh form each time it opens, with the title focused.
  useEffect(() => {
    if (!open) return
    openingRef.current += 1
    setTitle(initialRef.current?.title || '')
    setDueAt(null)
    setProjectId('')
    setNotes(initialRef.current?.notes || '')
    setSourceUrl(initialRef.current?.sourceUrl || null)
    setBusy(false)
    setError(null)
    titleRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (wasOpenRef.current && !open) openButtonRef?.current?.focus()
    wasOpenRef.current = open
  }, [open, openButtonRef])

  useEffect(() => {
    if (!open) return undefined
    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
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
        if (active === first || !inside) {
          e.preventDefault()
          last.focus()
        }
      } else if (active === last || !inside) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) return null

  const bounds = getDueBounds()
  const chips = [
    { key: 'none', label: 'No date', value: null },
    { key: 'today', label: 'Today', value: bounds.today },
    { key: 'tomorrow', label: 'Tomorrow', value: bounds.tomorrow },
    { key: 'monday', label: 'Next Monday', value: nextMondayIso() },
  ]

  async function submit(e) {
    e?.preventDefault()
    const trimmed = title.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    const payload = { title: trimmed, dueAt }
    if (projectId) payload.projectId = projectId
    if (notes.trim()) payload.notes = notes.trim()
    if (sourceUrl) payload.sourceUrl = sourceUrl
    const opening = openingRef.current
    try {
      await onCreate(payload)
      if (opening === openingRef.current) onClose()
    } catch (err) {
      if (opening !== openingRef.current) return
      setError(err.message || 'Could not add task.')
      setBusy(false)
    }
  }

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <form
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label="New task"
        className="sheet"
        onSubmit={submit}
      >
        <div className="sheet-header">
          <h2 className="sheet-title">New task</h2>
          <button type="button" className="icon-btn" aria-label="Close new task" onClick={onClose} style={{ color: 'var(--t1)' }}>
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <div className="field">
          <label htmlFor="new-task-title">Title</label>
          <input
            id="new-task-title"
            ref={titleRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={busy}
            placeholder="Task name"
            aria-label="New task name"
            autoComplete="off"
          />
        </div>

        <div className="field">
          <span id="new-task-due-label" className="field-label">Due date</span>
          <div className="sheet-chips" role="group" aria-labelledby="new-task-due-label">
            {chips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                className="sheet-chip"
                aria-pressed={dueAt === chip.value}
                disabled={busy}
                onClick={() => setDueAt(chip.value)}
              >
                {chip.label}
              </button>
            ))}
          </div>
          <input
            type="date"
            aria-label="Other date"
            value={dueAt || ''}
            disabled={busy}
            onChange={(e) => setDueAt(e.target.value || null)}
          />
        </div>

        <div className="field">
          <label htmlFor="new-task-project">Project</label>
          <select id="new-task-project" value={projectId} disabled={busy} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">None</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="new-task-notes">Notes</label>
          <textarea id="new-task-notes" value={notes} disabled={busy} rows={3} onChange={(e) => setNotes(e.target.value)} />
        </div>

        {sourceUrl && (
          <p className="field-label" title={sourceUrl}>Link: {linkLabel(sourceUrl)}</p>
        )}

        {error && <p className="sheet-error" role="alert">{error}</p>}

        <div className="sheet-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !title.trim()}>Create</button>
        </div>
      </form>
    </>
  )
}

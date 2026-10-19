import { useEffect, useRef, useState } from 'react'
import { X, Calendar } from 'lucide-react'
import { dueDateOnly, dueTimeOnly, formatTime, getDueBounds, withDueDate } from './dueDates'
import { oneLine, useFitToText } from './useFitToText'
import AddDuePanel, { nextMondayIso } from './AddDuePanel'
import { RepeatPicker } from './RepeatBuilder'
import { followDate } from './recurrenceRules'

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)'

// The picked date in full, with its time when it has one: "Mon, Oct 19, 2026, 9:00 AM".
function dateLabel(iso) {
  const d = new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)))
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
  const time = dueTimeOnly(iso)
  return time ? `${day}, ${formatTime(time)}` : day
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
// date picked from chips or the calendar, a repeat rule, project, and notes. Enter in the title
// opens "When is it due?" (AddDuePanel.jsx) in place of the form, as the desktop's inline row does;
// a tap there sets the date and comes back to the form with Create focused, and Esc or Back comes
// back without changing it. Esc on the form closes it, Tab stays inside, and focus goes back
// to the button that opened it. `onCreate` receives the create payload and may throw. When it
// resolves the sheet closes itself through `onClose`. Each opening is numbered, and a create that
// finishes after the sheet was closed and opened again leaves the new draft alone: it neither
// closes it nor puts the old request's error or busy state on it.
//
// `initial` ({ title, notes, sourceUrl } or null) starts the draft from a share (shareIntake.js).
// Its link is kept with the draft, shown as one read-only line, and sent as `sourceUrl`. A new
// `seed` while the sheet is open starts the draft again from the current `initial`, as a new
// opening: a create still in flight for the old draft then leaves the new one alone.
export default function NewTaskSheet({ open, onClose, onCreate, projects = [], openButtonRef, initial = null, seed = 0, api }) {
  const [title, setTitle] = useState('')
  const [dueAt, setDueAt] = useState(null)
  const [recurrence, setRecurrence] = useState('')
  const [customRepeat, setCustomRepeat] = useState(false)
  const [step, setStep] = useState('form')
  const createRef = useRef(null)
  const pickRef = useRef(null)
  // Where focus goes when the date step closes: Create after a pick, the button that opened it otherwise.
  const returnFocusRef = useRef(null)
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
  // Measured when the box mounts (the sheet opening) and as the title changes; titleRef is for
  // focusing it.
  const attachTitle = useFitToText(title, titleRef)

  // A fresh form each time it opens or is reseeded, with the title focused.
  useEffect(() => {
    if (!open) return
    openingRef.current += 1
    setTitle(initialRef.current?.title || '')
    setDueAt(null)
    setRecurrence('')
    setStep('form')
    setProjectId('')
    setNotes(initialRef.current?.notes || '')
    setSourceUrl(initialRef.current?.sourceUrl || null)
    setBusy(false)
    setError(null)
    titleRef.current?.focus()
  }, [open, seed])

  useEffect(() => {
    if (wasOpenRef.current && !open) openButtonRef?.current?.focus()
    wasOpenRef.current = open
  }, [open, openButtonRef])

  useEffect(() => {
    if (!open) return undefined
    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (step === 'date') closeDateStep()
        else onClose()
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
  }, [open, onClose, step])

  // The date step opens on the day already picked (or today), focused, so Enter keeps it.
  useEffect(() => {
    if (step === 'date') containerRef.current?.querySelector('[data-cal-focus]')?.focus()
  }, [step])

  // Back on the form, focus goes where the date step said: Create after a pick, else its opener.
  useEffect(() => {
    if (step !== 'form' || !returnFocusRef.current) return
    returnFocusRef.current.current?.focus()
    returnFocusRef.current = null
  }, [step])

  function openDateStep(fromRef) {
    returnFocusRef.current = fromRef
    setStep('date')
  }

  // Done in the date step (a date, or null for No date) brings the choice back to the form, where
  // Create is next once there is a title to create with.
  function pickDate(value) {
    setDueAt(value)
    returnFocusRef.current = title.trim() ? createRef : pickRef
    setStep('form')
  }

  // A quick date on the form; a plain repeat moves with it, as it does in the date step, and one
  // made in Custom stays.
  function chooseChip(value) {
    if (recurrence && !customRepeat && value) setRecurrence(followDate(recurrence, dueDateOnly(dueAt) || getDueBounds().today, value))
    setDueAt(withDueDate(dueAt, value))
  }

  // Back, or Esc: the date stays as it was.
  function closeDateStep() {
    setStep('form')
  }

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
    if (recurrence) payload.recurrence = recurrence
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
        className={step === 'date' ? 'sheet sheet-cal' : 'sheet'}
        onSubmit={submit}
      >
        {step === 'date' ? (
          <>
            <div className="sheet-header">
              <h2 className="sheet-title">New task</h2>
              <button type="button" className="icon-btn" aria-label="Close new task" onClick={onClose} style={{ color: 'var(--t1)' }}>
                <X size={20} aria-hidden="true" />
              </button>
            </div>
            <p className="sheet-draft-title">{title.trim()}</p>
            <AddDuePanel dueAt={dueAt} onPick={pickDate} recurrence={recurrence} onRecurrenceChange={setRecurrence} api={api} submitLabel="Done" customRepeat={customRepeat} onCustomRepeatChange={setCustomRepeat} />
            <div className="sheet-actions">
              <button type="button" className="btn" onClick={closeDateStep}>Back</button>
            </div>
          </>
        ) : (
        <>
        <div className="sheet-header">
          <h2 className="sheet-title">New task</h2>
          <button type="button" className="icon-btn" aria-label="Close new task" onClick={onClose} style={{ color: 'var(--t1)' }}>
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <div className="field">
          <label htmlFor="new-task-title">Title</label>
          {/* Grows with its text, so a long title is seen whole while it is typed; Enter goes on to
              the due date, as it does in the desktop's add row. */}
          <textarea
            id="new-task-title"
            ref={attachTitle}
            rows={1}
            value={title}
            onChange={(e) => setTitle(oneLine(e.target.value))}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
              e.preventDefault()
              if (title.trim() && !busy) openDateStep(titleRef)
            }}
            disabled={busy}
            placeholder="Task name"
            aria-label="New task name"
            autoComplete="off"
            // minHeight: the sheet gives its text boxes room for notes; a title starts one 44px line.
            style={{ resize: 'none', overflow: 'hidden', overflowWrap: 'anywhere', flexShrink: 0, minHeight: 'var(--target)' }}
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
                aria-pressed={dueDateOnly(dueAt) === chip.value}
                disabled={busy}
                // A quick date keeps a time already picked; No date drops both.
                onClick={() => chooseChip(chip.value)}
              >
                {chip.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            ref={pickRef}
            className="btn sheet-pick-date"
            disabled={busy}
            onClick={() => openDateStep(pickRef)}
          >
            <Calendar size={16} aria-hidden="true" />
            <span>{dueAt && (dueTimeOnly(dueAt) || !chips.some((chip) => chip.value === dueAt)) ? dateLabel(dueAt) : 'Pick a date'}</span>
          </button>
        </div>

        <div className="field">
          <RepeatPicker id="new-task-repeat" value={recurrence} onChange={setRecurrence} dueIso={dueDateOnly(dueAt) || undefined} api={api} disabled={busy} initialCustom={customRepeat} onCustomChange={setCustomRepeat} />
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
          <button type="submit" ref={createRef} className="btn btn-primary" disabled={busy || !title.trim()}>Create</button>
        </div>
        </>
        )}
      </form>
    </>
  )
}

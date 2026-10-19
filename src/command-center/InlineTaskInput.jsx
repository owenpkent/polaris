import { useEffect, useRef, useState } from 'react'
import { Calendar } from 'lucide-react'
import { Popover } from './Menu'
import AddDuePanel from './AddDuePanel'
import { formatDueCell, getDueBounds } from './dueDates'

// A single-row inline "new task" input used by the toolbar's "Add task" button and each group's
// trailing "Add task" row. Enter with a title, or the due date button beside it, opens "When is it
// due?" (AddDuePanel.jsx) under the row, on the group's date, with Repeats under the month: Add task
// there calls onSubmit(title, { dueAt, recurrence }), and Enter again keeps the group's date. Esc
// there goes back to the title; Esc in the title, or leaving it empty, cancels.
export default function InlineTaskInput({ onSubmit, onCancel, gridTemplateColumns, defaultDueAt = null, api }) {
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [picking, setPicking] = useState(false)
  const [recurrence, setRecurrence] = useState('')
  const inputRef = useRef(null)
  const rowRef = useRef(null)
  const dueText = formatDueCell(defaultDueAt, getDueBounds()).text || 'Due date'

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  async function commit(dueAt) {
    const trimmed = title.trim()
    if (!trimmed || busy) return
    setPicking(false)
    setBusy(true)
    setError(null)
    try {
      await onSubmit(trimmed, { dueAt, recurrence: recurrence || null })
    } catch (err) {
      setError(err.message || 'Could not add task.')
      setBusy(false)
      inputRef.current?.focus()
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (title.trim() && !busy) setPicking(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <div className="mytasks-grid" style={{ gridTemplateColumns, alignItems: 'center', minHeight: 44, borderBottom: '1px solid var(--bd)' }}>
      <span aria-hidden="true" />
      {/* The popover's anchor, so a click on the due date button is not a click outside it. Esc
          there focuses the anchor, which hands focus on to the title. */}
      <div
        ref={rowRef}
        className="inline-add"
        tabIndex={-1}
        onFocus={(e) => { if (e.target === e.currentTarget) inputRef.current?.focus() }}
        style={{ gridColumn: error ? '2' : '2 / -1' }}
      >
        <input
          ref={inputRef}
          className="inline-add-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={handleKeyDown}
          // Leaving an empty row cancels it, unless focus went to its own due date button.
          onBlur={(e) => { if (!title.trim() && !busy && !rowRef.current?.contains(e.relatedTarget)) onCancel() }}
          disabled={busy}
          placeholder="Task name"
          aria-label="New task name"
          aria-haspopup="dialog"
          aria-expanded={picking}
        />
        {/* Asana's due date cell on its new row: the date and repeat can be set without knowing that
            Enter opens them. It needs a title first, as Add task does. */}
        <button
          type="button"
          className="btn inline-add-due"
          disabled={busy || !title.trim()}
          aria-haspopup="dialog"
          aria-expanded={picking}
          aria-label={defaultDueAt ? `Due date: ${dueText}` : 'Due date'}
          onClick={() => setPicking(true)}
        >
          <Calendar size={16} aria-hidden="true" />
          <span>{dueText}</span>
        </button>
      </div>
      {error && (
        <span style={{ gridColumn: '3 / -1', paddingLeft: '0.75rem', fontSize: '0.8rem', color: 'var(--red)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {error}
        </span>
      )}
      <Popover anchorRef={rowRef} open={picking} onClose={() => setPicking(false)} minWidth={320} maxWidth={640} gutter={0} focusSelector="[data-cal-focus]">
        <div role="dialog" aria-label={`Due date for ${title.trim()}`} className="add-due-pop">
          <AddDuePanel dueAt={defaultDueAt} onPick={commit} recurrence={recurrence} onRecurrenceChange={setRecurrence} api={api} />
        </div>
      </Popover>
    </div>
  )
}

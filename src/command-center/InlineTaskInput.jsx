import { useEffect, useRef, useState } from 'react'
import { Popover } from './Menu'
import AddDuePanel from './AddDuePanel'

// A single-row inline "new task" input used by the toolbar's "Add task" button and each group's
// trailing "Add task" row. Enter with a title opens "When is it due?" (AddDuePanel.jsx) under the
// row, on the group's date: a tap on a day or a quick pick calls onSubmit(title, { dueAt,
// recurrence }), and Enter again keeps the group's date. Esc there goes back to the title; Esc in
// the title, or leaving it empty, cancels.
export default function InlineTaskInput({ onSubmit, onCancel, gridTemplateColumns, defaultDueAt = null, api }) {
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [picking, setPicking] = useState(false)
  const [recurrence, setRecurrence] = useState('')
  const inputRef = useRef(null)

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
      <input
        ref={inputRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => { if (!title.trim() && !busy) onCancel() }}
        disabled={busy}
        placeholder="Task name"
        aria-label="New task name"
        aria-haspopup="dialog"
        aria-expanded={picking}
        style={{
          gridColumn: error ? '2' : '2 / -1',
          minWidth: 0,
          height: 44,
          padding: '0 0.75rem',
          border: '1px solid var(--bd-strong)',
          borderRadius: 'var(--radius)',
          background: 'var(--bg2)',
          color: 'var(--t1)',
          font: 'inherit',
          fontSize: '0.9375rem',
        }}
      />
      {error && (
        <span style={{ gridColumn: '3 / -1', paddingLeft: '0.75rem', fontSize: '0.8rem', color: 'var(--red)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {error}
        </span>
      )}
      <Popover anchorRef={inputRef} open={picking} onClose={() => setPicking(false)} minWidth={320} gutter={0} focusSelector="[data-cal-focus]">
        <div role="dialog" aria-label={`Due date for ${title.trim()}`} className="add-due-pop">
          <AddDuePanel dueAt={defaultDueAt} onPick={commit} recurrence={recurrence} onRecurrenceChange={setRecurrence} api={api} />
        </div>
      </Popover>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'

// A single-row inline "new task" input used by the toolbar's "Add task" button
// and each group's trailing "Add task" row. Enter calls onSubmit(title), which
// creates the task with the group's due date; Esc, or leaving it empty, cancels.
export default function InlineTaskInput({ onSubmit, onCancel, gridTemplateColumns }) {
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  async function commit() {
    const trimmed = title.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(trimmed)
    } catch (err) {
      setError(err.message || 'Could not add task.')
      setBusy(false)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
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
    </div>
  )
}

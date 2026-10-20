import { useEffect, useRef, useState } from 'react'
import { Calendar } from 'lucide-react'
import { Popover } from './Menu'
import AddDuePanel from './AddDuePanel'
import { formatDueCell, getDueBounds } from './dueDates'

// A single-row inline "new task" input used by the toolbar's "Add task" button and each group's
// "Add task" row, which opens it at the top of the group, as Asana's list does. Enter with a title
// adds the task on the group's date at once, then empties the row and keeps focus in it, so several
// tasks can be typed one after another. The due date button beside the name opens "When is it
// due?" (AddDuePanel.jsx) under the row, on the group's date, with Repeats under the month: Add
// task there calls onSubmit(title, { dueAt, recurrence }), and the next row starts on the group's
// date again. Esc there goes back to the title, dropping what was picked; Esc in the title, or
// leaving it empty, closes the row with nothing saved. A create that fails keeps the title and what
// Add task handed over (the date, the repeat, and whether the repeat was made in Custom), so the
// picker reopens on it for another try.
export default function InlineTaskInput({ onSubmit, onCancel, gridTemplateColumns, defaultDueAt = null, api }) {
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [picking, setPicking] = useState(false)
  const [dueAt, setDueAt] = useState(defaultDueAt)
  const [recurrence, setRecurrence] = useState('')
  const [customRepeat, setCustomRepeat] = useState(false)
  const inputRef = useRef(null)
  const rowRef = useRef(null)
  const mounted = useRef(true)
  const dueText = formatDueCell(dueAt, getDueBounds()).text || 'Due date'

  useEffect(() => {
    mounted.current = true
    inputRef.current?.focus()
    return () => { mounted.current = false }
  }, [])

  // Whether a pointer is pressed, so a click elsewhere that empties focus from the row waits for
  // the release before the row closes: closing on the press would move the rows under it up by a
  // row, and the release would land on whatever moved under the pointer instead of what was hit.
  const pointerDown = useRef(false)
  useEffect(() => {
    const down = () => { pointerDown.current = true }
    const up = () => { pointerDown.current = false }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', up, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', up, true)
    }
  }, [])

  function closeIfLeftEmpty() {
    const input = inputRef.current
    if (!mounted.current || !input || input.value.trim() || rowRef.current?.contains(document.activeElement)) return
    onCancel()
  }

  function handleBlur(e) {
    if (title.trim() || busy || rowRef.current?.contains(e.relatedTarget)) return
    if (!pointerDown.current) {
      onCancel()
      return
    }
    // After the release and the click it makes, which run in the same task as pointerup.
    window.addEventListener('pointerup', () => setTimeout(closeIfLeftEmpty, 0), { once: true, capture: true })
  }

  async function commit(picked, draft) {
    const trimmed = title.trim()
    if (!trimmed || busy) return
    setPicking(false)
    setDueAt(picked)
    setRecurrence(draft.recurrence)
    setCustomRepeat(draft.customRepeat)
    setBusy(true)
    setError(null)
    try {
      await onSubmit(trimmed, { dueAt: picked, recurrence: draft.recurrence || null })
      if (!mounted.current) return
      // Saved: the next row starts clean, on the group's date.
      setTitle('')
      setDueAt(defaultDueAt)
      setRecurrence('')
      setCustomRepeat(false)
    } catch (err) {
      if (!mounted.current) return
      setError(err.message || 'Could not add task.')
    }
    setBusy(false)
    inputRef.current?.focus()
  }

  // Whether an IME composition is open, so the Enter that confirms a candidate in a Chinese,
  // Japanese, or Korean input method is not the Enter that adds the task. Browsers mark that key
  // differently: Chrome fires it with isComposing, Safari after compositionend with keyCode 229,
  // and some fire it before compositionend with neither, which the flag covers.
  const composing = useRef(false)

  function handleKeyDown(e) {
    if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter') {
      e.preventDefault()
      commit(dueAt, { recurrence, customRepeat })
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <div className="mytasks-grid inline-add-row" style={{ gridTemplateColumns, alignItems: 'center', minHeight: 44, borderBottom: '1px solid var(--bd)' }}>
      {/* The empty circle a row has, so the new row reads as the task it will be. */}
      <span aria-hidden="true" className="inline-add-check">
        <span className="task-check-circle" />
      </span>
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
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={() => { composing.current = false }}
          // Leaving an empty row closes it, unless focus went to its own due date button.
          onBlur={handleBlur}
          // Read-only rather than disabled while it saves, so focus stays in the row for the next.
          readOnly={busy}
          aria-busy={busy || undefined}
          placeholder="Write a task name"
          aria-label="New task name"
        />
        {/* Asana's due date cell on its new row: the date and repeat are set here before the
            task is added. It needs a title first, as Add task does. */}
        <button
          type="button"
          className="btn inline-add-due"
          disabled={busy || !title.trim()}
          aria-haspopup="dialog"
          aria-expanded={picking}
          aria-label={dueAt ? `Due date: ${dueText}` : 'Due date'}
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
      <Popover anchorRef={rowRef} open={picking} onClose={() => setPicking(false)} minWidth={320} maxWidth={768} gutter={0} focusSelector="[data-cal-focus]">
        <div role="dialog" aria-label={`Due date for ${title.trim()}`} className="add-due-pop">
          <AddDuePanel dueAt={dueAt} onPick={commit} recurrence={recurrence} customRepeat={customRepeat} api={api} />
        </div>
      </Popover>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { GripVertical } from 'lucide-react'
import { Popover } from './Menu'
import AddDuePanel from './AddDuePanel'
import { formatDueCell, getDueBounds } from './dueDates'
import { afterRelease, usePointerPress } from './pointerPress'

// A single-row inline "new task" input used by the toolbar's "Add task" button and each group's
// "Add task" row, which it replaces in place, at the end of the group. Enter with a title
// adds the task on the group's date at once, then empties the row and keeps focus in it, so several
// tasks can be typed one after another; MyTasksTab keeps them just above the row, in the order they
// were typed, until it closes. The name takes the Name column alone and the due date
// button sits in the Due date column, as a task row has them (`dueColumn`; with that column hidden
// the button follows the name). It opens "When is it due?" (AddDuePanel.jsx) under itself, on
// the group's date, with Repeats under the month: Add task there calls onSubmit(title, { dueAt,
// recurrence }), and the next row starts on the group's date again. Esc there goes back to the
// title, dropping what was picked; a click outside it keeps the picks on the row without adding the
// task, and a click that also leaves the row adds it with them. Esc in the title, or
// leaving it empty, closes the row with nothing saved. A click elsewhere with a title in it adds
// the task on the row's date, as Enter does, and closes the row once it is saved; leaving it by
// keyboard keeps the draft. A create that fails keeps the title and what Add task handed over
// (the date, the repeat, and whether the repeat was made in Custom), so the picker reopens on it
// for another try.
// `handleColumn` adds the leading cell the rows have under the manual sort (TaskRow.jsx), with
// the grip their handle shows, drawn only: the task can be moved once it is added.
export default function InlineTaskInput({ onSubmit, onCancel, gridTemplateColumns, dueColumn = true, phone = false, defaultDueAt = null, api, handleColumn = false }) {
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [picking, setPicking] = useState(false)
  const [dueAt, setDueAt] = useState(defaultDueAt)
  const [recurrence, setRecurrence] = useState('')
  const [customRepeat, setCustomRepeat] = useState(false)
  const inputRef = useRef(null)
  const rowRef = useRef(null)
  const dueAnchorRef = useRef(null)
  // On a phone the picker spans the screen with no margin, so seven 44px days fit at 320px; on a
  // desktop it opens under the due date button and keeps 8px off the window's edge (`phone`).
  const mounted = useRef(true)
  // The row's date and repeat as the latest render or the picker's last leave left them, read by
  // the click-away add, which can run before a state update from the picker closing has rendered.
  const picksRef = useRef(null)
  picksRef.current = { dueAt, recurrence, customRepeat }
  const dueCell = formatDueCell(dueAt, getDueBounds())
  const dueText = dueCell.text || 'Due date'
  // Counts the tasks saved from this row. Each one pushes the row down, so it is kept on screen.
  const [saved, setSaved] = useState(0)

  useEffect(() => {
    mounted.current = true
    inputRef.current?.focus()
    return () => { mounted.current = false }
  }, [])

  // jsdom has no scrollIntoView.
  useEffect(() => {
    if (saved > 0) rowRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [saved])

  // A click elsewhere that takes focus from the row waits for the release before the row closes
  // or adds: closing on the press would move the rows under it up by a row, and the release would
  // land on whatever moved under the pointer instead of what was hit (pointerPress.js).
  const press = usePointerPress()
  // Set by Esc, so the blur of a row being taken away adds nothing.
  const cancelled = useRef(false)

  function focusTitle(e) {
    if (e.target === e.currentTarget) inputRef.current?.focus()
  }

  function closeIfLeftEmpty() {
    const input = inputRef.current
    if (!mounted.current || !input || input.value.trim() || rowRef.current?.contains(document.activeElement)) return
    onCancel()
  }

  // Added on the release, before the click it makes lands, unless that click is in the row or
  // focus came back to it. A create cannot answer before the click, so nothing moves under it.
  function addOnLeave(release) {
    const row = rowRef.current
    if (!mounted.current || cancelled.current || row?.contains(release?.target) || row?.contains(document.activeElement)) return
    const picks = picksRef.current
    commit(picks.dueAt, { recurrence: picks.recurrence, customRepeat: picks.customRepeat }, { leave: true })
  }

  // The picker closed any way but Esc or Add task (a click outside it): the picks stay on the row.
  // Closing it adds nothing; a click away that also leaves the row adds through addOnLeave, which
  // reads them from picksRef.
  function keepPicks(picked, draft) {
    picksRef.current = { dueAt: picked, recurrence: draft.recurrence, customRepeat: draft.customRepeat }
    if (!mounted.current) return
    setDueAt(picked)
    setRecurrence(draft.recurrence)
    setCustomRepeat(draft.customRepeat)
  }

  function handleBlur(e) {
    if (busy || cancelled.current || rowRef.current?.contains(e.relatedTarget)) return
    if (title.trim()) {
      if (!press.current.clicking) return
      if (press.current.held) afterRelease(addOnLeave)
      else addOnLeave()
      return
    }
    if (!press.current.held) {
      onCancel()
      return
    }
    // After the release and the click it makes, which run in the same task as pointerup.
    afterRelease(() => setTimeout(closeIfLeftEmpty, 0))
  }

  // `leave` is a click elsewhere: once saved the row closes, unless focus has come back to it,
  // and focus is not pulled back to the row either way.
  async function commit(picked, draft, { leave = false } = {}) {
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
      if (leave && !rowRef.current?.contains(document.activeElement)) {
        onCancel()
        return
      }
      // Saved: the next row starts clean, on the group's date.
      setTitle('')
      setDueAt(defaultDueAt)
      setRecurrence('')
      setCustomRepeat(false)
      setSaved((n) => n + 1)
    } catch (err) {
      if (!mounted.current) return
      setError(err.message || 'Could not add task.')
    }
    setBusy(false)
    if (!leave) inputRef.current?.focus()
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
      cancelled.current = true
      onCancel()
    }
  }

  // Asana's due date cell on its new row: the date and repeat are set here before the task is
  // added. It needs a title first, as Add task does. It sits in the Due date column, drawn as the
  // rows' own date cells are, its text in line with theirs; with that column hidden it follows the name.
  const dueButton = (
    <span
      ref={dueAnchorRef}
      className="inline-add-due-anchor"
      // The popover's anchor, so a click on the button is not a click outside it. Esc there
      // focuses the anchor, which hands focus on to the title.
      tabIndex={-1}
      onFocus={focusTitle}
    >
      <button
        type="button"
        className="inline-add-due"
        disabled={busy || !title.trim()}
        aria-haspopup="dialog"
        aria-expanded={picking}
        aria-label={dueAt ? `Due date: ${dueText}` : 'Due date'}
        // Coloured as the row's date will be once it is added; disabled draws its own grey.
        style={busy || !title.trim() ? undefined : { color: dueCell.color || 'var(--t2)' }}
        onClick={() => setPicking(true)}
      >
        {dueText}
      </button>
    </span>
  )

  return (
    // Focusable but out of the tab order, so a press on the row's empty parts, or on its button
    // where a browser does not focus buttons on a click, keeps focus in the row.
    <div
      ref={rowRef}
      tabIndex={-1}
      onFocus={focusTitle}
      className="mytasks-grid inline-add-row"
      style={{ gridTemplateColumns, alignItems: 'center', minHeight: 'var(--row)', borderBottom: '1px solid var(--bd)' }}
    >
      {handleColumn && (
        <span aria-hidden="true" className="inline-add-handle">
          <GripVertical size={16} />
        </span>
      )}
      {/* The empty circle a row has, so the new row reads as the task it will be. */}
      <span aria-hidden="true" className="inline-add-check">
        <span className="task-check-circle" />
      </span>
      {/* The name box takes the Name column alone, as a task's name does in the rows below. */}
      <div className="inline-add" style={{ gridColumn: handleColumn ? 3 : 2 }}>
        <input
          ref={inputRef}
          className="inline-add-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={() => { composing.current = false }}
          // Leaving an empty row closes it, and a click elsewhere adds a named one, unless focus
          // went to its own due date button.
          onBlur={handleBlur}
          // Read-only rather than disabled while it saves, so focus stays in the row for the next.
          readOnly={busy}
          aria-busy={busy || undefined}
          placeholder="Write a task name"
          aria-label="New task name"
        />
        {!dueColumn && dueButton}
      </div>
      {dueColumn && <div className="inline-add-due-cell" style={{ gridColumn: handleColumn ? 4 : 3 }}>{dueButton}</div>}
      {error && <span className="inline-add-error" style={{ gridColumn: handleColumn ? '3 / -1' : '2 / -1' }}>{error}</span>}
      <Popover anchorRef={dueAnchorRef} open={picking} onClose={() => setPicking(false)} minWidth={320} maxWidth={768} gutter={phone ? 0 : 8} preferFit focusSelector="[data-cal-focus]">
        <div role="dialog" aria-label={`Due date for ${title.trim()}`} className="add-due-pop">
          <AddDuePanel dueAt={dueAt} onPick={commit} onLeave={keepPicks} recurrence={recurrence} customRepeat={customRepeat} api={api} />
        </div>
      </Popover>
    </div>
  )
}

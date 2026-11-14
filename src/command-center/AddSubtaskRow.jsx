import { useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { afterRelease, usePointerPress } from './pointerPress'

// The "Add subtask" row after the last subtask shown under a task in My tasks (TaskTree in
// TaskRow.jsx). It is laid out as a nested row is: an empty cell under the check column, then in
// the name cell the indent, a 44px cell where a subtask's check is (holding the Plus), and the
// words where a subtask's name starts. `depth` is the depth of the subtasks it adds, and
// `handleColumn` the extra leading column the rows have under the manual sort.
//
// At rest it is one quiet button, "Add subtask to <parent>". Pressing it turns it into a box in
// the same place. Enter adds the subtask under the parent, empties the box, and keeps it open for
// the next one. Esc, or leaving it empty, closes it with nothing saved. A click elsewhere with a
// title in it adds the subtask on the release, as the list's Add task row does
// (InlineTaskInput.jsx), and closes the box once it is saved; leaving by keyboard keeps the draft.
// A create that fails shows why under the row and keeps what was typed. Creates are queued when
// the server is away (api.createTask, the outbox), so nothing here is disabled offline.
export default function AddSubtaskRow({ parent, depth, gridTemplateColumns, handleColumn = false, onAdd }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)
  const buttonRef = useRef(null)
  const rowRef = useRef(null)
  const mounted = useRef(true)
  // Set by Esc, so the blur of a box being taken away adds nothing; true too while the button
  // should take focus back after the box closes.
  const cancelled = useRef(false)
  const refocusButton = useRef(false)
  const press = usePointerPress()

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (editing) inputRef.current?.focus()
    else if (refocusButton.current) {
      refocusButton.current = false
      buttonRef.current?.focus()
    }
  }, [editing])

  function open() {
    cancelled.current = false
    setError(null)
    setEditing(true)
  }

  function close({ returnFocus = false } = {}) {
    refocusButton.current = returnFocus
    setTitle('')
    setError(null)
    setEditing(false)
  }

  function closeIfLeftEmpty() {
    const input = inputRef.current
    if (!mounted.current || !input || input.value.trim() || rowRef.current?.contains(document.activeElement)) return
    close()
  }

  async function commit({ leave = false } = {}) {
    const trimmed = title.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    let closed = false
    try {
      await onAdd(parent, trimmed)
      if (!mounted.current) return
      if (leave && !rowRef.current?.contains(document.activeElement)) {
        close()
        closed = true
        return
      }
      setTitle('')
    } catch (err) {
      if (!mounted.current) return
      setError(err.message || 'Could not add that subtask.')
    } finally {
      // Every settled save ends the busy state, the click-away save that closes the box too:
      // the row stays mounted, so a box opened again later would otherwise stay read-only.
      if (mounted.current) setBusy(false)
    }
    if (!leave && !closed) inputRef.current?.focus()
  }

  // Added on the release, before the click it makes lands, unless that click is in the row or
  // focus came back to it.
  function addOnLeave(release) {
    const row = rowRef.current
    if (!mounted.current || cancelled.current || row?.contains(release?.target) || row?.contains(document.activeElement)) return
    commit({ leave: true })
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
      close()
      return
    }
    afterRelease(() => setTimeout(closeIfLeftEmpty, 0))
  }

  // An IME composition in progress: the Enter that confirms a candidate does not add.
  const composing = useRef(false)

  function handleKeyDown(e) {
    if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      cancelled.current = true
      close({ returnFocus: true })
    }
  }

  const indent = (depth - 1) * 24
  const plus = (
    <span aria-hidden="true" className="add-subtask-plus">
      <Plus size={16} />
    </span>
  )

  return (
    <div
      ref={rowRef}
      className="mytasks-grid add-subtask-row"
      style={{ gridTemplateColumns, alignItems: 'center', minHeight: 'var(--row)', borderBottom: '1px solid var(--bd)' }}
    >
      <span aria-hidden="true" />
      <span className="mytasks-name" style={{ gridColumn: '2 / -1', paddingRight: 12 }}>
        {indent > 0 && <span aria-hidden="true" style={{ flex: '0 0 auto', width: indent }} />}
        {editing ? (
          <>
            {plus}
            <input
              ref={inputRef}
              className="inline-add-title add-subtask-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => { composing.current = true }}
              onCompositionEnd={() => { composing.current = false }}
              onBlur={handleBlur}
              // Read-only rather than disabled while it saves, so focus stays for the next one.
              readOnly={busy}
              aria-busy={busy || undefined}
              placeholder="Write a subtask name"
              aria-label={`New subtask of ${parent.title}`}
            />
          </>
        ) : (
          <button ref={buttonRef} type="button" className="add-subtask-btn" aria-label={`Add subtask to ${parent.title}`} onClick={open}>
            {plus}
            <span aria-hidden="true">Add subtask</span>
          </button>
        )}
      </span>
      {error && <span className="inline-add-error" style={{ gridColumn: '2 / -1', paddingLeft: indent + 44 + 6 }}>{error}</span>}
    </div>
  )
}

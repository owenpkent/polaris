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
  const [title, setTitleState] = useState('')
  const [busy, setBusyState] = useState(false)
  // The draft and the save in flight as they are now, for a save that settles after newer
  // renders: one closure cannot see a name typed while it was waiting.
  const titleRef = useRef('')
  const busyRef = useRef(false)
  // How focus left the row while a save was in flight ('click' or 'key'), a blur the busy row
  // could not act on then: the save acts on it once it settles.
  const leftWhileBusy = useRef(null)
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

  function setTitle(value) {
    titleRef.current = value
    setTitleState(value)
  }

  function setBusy(value) {
    busyRef.current = value
    setBusyState(value)
  }

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // Counts the subtasks saved from this box. Each one pushes the box down, so it is kept on
  // screen (above the phone's keyboard too). jsdom has no scrollIntoView.
  const [saved, setSaved] = useState(0)
  useEffect(() => {
    if (saved > 0) rowRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [saved])

  // A name typed while a save waited, then left by a click: saved once the render that shows the
  // first save has run, so it is sent with the parent's list as it is then.
  const [queued, setQueued] = useState(0)
  useEffect(() => {
    if (!queued || !mounted.current || rowRef.current?.contains(document.activeElement) || !titleRef.current.trim()) return
    commit({ leave: true })
  }, [queued]) // eslint-disable-line react-hooks/exhaustive-deps

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
    const sent = titleRef.current
    const trimmed = sent.trim()
    if (!trimmed || busyRef.current) return
    leftWhileBusy.current = null
    setBusy(true)
    setError(null)
    let ok = false
    try {
      await onAdd(parent, trimmed)
      ok = true
    } catch (err) {
      if (mounted.current) setError(err.message || 'Could not add that subtask.')
    } finally {
      // Every settled save ends the busy state, the click-away save that closes the box too:
      // the row stays mounted, so a box opened again later would otherwise stay busy.
      if (mounted.current) setBusy(false)
    }
    if (!mounted.current) return
    const left = leftWhileBusy.current
    leftWhileBusy.current = null
    if (ok) {
      // Only what was sent is cleared: a name typed while it saved stays.
      if (titleRef.current === sent) setTitle('')
      setSaved((n) => n + 1)
    }
    if (rowRef.current?.contains(document.activeElement)) {
      if (!leave) inputRef.current?.focus()
      return
    }
    // Focus has left the row. A failed save keeps the box and says why. Otherwise an empty box
    // closes, once a held press has been released, so nothing moves under it first. A name
    // typed while it saved is saved in turn when the last way out was a click, as that click
    // would have done had the row not been busy; left last by keyboard, it stays a draft.
    if (!ok) return
    const last = left ?? (leave ? 'click' : null)
    if (!titleRef.current.trim()) {
      if (press.current.held) afterRelease(() => setTimeout(closeIfLeftEmpty, 0))
      else close()
    } else if (last === 'click') setQueued((n) => n + 1)
  }

  // Added on the release, before the click it makes lands, unless that click is in the row or
  // focus came back to it.
  function addOnLeave(release) {
    const row = rowRef.current
    if (!mounted.current || cancelled.current || row?.contains(release?.target) || row?.contains(document.activeElement)) return
    commit({ leave: true })
  }

  function handleBlur(e) {
    if (cancelled.current || rowRef.current?.contains(e.relatedTarget)) return
    if (busyRef.current) {
      leftWhileBusy.current = press.current.clicking ? 'click' : 'key'
      return
    }
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
              // Editable while it saves, as the panel's subtask box is (a second Enter waits for
              // the first): on Android a focused box turning read-only puts the keyboard away.
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

import { useEffect, useId, useRef, useState } from 'react'
import { Clock } from 'lucide-react'
import MonthCalendar from './MonthCalendar'
import { RepeatPicker, useRecurrencePreview } from './RepeatBuilder'
import { followDate } from './recurrenceRules'
import { getDueBounds, localIso, addDays, dueDateOnly, dueTimeOnly, joinDue } from './dueDates'

// The next Monday as a local YYYY-MM-DD, never today.
export function nextMondayIso(now = new Date()) {
  const days = ((1 - now.getDay() + 7) % 7) || 7
  return localIso(addDays(now, days))
}

// "When is it due?", shown once a new task's title is in (InlineTaskInput.jsx on a desktop, the
// sheet's date step in NewTaskSheet.jsx on a phone), laid out as Asana's date picker is: the month,
// then Repeats under it, with the next dates of the repeat tinted on the month. Picking a quick date
// or a day only selects it, so a repeat can still be set after the date; the submit button
// (`submitLabel`, Add task by default) calls `onPick` with the date, or null for No date. A second
// pick of the selected day submits too, so Enter in the title and Enter again keeps the date a row
// already had. `dueAt` is the date selected first, which the calendar opens on and focuses.
//
// The date, time, and repeat are one draft, handed to `onPick` together as the second argument
// ({ recurrence, customRepeat }), so Esc or Back, which unmount the panel, leave the caller's repeat
// as it was. `recurrence` and `customRepeat` are where the draft starts: the caller keeps what the
// last pick handed back and passes it in again when the panel reopens.
//
// A plain repeat follows the date (followDate in recurrenceRules.js): Weekly chosen on a Tuesday is
// Weekly on Thursday once Thursday is picked. One made in Custom keeps the days it names
// (`customRepeat` says Custom was chosen, which a plain-looking rule cannot say for itself).
//
// A time is optional: Add time opens a time box, and the submit carries it ('YYYY-MM-DDTHH:MM', floating local time). Enter in the time box submits, on
// the selected date or today when there is none. Remove time drops it again. `dueAt` may already
// carry a time (the sheet's date step reopened), which the box then starts on.
//
// Leaving the panel any way but Esc or the submit (a click outside the popover, the sheet's Back)
// keeps the picks, as leaving a picker does (CONTRIBUTING.md, "Leaving an edit"): `onLeave` gets
// the same arguments as `onPick` as the panel unmounts, and the caller keeps them without adding
// anything. Esc leaves the picks unsaved and calls nothing. A half-typed time is not taken; the
// last whole one stays.
export default function AddDuePanel({ dueAt, onPick, onLeave, recurrence: recurrenceStart = '', customRepeat: customStart = false, api, headingId, submitLabel = 'Add task' }) {
  const uid = useId()
  const bounds = getDueBounds()
  const [day, setDay] = useState(() => dueDateOnly(dueAt))
  const [time, setTime] = useState(() => dueTimeOnly(dueAt) || '')
  const [showTime, setShowTime] = useState(() => Boolean(dueTimeOnly(dueAt)))
  const [recurrence, setRecurrence] = useState(recurrenceStart || '')
  const [customRepeat, setCustomRepeat] = useState(customStart)
  const timeRef = useRef(null)
  const addTimeRef = useRef(null)
  const focusTimeRef = useRef(null)
  const rootRef = useRef(null)
  const footRef = useRef(null)
  const marks = useRecurrencePreview(api, recurrence, day || undefined)
  useEffect(() => {
    if (!focusTimeRef.current) return
    ;(showTime ? timeRef : addTimeRef).current?.focus()
    focusTimeRef.current = null
  }, [showTime])

  // The foot is sticky at the bottom of whatever scrolls (the popover, the sheet), so a control
  // scrolled into view by focus or the arrow keys would stop under it when the room is short. The
  // controls above it keep its height, and 4px for an outward focus ring, as scroll-margin
  // (`--add-due-foot`, .add-due in index.css); the foot's own controls are always in sight, so
  // focusing one scrolls nothing. jsdom has no ResizeObserver.
  useEffect(() => {
    const root = rootRef.current
    const foot = footRef.current
    if (!root || !foot || typeof ResizeObserver === 'undefined') return undefined
    const fit = () => root.style.setProperty('--add-due-foot', `${foot.offsetHeight + 4}px`)
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(foot)
    return () => observer.disconnect()
  }, [])

  // Set by Esc and by a submit, so the unmount that follows hands nothing to `onLeave`. The latest
  // picks are read through draftRef, since the cleanup below runs once, on unmount.
  const closedRef = useRef(false)
  const draftRef = useRef(null)
  const onLeaveRef = useRef(onLeave)
  onLeaveRef.current = onLeave
  draftRef.current = { day, time, recurrence, customRepeat }
  useEffect(() => {
    closedRef.current = false
    function onKeyDown(e) { if (e.key === 'Escape') closedRef.current = true }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      if (closedRef.current || !onLeaveRef.current) return
      const d = draftRef.current
      // A time with no day counts from today, as a time typed in the due date picker does.
      const date = d.day || (d.time ? bounds.today : null)
      onLeaveRef.current(date ? joinDue(date, d.time) : null, { recurrence: d.recurrence, customRepeat: d.customRepeat })
    }
    // Mount and unmount only: the draft is read through draftRef.
  }, [])

  const submit = (date) => {
    closedRef.current = true
    onPick(date ? joinDue(date, time) : null, { recurrence, customRepeat })
  }
  function select(date) {
    if (recurrence && !customRepeat && date && date !== day) setRecurrence(followDate(recurrence, day || bounds.today, date))
    setDay(date)
  }
  function toggleTime(next) {
    focusTimeRef.current = true
    if (!next) setTime('')
    setShowTime(next)
  }
  const chips = [
    { key: 'today', label: 'Today', value: bounds.today },
    { key: 'tomorrow', label: 'Tomorrow', value: bounds.tomorrow },
    { key: 'monday', label: 'Next Monday', value: nextMondayIso() },
    { key: 'none', label: 'No date', value: null },
  ]
  return (
    <div ref={rootRef} className="add-due">
      <h3 id={headingId} className="add-due-title">When is it due?</h3>
      <div className="sheet-chips add-due-chips" role="group" aria-label="Quick dates">
        {chips.map((chip) => (
          <button key={chip.key} type="button" className="sheet-chip" aria-pressed={day === chip.value} onClick={() => select(chip.value)}>
            {chip.label}
          </button>
        ))}
      </div>
      <MonthCalendar value={day} today={bounds.today} marks={recurrence ? marks || [] : []} onPick={(date) => (date === day ? submit(date) : select(date))} />
      <div className="field add-due-repeat">
        <RepeatPicker id={`${uid}-repeat`} value={recurrence} onChange={setRecurrence} dueIso={day || undefined} api={api} preview={marks} initialCustom={customStart} onCustomChange={setCustomRepeat} />
      </div>
      <div ref={footRef} className="add-due-foot">
        <div className="add-due-time">
          {showTime ? (
            <>
              <label className="add-due-time-field">
                <span>Time</span>
                <input
                  ref={timeRef}
                  type="time"
                  value={time}
                  // A half-typed time reads '' in Chromium (validity.badInput): keep the last whole
                  // one rather than dropping the time from the submit.
                  onChange={(e) => { if (e.target.value || !e.target.validity?.badInput) setTime(e.target.value) }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    e.preventDefault()
                    submit(day || bounds.today)
                  }}
                />
              </label>
              <button type="button" className="btn" onClick={() => toggleTime(false)}>Remove time</button>
            </>
          ) : (
            <button type="button" ref={addTimeRef} className="btn" onClick={() => toggleTime(true)}>
              <Clock size={16} aria-hidden="true" />
              Add time
            </button>
          )}
        </div>
        <button type="button" className="btn btn-primary add-due-submit" onClick={() => submit(day)}>{submitLabel}</button>
      </div>
    </div>
  )
}

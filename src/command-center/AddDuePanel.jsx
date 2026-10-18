import { useEffect, useId, useRef, useState } from 'react'
import { Clock } from 'lucide-react'
import MonthCalendar from './MonthCalendar'
import { RepeatSelect } from './RepeatBuilder'
import { getDueBounds, localIso, addDays, dueDateOnly, dueTimeOnly, joinDue } from './dueDates'

// The next Monday as a local YYYY-MM-DD, never today.
export function nextMondayIso(now = new Date()) {
  const days = ((1 - now.getDay() + 7) % 7) || 7
  return localIso(addDays(now, days))
}

// "When is it due?", shown once a new task's title is in (InlineTaskInput.jsx on a desktop, the
// sheet's date step in NewTaskSheet.jsx on a phone). Repeat comes first, because one tap on a quick
// pick or a day of the month is the whole choice: it calls `onPick` with the date (or null for No
// date) and the caller adds the task or goes back to its form. `dueAt` is the date picked so far,
// which the calendar opens on and focuses, so Enter twice keeps the date a row already had.
//
// A time is optional and comes before the day is picked: Add time, under the calendar, opens a time
// box, and the pick that follows carries it ('YYYY-MM-DDTHH:MM', floating local time). Enter in the
// time box keeps the date picked so far, or today when there is none. Remove time drops it again.
// `dueAt` may already carry a time (the sheet's date step reopened), which the box then starts on.
export default function AddDuePanel({ dueAt, onPick, recurrence, onRecurrenceChange, api, headingId }) {
  const uid = useId()
  const bounds = getDueBounds()
  const dueDay = dueDateOnly(dueAt)
  const [time, setTime] = useState(() => dueTimeOnly(dueAt) || '')
  const [showTime, setShowTime] = useState(() => Boolean(dueTimeOnly(dueAt)))
  const timeRef = useRef(null)
  const addTimeRef = useRef(null)
  const focusTimeRef = useRef(null)
  useEffect(() => {
    if (!focusTimeRef.current) return
    ;(showTime ? timeRef : addTimeRef).current?.focus()
    focusTimeRef.current = null
  }, [showTime])

  const pick = (date) => onPick(date ? joinDue(date, time) : null)
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
    <div className="add-due">
      <h3 id={headingId} className="add-due-title">When is it due?</h3>
      <div className="field">
        <label htmlFor={`${uid}-repeat`}>Repeat</label>
        <RepeatSelect id={`${uid}-repeat`} value={recurrence} onChange={onRecurrenceChange} dueIso={dueAt} api={api} />
      </div>
      <div className="sheet-chips" role="group" aria-label="Quick dates">
        {chips.map((chip) => (
          <button key={chip.key} type="button" className="sheet-chip" aria-pressed={dueDay === chip.value} onClick={() => pick(chip.value)}>
            {chip.label}
          </button>
        ))}
      </div>
      <MonthCalendar value={dueDay} today={bounds.today} onPick={pick} />
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
                // one rather than dropping the time from the next pick.
                onChange={(e) => { if (e.target.value || !e.target.validity?.badInput) setTime(e.target.value) }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  e.preventDefault()
                  pick(dueDay || bounds.today)
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
    </div>
  )
}

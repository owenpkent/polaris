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
// A plain repeat follows the date (followDate in recurrenceRules.js): Weekly chosen on a Tuesday is
// Weekly on Thursday once Thursday is picked. One made in Custom keeps the days it names
// (`customRepeat` says Custom was already chosen, and `onCustomRepeatChange` hears a change).
//
// A time is optional: Add time opens a time box, and the submit carries it ('YYYY-MM-DDTHH:MM', floating local time). Enter in the time box submits, on
// the selected date or today when there is none. Remove time drops it again. `dueAt` may already
// carry a time (the sheet's date step reopened), which the box then starts on.
export default function AddDuePanel({ dueAt, onPick, recurrence, onRecurrenceChange, api, headingId, submitLabel = 'Add task', customRepeat: customStart = false, onCustomRepeatChange }) {
  const uid = useId()
  const bounds = getDueBounds()
  const [day, setDay] = useState(() => dueDateOnly(dueAt))
  const [time, setTime] = useState(() => dueTimeOnly(dueAt) || '')
  const [showTime, setShowTime] = useState(() => Boolean(dueTimeOnly(dueAt)))
  const [customRepeat, setOwnCustomRepeat] = useState(customStart)
  const setCustomRepeat = (next) => { setOwnCustomRepeat(next); onCustomRepeatChange?.(next) }
  const timeRef = useRef(null)
  const addTimeRef = useRef(null)
  const focusTimeRef = useRef(null)
  const marks = useRecurrencePreview(api, recurrence, day || undefined)
  useEffect(() => {
    if (!focusTimeRef.current) return
    ;(showTime ? timeRef : addTimeRef).current?.focus()
    focusTimeRef.current = null
  }, [showTime])

  const submit = (date) => onPick(date ? joinDue(date, time) : null)
  function select(date) {
    if (recurrence && !customRepeat && date && date !== day) onRecurrenceChange(followDate(recurrence, day || bounds.today, date))
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
    <div className="add-due">
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
        <RepeatPicker id={`${uid}-repeat`} value={recurrence} onChange={onRecurrenceChange} dueIso={day || undefined} api={api} preview={marks} initialCustom={customStart} onCustomChange={setCustomRepeat} />
      </div>
      <div className="add-due-foot">
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

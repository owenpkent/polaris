import { useId } from 'react'
import MonthCalendar from './MonthCalendar'
import { RepeatSelect } from './RepeatBuilder'
import { getDueBounds, localIso, addDays } from './dueDates'

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
export default function AddDuePanel({ dueAt, onPick, recurrence, onRecurrenceChange, api, headingId }) {
  const uid = useId()
  const bounds = getDueBounds()
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
          <button key={chip.key} type="button" className="sheet-chip" aria-pressed={dueAt === chip.value} onClick={() => onPick(chip.value)}>
            {chip.label}
          </button>
        ))}
      </div>
      <MonthCalendar value={dueAt} today={bounds.today} onPick={onPick} />
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { Clock } from 'lucide-react'
import { Popover } from './Menu'
import MonthCalendar from './MonthCalendar'
import { nextMondayIso } from './AddDuePanel'
import { dueDateOnly, dueTimeOnly, joinDue } from './dueDates'

// The popover's width on a phone (.due-pop in index.css) with its 1px borders. Below that plus
// two 8px gutters the gutters shrink, down to none at 320px, where the window is exactly as wide
// as the month and the popover's sides.
const POP_OUTER_WIDTH = 334
function popGutter() {
  if (typeof window === 'undefined') return 8
  return Math.max(0, Math.min(8, Math.floor((window.innerWidth - POP_OUTER_WIDTH) / 2)))
}

// The due-date picker shared by a list row's Due date cell (TaskRow.jsx) and the task panel's
// Due date field (TaskDetailPanel.jsx). It opens straight onto the month, with focus on the task's
// day (or today): one tap or Enter on a day, or a quick date (Today, Tomorrow, Next Monday), saves
// and closes, and No date removes the date. `value` is the task's dueAt (a day, or a day and a
// time, or null); `onChange` gets the new dueAt ('YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM', floating local
// time), or null for No date. Nothing is saved when the pick is what the task already has.
//
// A time is optional: Add time opens a time box (shown filled when the task has a time). A new day
// keeps the time in the box, the task's or one just typed; Enter in the box saves it on the task's
// day, or today when there is none. Remove time on a task with a time saves the day alone.
export default function DueDateMenu({ anchorRef, open, onClose, value, dueBounds, onChange, label }) {
  return (
    <Popover anchorRef={anchorRef} open={open} onClose={onClose} minWidth={200} maxWidth={540} gutter={popGutter()} focusSelector="[data-cal-focus]" preferFit>
      <DuePicker anchorRef={anchorRef} onClose={onClose} value={value} dueBounds={dueBounds} onChange={onChange} label={label} />
    </Popover>
  )
}

// Mounted each time the popover opens, so a time typed and not saved is gone the next time.
function DuePicker({ anchorRef, onClose, value, dueBounds, onChange, label }) {
  const day = dueDateOnly(value)
  const taskTime = dueTimeOnly(value) || ''
  const [time, setTime] = useState(taskTime)
  const [showTime, setShowTime] = useState(Boolean(taskTime))
  // Chromium reports '' for a time box with a segment cleared (validity.badInput), the same as an
  // empty one. While the box holds such a half-typed time, Enter saves nothing and the time kept
  // for a new day stays the last whole one, so a half-typed time never reads as "no time".
  const [timePartial, setTimePartial] = useState(false)
  const timeRef = useRef(null)
  const addTimeRef = useRef(null)
  const focusTimeRef = useRef(false)
  useEffect(() => {
    if (!focusTimeRef.current) return
    focusTimeRef.current = false
    ;(showTime ? timeRef : addTimeRef).current?.focus()
  }, [showTime])

  function commit(next) {
    onClose()
    anchorRef.current?.focus()
    if (next !== (value || null)) onChange(next)
  }

  const pick = (date) => commit(joinDue(date, time))

  function changeTime(e) {
    const next = e.target.value
    if (!next && e.target.validity?.badInput) {
      setTimePartial(true)
      return
    }
    setTimePartial(false)
    setTime(next)
  }

  function onTimeKeyDown(e) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    if (timePartial) return
    pick(day || dueBounds.today)
  }

  function addTime() {
    focusTimeRef.current = true
    setShowTime(true)
  }

  function removeTime() {
    if (taskTime) {
      commit(day)
      return
    }
    focusTimeRef.current = true
    setTime('')
    setTimePartial(false)
    setShowTime(false)
  }

  const chips = [
    { key: 'today', label: 'Today', value: dueBounds.today },
    { key: 'tomorrow', label: 'Tomorrow', value: dueBounds.tomorrow },
    { key: 'monday', label: 'Next Monday', value: nextMondayIso() },
    { key: 'none', label: 'No date', value: null },
  ]

  return (
    <div role="dialog" aria-label={label} className="due-pop">
      <div className="sheet-chips" role="group" aria-label="Quick dates">
        {chips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            className="sheet-chip"
            aria-pressed={day === chip.value}
            onClick={() => (chip.value ? pick(chip.value) : commit(null))}
          >
            {chip.label}
          </button>
        ))}
      </div>
      <MonthCalendar value={day} today={dueBounds.today} onPick={pick} />
      <div className="due-pop-time">
        {showTime ? (
          <>
            <label className="due-pop-time-field">
              <span>Time</span>
              <input ref={timeRef} type="time" value={time} onChange={changeTime} onKeyDown={onTimeKeyDown} />
            </label>
            <button type="button" className="btn" onClick={removeTime}>Remove time</button>
          </>
        ) : (
          <button type="button" ref={addTimeRef} className="btn" onClick={addTime}>
            <Clock size={16} aria-hidden="true" />
            Add time
          </button>
        )}
      </div>
    </div>
  )
}

import { useEffect, useId, useRef, useState } from 'react'
import { Clock, Repeat } from 'lucide-react'
import { Popover } from './Menu'
import MonthCalendar from './MonthCalendar'
import { nextMondayIso } from './AddDuePanel'
import { RepeatPicker, useRecurrencePreview } from './RepeatBuilder'
import { followDate, parseRule } from './recurrenceRules'
import { dueDateOnly, dueTimeOnly, joinDue, repeatLabel } from './dueDates'

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
//
// With `onRecurrenceChange`, a Repeat button sits under the month, off by default as Add time is.
// It opens Repeats (RepeatPicker in RepeatBuilder.jsx, as Asana has it) on Does not repeat, so
// opening it saves nothing, and the next dates of the repeat are tinted on the month. A task that
// already repeats opens with it shown. `recurrence` is the task's rule (null for none). Remove
// repeat saves null and closes it again. A choice there saves at once: `onRecurrenceChange` gets the rule (null for
// Does not repeat) and, on a task with no date, today as its dueAt too, since a repeat counts from
// the due date. The picker stays open, so Custom's builder can be tapped through, each change saved
// as it is made. A plain repeat chosen while the picker is open follows a day picked after it
// (followDate in recurrenceRules.js): `onChange` then gets the moved rule as its second argument.
// The rule a task already has keeps its days when a day is picked, since its text cannot say
// whether it was made in Custom: moving one occurrence leaves the schedule alone. A rule the
// builder cannot show (a raw RRULE with BYMONTH, say) is named and left to the task panel's
// Recurrence box.
export default function DueDateMenu({ anchorRef, open, onClose, value, dueBounds, onChange, label, recurrence = null, onRecurrenceChange, api }) {
  return (
    <Popover anchorRef={anchorRef} open={open} onClose={onClose} minWidth={200} maxWidth={540} gutter={popGutter()} focusSelector="[data-cal-focus]" preferFit>
      <DuePicker
        anchorRef={anchorRef}
        onClose={onClose}
        value={value}
        dueBounds={dueBounds}
        onChange={onChange}
        label={label}
        recurrence={recurrence}
        onRecurrenceChange={onRecurrenceChange}
        api={api}
      />
    </Popover>
  )
}

// Mounted each time the popover opens, so a time typed and not saved is gone the next time.
function DuePicker({ anchorRef, onClose, value, dueBounds, onChange, label, recurrence, onRecurrenceChange, api }) {
  const uid = useId()
  // The day and the rule are kept here as well as on the task: a repeat chosen on a task with no
  // date gives it today at once, and the picker shows that before the task is loaded again.
  const [day, setDay] = useState(() => dueDateOnly(value))
  const [rule, setRule] = useState(recurrence || '')
  // Whether the rule is a plain choice made in Repeats since the picker opened, the only kind that
  // follows a new day. A rule loaded with the task may have been made in Custom, here or in the
  // panel, and reads the same as a plain one, so it is never taken for one (review on #77).
  const [followsDay, setFollowsDay] = useState(false)
  // Off until turned on, as Add time is; a task that already repeats opens with it on.
  const [showRepeat, setShowRepeat] = useState(Boolean(recurrence))
  const repeatRef = useRef(null)
  const addRepeatRef = useRef(null)
  const focusRepeatRef = useRef(false)
  useEffect(() => {
    if (!focusRepeatRef.current) return
    focusRepeatRef.current = false
    if (showRepeat) repeatRef.current?.querySelector('select')?.focus()
    else addRepeatRef.current?.focus()
  }, [showRepeat])
  const savedDue = useRef(value || null)
  const marks = useRecurrencePreview(onRecurrenceChange && showRepeat ? api : null, rule || null, day || undefined)
  const repeatFrom = day || dueBounds.today
  const unreadable = Boolean(rule) && !parseRule(rule, repeatFrom)
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

  function commit(next, nextRule) {
    onClose()
    anchorRef.current?.focus()
    if (nextRule !== undefined) onChange(next, nextRule)
    else if (next !== savedDue.current) onChange(next)
  }

  // A new day moves a plain repeat chosen in this opening along with it; one made in Custom, or
  // the one the task already had, keeps the days it names. A bare alias (daily, weekly, ...) names
  // no day, so it follows the due date on its own.
  function pick(date) {
    const named = rule.includes('=')
    const moved = named && followsDay && !unreadable ? followDate(rule, repeatFrom, date) : rule
    commit(joinDue(date, time), moved !== rule ? moved || null : undefined)
  }

  function changeRule(next) {
    setRule(next)
    if (next && !day) {
      const due = joinDue(dueBounds.today, time)
      setDay(dueBounds.today)
      savedDue.current = due
      onRecurrenceChange(next, due)
      return
    }
    onRecurrenceChange(next || null)
  }

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

  // Repeat opens Repeats on Does not repeat, so opening it saves nothing; the choice made there is
  // saved. Remove repeat saves no repeat when there was one, and closes it again.
  function addRepeat() {
    focusRepeatRef.current = true
    setShowRepeat(true)
  }

  function removeRepeat() {
    focusRepeatRef.current = true
    setShowRepeat(false)
    setFollowsDay(false)
    if (rule) {
      setRule('')
      onRecurrenceChange(null)
    }
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
      <MonthCalendar value={day} today={dueBounds.today} marks={showRepeat && rule && marks ? marks : []} onPick={pick} />
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
      {/* Last, so Custom's builder grows at the end of the picker. */}
      {onRecurrenceChange && (
        unreadable ? (
          <p className="due-pop-repeat repeat-note">{`Repeats ${repeatLabel(rule)}. Change it under More details in the task panel.`}</p>
        ) : showRepeat ? (
          <div ref={repeatRef} className="field due-pop-repeat">
            <RepeatPicker id={`${uid}-repeat`} value={rule} onChange={changeRule} dueIso={repeatFrom} api={api} preview={marks} onCustomChange={(custom) => setFollowsDay(!custom)} onRemove={removeRepeat} />
          </div>
        ) : (
          <div className="due-pop-repeat">
            <button type="button" ref={addRepeatRef} className="btn" onClick={addRepeat}>
              <Repeat size={16} aria-hidden="true" />
              Repeat
            </button>
          </div>
        )
      )}
    </div>
  )
}

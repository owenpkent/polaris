import { useEffect, useId, useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import {
  WEEKDAYS, WEEKDAY_NAMES, NTH_NAMES, MAX_INTERVAL, UNITS,
  buildRule, defaultShape, parseRule,
} from './recurrenceRules'

const UNIT_WORDS = { day: ['day', 'days'], week: ['week', 'weeks'], month: ['month', 'months'], year: ['year', 'years'] }
const DAY_OPTIONS = [...Array.from({ length: 31 }, (_, i) => i + 1), -1]

function formatShort(iso) {
  const d = new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)))
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

// The next few dates a rule gives, asked of the server so the words and the dates can never
// disagree with what completing the task will do. Nothing is shown while offline or on an error.
export function useRecurrencePreview(api, rule, from, count = 3) {
  const [dates, setDates] = useState(null)
  useEffect(() => {
    if (!api?.previewRecurrence || !rule) { setDates(null); return undefined }
    let live = true
    const id = setTimeout(() => {
      api.previewRecurrence(rule, from || undefined, count)
        .then((res) => { if (live) setDates(Array.isArray(res?.dates) ? res.dates : null) })
        .catch(() => { if (live) setDates(null) })
    }, 150)
    return () => { live = false; clearTimeout(id) }
  }, [api, rule, from, count])
  return dates
}

export function previewText(dates) {
  if (!dates) return null
  if (dates.length === 0) return 'No later dates: this is the last one.'
  return `Next: ${dates.map(formatShort).join('; ')}`
}

// Builds a repeat rule by tapping, with nothing to type: every N days, weeks, months, or years;
// which weekdays for a weekly rule; and a day of the month or "the second Tuesday" for a monthly
// one. `value` is the rule string and `onChange` gets the new one (recurrenceRules.js picks the
// shortest form the server accepts). `dueIso` is the task's due date, which the rule starts from.
// With `api`, the next three dates are shown under it.
export default function RepeatBuilder({ value, dueIso, onChange, api, disabled = false }) {
  const uid = useId()
  const [shape, setShape] = useState(() => parseRule(value, dueIso) || defaultShape(dueIso))
  const dates = useRecurrencePreview(api, value, dueIso)

  // A rule changed from outside (the task reloaded) is shown; one this builder just wrote is not
  // parsed back, so a half-made choice (no weekday picked yet) is not snapped back.
  useEffect(() => {
    if (value && buildRule(shape, dueIso) !== value) {
      const parsed = parseRule(value, dueIso)
      if (parsed) setShape(parsed)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  function update(patch) {
    const next = { ...shape, ...patch }
    setShape(next)
    onChange(buildRule(next, dueIso))
  }

  const max = MAX_INTERVAL[shape.unit]

  return (
    <div className="repeat-builder">
      <div className="repeat-row">
        <span className="field-label" id={`${uid}-every`}>Every</span>
        <div className="repeat-stepper" role="group" aria-labelledby={`${uid}-every`}>
          <button
            type="button"
            className="icon-btn repeat-step"
            aria-label="Fewer"
            disabled={disabled || shape.interval <= 1}
            onClick={() => update({ interval: shape.interval - 1 })}
          >
            <Minus size={16} aria-hidden="true" />
          </button>
          <span className="repeat-count" aria-live="polite">{shape.interval}</span>
          <button
            type="button"
            className="icon-btn repeat-step"
            aria-label="More"
            disabled={disabled || shape.interval >= max}
            onClick={() => update({ interval: shape.interval + 1 })}
          >
            <Plus size={16} aria-hidden="true" />
          </button>
        </div>
        <select
          aria-label="Repeat unit"
          value={shape.unit}
          disabled={disabled}
          onChange={(e) => {
            const unit = e.target.value
            update({ unit, interval: Math.min(shape.interval, MAX_INTERVAL[unit]) })
          }}
        >
          {UNITS.map((unit) => (
            <option key={unit} value={unit}>{shape.interval === 1 ? UNIT_WORDS[unit][0] : UNIT_WORDS[unit][1]}</option>
          ))}
        </select>
      </div>

      {shape.unit === 'week' && (
        <div className="repeat-row">
          <span className="field-label" id={`${uid}-on`}>On</span>
          <div className="repeat-days" role="group" aria-labelledby={`${uid}-on`}>
            {WEEKDAYS.map((day) => {
              const on = shape.weekdays.includes(day)
              return (
                <button
                  key={day}
                  type="button"
                  className="sheet-chip repeat-day"
                  aria-pressed={on}
                  aria-label={WEEKDAY_NAMES[day]}
                  // The last day picked stays: a weekly rule on no day is the due date's own day,
                  // and a button that silently means something else would mislead.
                  disabled={disabled || (on && shape.weekdays.length === 1)}
                  onClick={() => update({ weekdays: on ? shape.weekdays.filter((d) => d !== day) : [...shape.weekdays, day] })}
                >
                  {WEEKDAY_NAMES[day].slice(0, 2)}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {shape.unit === 'month' && (
        <fieldset className="repeat-month">
          <legend className="field-label">On</legend>
          <label className="repeat-choice">
            <input type="radio" name={`${uid}-month`} checked={shape.monthMode === 'day'} disabled={disabled} onChange={() => update({ monthMode: 'day' })} />
            <span>Day</span>
            <select
              aria-label="Day of the month"
              value={shape.monthDay}
              disabled={disabled}
              onChange={(e) => update({ monthMode: 'day', monthDay: Number(e.target.value) })}
            >
              {DAY_OPTIONS.map((n) => <option key={n} value={n}>{n === -1 ? 'Last day' : n}</option>)}
            </select>
          </label>
          <label className="repeat-choice">
            <input type="radio" name={`${uid}-month`} checked={shape.monthMode === 'weekday'} disabled={disabled} onChange={() => update({ monthMode: 'weekday' })} />
            <span>The</span>
            <select
              aria-label="Which week of the month"
              value={shape.nth}
              disabled={disabled}
              onChange={(e) => update({ monthMode: 'weekday', nth: Number(e.target.value) })}
            >
              {[1, 2, 3, 4, -1].map((n) => <option key={n} value={n}>{NTH_NAMES[n]}</option>)}
            </select>
            <select
              aria-label="Weekday"
              value={shape.nthWeekday}
              disabled={disabled}
              onChange={(e) => update({ monthMode: 'weekday', nthWeekday: e.target.value })}
            >
              {WEEKDAYS.map((d) => <option key={d} value={d}>{WEEKDAY_NAMES[d]}</option>)}
            </select>
          </label>
        </fieldset>
      )}

      {shape.unit === 'year' && <p className="field-label">On the due date's day and month.</p>}

      {previewText(dates) && <p className="repeat-preview" role="status">{previewText(dates)}</p>}
    </div>
  )
}

const PRESETS = [
  ['', 'Never'],
  ['daily', 'Daily'],
  ['weekdays', 'Weekdays'],
  ['weekly', 'Weekly'],
  ['monthly', 'Monthly'],
  ['yearly', 'Yearly'],
]

// A Repeat choice for a task being added: the common rules in one list, and Custom, which opens
// the builder under it. `value` is the rule ('' for none) and `onChange` gets the new one.
export function RepeatSelect({ value, onChange, dueIso, api, disabled = false, id }) {
  const current = String(value || '').trim().toLowerCase()
  const preset = PRESETS.some(([option]) => option === current)
  const [custom, setCustom] = useState(!preset)
  const showBuilder = custom || !preset
  return (
    <>
      <select
        id={id}
        value={showBuilder ? 'custom' : current}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.value
          if (next === 'custom') {
            setCustom(true)
            onChange(current || buildRule(defaultShape(dueIso), dueIso))
          } else {
            setCustom(false)
            onChange(next)
          }
        }}
      >
        {PRESETS.map(([option, text]) => <option key={option || 'never'} value={option}>{text}</option>)}
        <option value="custom">Custom</option>
      </select>
      {showBuilder && <RepeatBuilder value={value} dueIso={dueIso} onChange={onChange} api={api} disabled={disabled} />}
    </>
  )
}

import { useEffect, useId, useState } from 'react'
import { Minus, Plus, X } from 'lucide-react'
import { useOffline } from './offlineStatus'
import {
  WEEKDAYS, WEEKDAY_NAMES, NTH_NAMES, MAX_INTERVAL, MAX_COUNT, UNITS,
  buildRule, defaultShape, parseRule, frequencyOf, frequencyRule,
} from './recurrenceRules'

const UNIT_WORDS = { day: ['day', 'days'], week: ['week', 'weeks'], month: ['month', 'months'], year: ['year', 'years'] }
const DAY_OPTIONS = [...Array.from({ length: 31 }, (_, i) => i + 1), -1]

function formatShort(iso) {
  const d = new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)))
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

// The next few dates a rule gives, asked of the server so the words and the dates can never
// disagree with what completing the task will do. Nothing is shown while offline or on an error,
// and the request goes again when the connection comes back, so a panel opened offline fills in
// its Next line and Skip without being reopened.
export function useRecurrencePreview(api, rule, from, count = 3) {
  const [dates, setDates] = useState(null)
  const offline = useOffline()
  useEffect(() => {
    if (!api?.previewRecurrence || !rule) { setDates(null); return undefined }
    let live = true
    const id = setTimeout(() => {
      api.previewRecurrence(rule, from || undefined, count)
        .then((res) => { if (live) setDates(Array.isArray(res?.dates) ? res.dates : null) })
        .catch(() => { if (live) setDates(null) })
    }, 150)
    return () => { live = false; clearTimeout(id) }
  }, [api, rule, from, count, offline])
  return dates
}

// The preview line. A rule counted from the finish has no fixed next dates, so its preview says
// what they would be if each one were finished on the day it is due.
export function previewText(dates, fromCompletion = false) {
  if (!dates) return null
  if (dates.length === 0) return 'No later dates: this is the last one.'
  return `${fromCompletion ? 'If each is finished on its due date, next: ' : 'Next: '}${dates.map(formatShort).join('; ')}`
}

// Builds a repeat rule by tapping, with nothing to type: every N days, weeks, months, or years;
// whether the next one counts from the due date or from the day the task is finished; which
// weekdays for a weekly rule; a day of the month (or the last day) or "the second Tuesday" (or the
// last one) for a monthly one; and when it ends: never, on a date, or after a number of times.
// `value` is the rule string and `onChange` gets the new one (recurrenceRules.js picks the
// shortest form the server accepts). `dueIso` is the task's due date, which the rule starts from.
// With `api`, the next three dates are shown under it; `preview` hands in dates already fetched
// (the add-task picker marks them on its calendar too) so they are not asked for twice. The line
// holds its place from the start (empty until the dates come, or for good when they cannot), so
// their arrival never grows the builder: a due date popover that opens upward from a row low on
// the screen is anchored at its bottom, and growth would move every control above the line,
// quick dates and month included, from under the owner's pointer.
//
// `compact` is the add-task picker's form (RepeatPicker below): the unit is the Repeats choice
// above it, so it shows as words, and the from-the-finish and Ends choices are left to Custom. A
// rule counted from the finish (Periodically) keeps its unit box, since that choice has no unit.
export default function RepeatBuilder({ value, dueIso, onChange, api, disabled = false, compact = false, preview }) {
  const uid = useId()
  const [shape, setShape] = useState(() => parseRule(value, dueIso) || defaultShape(dueIso))
  const fetched = useRecurrencePreview(preview === undefined ? api : null, value, dueIso)
  const dates = preview === undefined ? fetched : preview

  // A rule changed from outside (the task reloaded) is shown; one this builder just wrote is not
  // parsed back, so a half-made choice (no weekday picked yet) is not snapped back.
  useEffect(() => {
    if (value && buildRule(shape) !== value) {
      const parsed = parseRule(value, dueIso)
      if (parsed) setShape(parsed)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  function update(patch) {
    const next = { ...shape, ...patch }
    setShape(next)
    onChange(buildRule(next))
  }

  const max = MAX_INTERVAL[shape.unit]
  const unitWord = shape.interval === 1 ? `a ${UNIT_WORDS[shape.unit][0]}` : `${shape.interval} ${UNIT_WORDS[shape.unit][1]}`
  // 1 to MAX_COUNT, and a count an agent wrote past that as one more option, never a list that long.
  const countOptions = Array.from({ length: MAX_COUNT }, (_, i) => i + 1)
  if (!countOptions.includes(shape.count)) countOptions.push(shape.count)

  // Laid out as Asana lays its repeat out under the month: each row a label on the left and its
  // controls beside it, wrapping under the label only where the two do not fit. A plain choice
  // (compact) has no Every row: its interval is one, and a rule with more is Custom.
  return (
    <div className="repeat-builder">
      {(!compact || shape.fromCompletion) && (
      <div className="repeat-row">
        <span className="field-label repeat-label" id={`${uid}-every`}>Every</span>
        <div className="repeat-controls">
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
        {compact && !shape.fromCompletion ? (
          <span className="repeat-unit">{shape.interval === 1 ? UNIT_WORDS[shape.unit][0] : UNIT_WORDS[shape.unit][1]}</span>
        ) : (
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
        )}
        </div>
      </div>
      )}

      {!compact && (
      <fieldset className="repeat-row repeat-set">
        <legend className="field-label repeat-label">Counts from</legend>
        <div className="repeat-controls">
          <label className="repeat-choice">
            <input type="radio" name={`${uid}-from`} checked={!shape.fromCompletion} disabled={disabled} onChange={() => update({ fromCompletion: false })} />
            <span>The due date</span>
          </label>
          <label className="repeat-choice">
            <input type="radio" name={`${uid}-from`} checked={shape.fromCompletion} disabled={disabled} onChange={() => update({ fromCompletion: true })} />
            <span>The day I finish it</span>
          </label>
        </div>
      </fieldset>
      )}

      {shape.fromCompletion && (
        <p className="repeat-note">{`Each one is due ${unitWord} after the day you finish the one before.`}</p>
      )}

      {!shape.fromCompletion && shape.unit === 'week' && (
        <div className="repeat-row">
          <span className="field-label repeat-label" id={`${uid}-on`}>On</span>
          {/* Seven touching days, lettered as the month's columns are, so the row is the month's width. */}
          <div className="repeat-days" role="group" aria-labelledby={`${uid}-on`}>
            {WEEKDAYS.map((day) => {
              const on = shape.weekdays.includes(day)
              return (
                <button
                  key={day}
                  type="button"
                  className="repeat-day"
                  aria-pressed={on}
                  aria-label={WEEKDAY_NAMES[day]}
                  // The last day picked stays: a weekly rule on no day is the due date's own day,
                  // and a button that silently means something else would mislead.
                  disabled={disabled || (on && shape.weekdays.length === 1)}
                  onClick={() => update({ weekdays: on ? shape.weekdays.filter((d) => d !== day) : [...shape.weekdays, day] })}
                >
                  {WEEKDAY_NAMES[day].slice(0, 1)}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {!shape.fromCompletion && shape.unit === 'month' && (
        <fieldset className="repeat-row repeat-set">
          <legend className="field-label repeat-label">On</legend>
          <div className="repeat-controls repeat-stack">
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
          </div>
        </fieldset>
      )}

      {!shape.fromCompletion && shape.unit === 'year' && (
        <p className="repeat-note">{shape.yearLastFeb ? 'On the last day of February.' : "On the due date's day and month."}</p>
      )}

      {!compact && (
      <fieldset className="repeat-row repeat-set">
        <legend className="field-label repeat-label">Ends</legend>
        <div className="repeat-controls">
        <label className="repeat-choice">
          <input type="radio" name={`${uid}-ends`} checked={shape.ends === 'never'} disabled={disabled} onChange={() => update({ ends: 'never' })} />
          <span>Never</span>
        </label>
        <label className="repeat-choice">
          <input type="radio" name={`${uid}-ends`} checked={shape.ends === 'on'} disabled={disabled} onChange={() => update({ ends: 'on' })} />
          <span>On</span>
          <input
            type="date"
            aria-label="End date"
            value={shape.until}
            min={dueIso || undefined}
            disabled={disabled}
            // A cleared box keeps the last date: an end with no date would silently mean never.
            onChange={(e) => { if (e.target.value) update({ ends: 'on', until: e.target.value }) }}
          />
        </label>
        <label className="repeat-choice">
          <input type="radio" name={`${uid}-ends`} checked={shape.ends === 'after'} disabled={disabled} onChange={() => update({ ends: 'after' })} />
          <span>After</span>
          <select
            aria-label="Number of times"
            value={shape.count}
            disabled={disabled}
            onChange={(e) => update({ ends: 'after', count: Number(e.target.value) })}
          >
            {countOptions.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <span>{shape.count === 1 ? 'time' : 'times'}</span>
        </label>
        </div>
      </fieldset>
      )}

      {(preview !== undefined || api?.previewRecurrence) && (
        <p className="repeat-preview" role={previewText(dates, shape.fromCompletion) ? 'status' : undefined}>
          {previewText(dates, shape.fromCompletion)}
        </p>
      )}
    </div>
  )
}

const FREQUENCIES = [
  ['none', 'Does not repeat'],
  ['daily', 'Daily'],
  ['weekly', 'Weekly'],
  ['monthly', 'Monthly'],
  ['yearly', 'Yearly'],
  ['periodic', 'Periodically, from when I finish it'],
  ['custom', 'Custom'],
]

// Repeats, for a task being added, as Asana lays it out under its calendar: one choice of how
// often, and under it only what that choice needs (the weekdays of a weekly rule, the day of a
// monthly one, the stepper of Periodically). Custom opens the whole builder, with every N, Ends,
// and the from-the-finish choice. `value` is the rule ('' for none) and `onChange` gets the new one. A
// choice writes its rule in full for the due date (frequencyRule), and the caller moves a plain
// rule along when another date is picked (followDate in recurrenceRules.js), unless it was made
// in Custom: `onCustomChange` tells it whether Custom is chosen, since a Custom rule can read the
// same as a plain one, and `initialCustom` starts it there (the sheet's date step, opened after
// Custom was chosen on its form). `preview` is passed through to the builder. With `onRemove`, a
// Remove repeat button sits beside the choice (the due date picker, where Repeat is turned on).
export function RepeatPicker({ value, onChange, dueIso, api, disabled = false, id, preview, initialCustom = false, onCustomChange, onRemove }) {
  const ownId = useId()
  const selectId = id || ownId
  const [custom, setOwnCustom] = useState(initialCustom)
  const setCustom = (next) => { setOwnCustom(next); onCustomChange?.(next) }
  const frequency = custom && value ? 'custom' : frequencyOf(value, dueIso)
  return (
    <div className="repeat-picker">
      <div className="repeat-row repeat-picker-head">
        <label className="field-label repeat-label" htmlFor={selectId}>Repeats</label>
        <div className="repeat-controls">
        <select
          id={selectId}
          value={frequency}
          disabled={disabled}
          onChange={(e) => {
            const next = e.target.value
            setCustom(next === 'custom')
            if (next === 'custom') onChange(buildRule(parseRule(value, dueIso) || defaultShape(dueIso)))
            else onChange(frequencyRule(next, dueIso))
          }}
        >
          {FREQUENCIES.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
        </select>
        {onRemove && (
          <button type="button" className="icon-btn" aria-label="Remove repeat" title="Remove repeat" disabled={disabled} onClick={onRemove}>
            <X size={16} aria-hidden="true" />
          </button>
        )}
        </div>
      </div>
      {frequency !== 'none' && (
        // Keyed by the choice, so a builder opened for one choice starts from the new rule.
        <RepeatBuilder key={frequency} value={value} dueIso={dueIso} onChange={onChange} api={api} disabled={disabled} compact={frequency !== 'custom'} preview={preview} />
      )}
    </div>
  )
}

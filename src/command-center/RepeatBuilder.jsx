import { useEffect, useId, useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import { useOffline } from './offlineStatus'
import {
  WEEKDAYS, WEEKDAY_NAMES, NTH_NAMES, MAX_INTERVAL, MAX_COUNT, UNITS,
  buildRule, defaultShape, parseRule, quickPicks, matchQuickPick,
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
// With `api`, the next three dates are shown under it.
export default function RepeatBuilder({ value, dueIso, onChange, api, disabled = false }) {
  const uid = useId()
  const [shape, setShape] = useState(() => parseRule(value, dueIso) || defaultShape(dueIso))
  const dates = useRecurrencePreview(api, value, dueIso)

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
  const countOptions = Array.from({ length: Math.max(MAX_COUNT, shape.count) }, (_, i) => i + 1)

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

      <fieldset className="repeat-month">
        <legend className="field-label">Next one counts from</legend>
        <label className="repeat-choice">
          <input type="radio" name={`${uid}-from`} checked={!shape.fromCompletion} disabled={disabled} onChange={() => update({ fromCompletion: false })} />
          <span>The due date</span>
        </label>
        <label className="repeat-choice">
          <input type="radio" name={`${uid}-from`} checked={shape.fromCompletion} disabled={disabled} onChange={() => update({ fromCompletion: true })} />
          <span>The day I finish it</span>
        </label>
      </fieldset>

      {shape.fromCompletion && (
        <p className="repeat-note">{`Each one is due ${unitWord} after the day you finish the one before.`}</p>
      )}

      {!shape.fromCompletion && shape.unit === 'week' && (
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

      {!shape.fromCompletion && shape.unit === 'month' && (
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

      {!shape.fromCompletion && shape.unit === 'year' && <p className="repeat-note">On the due date's day and month.</p>}

      <fieldset className="repeat-month">
        <legend className="field-label">Ends</legend>
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
      </fieldset>

      {previewText(dates, shape.fromCompletion) && <p className="repeat-preview" role="status">{previewText(dates, shape.fromCompletion)}</p>}
    </div>
  )
}

// A Repeat choice for a task being added: the quick picks worded from the due date (or today),
// as Google Calendar lists them, and Custom, which opens the builder under it. `value` is the rule
// ('' for none) and `onChange` gets the new one. A pick writes its rule in full (buildRule), so the
// rule saved is the one its words describe whatever due date is picked next; an alias such as
// "weekly" shows as the pick it means for the due date, and any other rule shows as Custom.
export function RepeatSelect({ value, onChange, dueIso, api, disabled = false, id }) {
  const current = String(value || '').trim()
  const picks = quickPicks(dueIso)
  const matched = matchQuickPick(current, dueIso)
  const [custom, setCustom] = useState(matched === null)
  const showBuilder = custom || matched === null
  return (
    <>
      <select
        id={id}
        value={showBuilder ? 'custom' : matched}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.value
          if (next === 'custom') {
            setCustom(true)
            // Written out in full (a preset's "weekly" becomes this week's day as a BYDAY), so the
            // builder shows exactly the rule that is saved, whatever due date is picked next.
            onChange(buildRule(parseRule(current, dueIso) || defaultShape(dueIso)))
          } else {
            setCustom(false)
            onChange(next)
          }
        }}
      >
        {picks.map((pick) => <option key={pick.rule || 'never'} value={pick.rule}>{pick.label}</option>)}
        <option value="custom">Custom</option>
      </select>
      {showBuilder && <RepeatBuilder value={value} dueIso={dueIso} onChange={onChange} api={api} disabled={disabled} />}
    </>
  )
}

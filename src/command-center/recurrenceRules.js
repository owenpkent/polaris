// The repeat rules the dashboard can build by tapping, and the words a rule reads as.
//
// A task's recurrence is a string the server checks (command-center/src/automation/recurrence.ts):
// a friendly alias ("weekly", "every 2 weeks") or an RRULE. The builder (RepeatBuilder.jsx) edits
// a plain shape, { interval, unit, weekdays, monthMode, monthDay, nth, nthWeekday }, and this
// module turns that shape into the shortest string the server accepts and back. A rule the shape
// cannot hold (a raw RRULE with BYMONTH, say) parses to null and is left for the Recurrence box.

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
export const WEEKDAY_NAMES = { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' }
const WEEKDAY_SHORT = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' }
export const UNITS = ['day', 'week', 'month', 'year']
const FREQ_OF = { day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' }
const UNIT_OF = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }
export const MAX_INTERVAL = { day: 366, week: 53, month: 120, year: 10 }
const WORKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR']
export const NTH_NAMES = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', '-1': 'last' }

// The weekday code of a YYYY-MM-DD date (or of today when there is none).
export function weekdayOf(iso) {
  const d = iso ? new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) : new Date()
  return WEEKDAYS[(d.getDay() + 6) % 7]
}

// Where the builder starts for a task with no rule it can show: every week on the due date's day.
export function defaultShape(dueIso) {
  const day = dueIso ? Number(dueIso.slice(8, 10)) : new Date().getDate()
  const weekday = weekdayOf(dueIso)
  return {
    interval: 1,
    unit: 'week',
    weekdays: [weekday],
    monthMode: 'day',
    monthDay: day,
    nth: Math.min(Math.ceil(day / 7), 4),
    nthWeekday: weekday,
  }
}

const sortDays = (days) => WEEKDAYS.filter((d) => days.includes(d))

// The shape a rule string stands for, or null when it is empty or something the builder cannot
// show. `dueIso` fills the parts the rule leaves to the due date (the weekday of "weekly").
export function parseRule(rule, dueIso) {
  const text = String(rule || '').trim()
  if (!text) return null
  const base = defaultShape(dueIso)
  const lower = text.toLowerCase()
  const aliases = {
    daily: { unit: 'day' },
    weekly: { unit: 'week' },
    weekdays: { unit: 'week', weekdays: WORKDAYS },
    monthly: { unit: 'month', monthMode: 'day' },
    yearly: { unit: 'year' },
  }
  if (aliases[lower]) return { ...base, ...aliases[lower] }
  const every = /^every\s+(\d+)\s+(day|week|month|year)s?$/.exec(lower)
  if (every) {
    const unit = every[2]
    const interval = Number(every[1])
    if (interval < 1 || interval > MAX_INTERVAL[unit]) return null
    return { ...base, unit, interval }
  }
  const parts = {}
  for (const piece of text.replace(/^RRULE:/i, '').split(';')) {
    const [key, value] = piece.split('=')
    if (!key || value === undefined) return null
    parts[key.trim().toUpperCase()] = value.trim().toUpperCase()
  }
  const unit = UNIT_OF[parts.FREQ]
  if (!unit) return null
  const known = ['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY']
  if (Object.keys(parts).some((k) => !known.includes(k))) return null
  const interval = parts.INTERVAL ? Number(parts.INTERVAL) : 1
  if (!Number.isInteger(interval) || interval < 1 || interval > MAX_INTERVAL[unit]) return null
  const shape = { ...base, unit, interval }
  if (unit === 'week') {
    if (parts.BYMONTHDAY) return null
    if (parts.BYDAY) {
      const days = parts.BYDAY.split(',')
      if (!days.every((d) => WEEKDAYS.includes(d))) return null
      shape.weekdays = sortDays(days)
    }
    return shape
  }
  if (unit === 'month') {
    if (parts.BYDAY && parts.BYMONTHDAY) return null
    if (parts.BYMONTHDAY) {
      const n = Number(parts.BYMONTHDAY)
      if (!Number.isInteger(n) || !(n === -1 || (n >= 1 && n <= 31))) return null
      return { ...shape, monthMode: 'day', monthDay: n }
    }
    if (parts.BYDAY) {
      const m = /^(-1|[1-4])(MO|TU|WE|TH|FR|SA|SU)$/.exec(parts.BYDAY)
      if (!m) return null
      return { ...shape, monthMode: 'weekday', nth: Number(m[1]), nthWeekday: m[2] }
    }
    return { ...shape, monthMode: 'day' }
  }
  // Daily and yearly take no day parts in the builder.
  if (parts.BYDAY || parts.BYMONTHDAY) return null
  return shape
}

// The shortest string the server accepts for a shape: an alias where one fits, else an RRULE.
// `dueIso` decides whether a weekly rule on the due date's own weekday needs its BYDAY spelled out
// (it does not: a plain weekly rule repeats on the weekday of the date it starts from).
export function buildRule(shape, dueIso) {
  const { unit } = shape
  const interval = Math.min(Math.max(Math.trunc(shape.interval) || 1, 1), MAX_INTERVAL[unit])
  const plain = interval === 1 ? { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' }[unit] : `every ${interval} ${unit}s`
  const freq = `FREQ=${FREQ_OF[unit]}${interval > 1 ? `;INTERVAL=${interval}` : ''}`
  if (unit === 'week') {
    const days = sortDays(shape.weekdays || [])
    if (interval === 1 && days.join() === WORKDAYS.join()) return 'weekdays'
    if (days.length === 0 || (days.length === 1 && days[0] === weekdayOf(dueIso))) return plain
    return `${freq};BYDAY=${days.join(',')}`
  }
  if (unit === 'month') {
    if (shape.monthMode === 'weekday') return `${freq};BYDAY=${shape.nth}${shape.nthWeekday}`
    return `${freq};BYMONTHDAY=${shape.monthDay}`
  }
  return plain
}

function ordinal(n) {
  const rem100 = n % 100
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`
}

function listWords(words) {
  if (words.length <= 1) return words.join('')
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

// How a rule reads after "Repeats", or null when there is none. A rule the builder cannot show
// still repeats, so it reads as a custom rule rather than nothing.
export function describeRule(rule, dueIso) {
  const text = String(rule || '').trim()
  if (!text) return null
  const shape = parseRule(text, dueIso)
  if (!shape) return 'by a custom rule'
  const lower = text.toLowerCase()
  if (lower === 'weekdays') return 'on weekdays'
  const { unit, interval } = shape
  const every = interval === 1 ? { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' }[unit] : `every ${interval} ${unit}s`
  const explicitDays = /BYDAY=/i.test(text)
  if (unit === 'week' && explicitDays) {
    if (interval === 1 && shape.weekdays.join() === WORKDAYS.join()) return 'on weekdays'
    return `${every} on ${listWords(shape.weekdays.map((d) => WEEKDAY_SHORT[d]))}`
  }
  if (unit === 'month' && /BYMONTHDAY=/i.test(text)) {
    return `${every} on the ${shape.monthDay === -1 ? 'last day' : ordinal(shape.monthDay)}`
  }
  if (unit === 'month' && explicitDays) {
    return `${every} on the ${NTH_NAMES[shape.nth]} ${WEEKDAY_NAMES[shape.nthWeekday]}`
  }
  return every
}

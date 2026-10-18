// The repeat rules the dashboard can build by tapping, and the words a rule reads as.
//
// A task's recurrence is a string the server checks (command-center/src/automation/recurrence.ts):
// a friendly alias ("weekly", "every 2 weeks") or an RRULE, optionally with the extension
// X-FROM=COMPLETION (the next one counts from the day the task is finished). The builder
// (RepeatBuilder.jsx) edits a plain shape, { interval, unit, weekdays, monthMode, monthDay, nth,
// nthWeekday, yearLastFeb, ends, until, count, fromCompletion }, and this module turns that shape into the
// shortest string the server accepts and back. A rule the shape cannot hold (a raw RRULE with
// BYMONTH, say) parses to null and is left for the Recurrence box.
//
// COUNT counts the occurrences left, the task that carries it included: the server lowers it by
// one each time one is completed or skipped, so a rule with COUNT=5 reads "4 more after this" and
// COUNT=1 "this is the last one", and the words stay true as the series goes.

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
export const WEEKDAY_NAMES = { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' }
const WEEKDAY_SHORT = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' }
export const UNITS = ['day', 'week', 'month', 'year']
const FREQ_OF = { day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' }
const UNIT_OF = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }
export const MAX_INTERVAL = { day: 366, week: 53, month: 120, year: 10 }
const WORKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR']
export const NTH_NAMES = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', '-1': 'last' }
// The most the After N times choice offers; a longer COUNT from elsewhere is still shown.
export const MAX_COUNT = 100
const DEFAULT_COUNT = 10

// A local Date for a YYYY-MM-DD string, or today when there is none.
function dateOf(iso) {
  if (!iso) {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), now.getDate())
  }
  return new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)))
}

const pad = (n) => String(n).padStart(2, '0')
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const daysInMonth = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()

// The same day some months on, held to the end of a shorter month (Nov 30 plus three is Feb 28).
function addMonthsIso(iso, months) {
  const d = dateOf(iso)
  const target = new Date(d.getFullYear(), d.getMonth() + months, 1)
  target.setDate(Math.min(d.getDate(), daysInMonth(target)))
  return isoOf(target)
}

// The weekday code of a YYYY-MM-DD date (or of today when there is none).
export function weekdayOf(iso) {
  return WEEKDAYS[(dateOf(iso).getDay() + 6) % 7]
}

// Where the builder starts for a task with no rule it can show: every week on the due date's day,
// counted from the due date, never ending. The end date and count are what Ends offers first.
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
    // Yearly on the last day of February (BYMONTH=2;BYMONTHDAY=-1), the one yearly day part the
    // builder holds: the February 29 quick pick, which a plain "yearly" would turn into every
    // four years.
    yearLastFeb: false,
    ends: 'never',
    until: addMonthsIso(dueIso || isoOf(dateOf(null)), 3),
    count: DEFAULT_COUNT,
    fromCompletion: false,
  }
}

// Whether a rule counts each next one from the day the task is finished (X-FROM=COMPLETION).
export function countsFromCompletion(rule) {
  return /(^|;)\s*X-FROM\s*=\s*COMPLETION\s*(;|$)/i.test(String(rule || '').trim())
}

// The rule with X-FROM taken off, and whether it was there. Null when an X- part is not one the
// server accepts, so the rule is left for the Recurrence box (the server will say what is wrong).
function splitExtensions(text) {
  let fromCompletion = false
  const kept = []
  for (const piece of text.split(';')) {
    const [key, value = ''] = piece.split('=')
    const name = key.trim().replace(/^RRULE:/i, '').toUpperCase()
    if (!name.startsWith('X-')) { kept.push(piece); continue }
    if (name !== 'X-FROM' || value.trim().toUpperCase() !== 'COMPLETION' || fromCompletion) return null
    fromCompletion = true
  }
  return { base: kept.join(';').trim(), fromCompletion }
}

const sortDays = (days) => WEEKDAYS.filter((d) => days.includes(d))

// The shape a rule string stands for, or null when it is empty or something the builder cannot
// show. `dueIso` fills the parts the rule leaves to the due date (the weekday of "weekly").
export function parseRule(rule, dueIso) {
  const text = String(rule || '').trim()
  if (!text) return null
  const split = splitExtensions(text)
  if (!split || !split.base) return null
  const shape = parseBase(split.base, dueIso)
  if (!shape) return null
  if (split.fromCompletion) {
    // Counted from the finish, a rule is every N units and nothing more: the builder hides the day
    // choices then, so a rule that names days is one it cannot show.
    if (shape.explicitDays) return null
    shape.fromCompletion = true
  }
  delete shape.explicitDays
  return shape
}

function parseBase(text, dueIso) {
  const base = defaultShape(dueIso)
  const lower = text.toLowerCase()
  const aliases = {
    daily: { unit: 'day' },
    weekly: { unit: 'week' },
    weekdays: { unit: 'week', weekdays: WORKDAYS, explicitDays: true },
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
  const known = ['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'COUNT', 'UNTIL']
  if (Object.keys(parts).some((k) => !known.includes(k))) return null
  const interval = parts.INTERVAL ? Number(parts.INTERVAL) : 1
  if (!Number.isInteger(interval) || interval < 1 || interval > MAX_INTERVAL[unit]) return null
  const shape = { ...base, unit, interval }
  if (parts.COUNT && parts.UNTIL) return null
  if (parts.COUNT) {
    if (!/^\d+$/.test(parts.COUNT) || Number(parts.COUNT) < 1) return null
    shape.ends = 'after'
    shape.count = Number(parts.COUNT)
  }
  if (parts.UNTIL) {
    const m = /^(\d{4})(\d{2})(\d{2})(T\d{6}Z?)?$/.exec(parts.UNTIL)
    if (!m) return null
    shape.ends = 'on'
    shape.until = `${m[1]}-${m[2]}-${m[3]}`
  }
  if (parts.BYMONTH) {
    if (unit !== 'year' || parts.BYMONTH !== '2' || parts.BYMONTHDAY !== '-1' || parts.BYDAY) return null
    return { ...shape, yearLastFeb: true, explicitDays: true }
  }
  if (unit === 'week') {
    if (parts.BYMONTHDAY) return null
    if (parts.BYDAY) {
      const days = parts.BYDAY.split(',')
      if (!days.every((d) => WEEKDAYS.includes(d))) return null
      shape.weekdays = sortDays(days)
      shape.explicitDays = true
    }
    return shape
  }
  if (unit === 'month') {
    if (parts.BYDAY && parts.BYMONTHDAY) return null
    if (parts.BYMONTHDAY) {
      const n = Number(parts.BYMONTHDAY)
      if (!Number.isInteger(n) || !(n === -1 || (n >= 1 && n <= 31))) return null
      return { ...shape, monthMode: 'day', monthDay: n, explicitDays: true }
    }
    if (parts.BYDAY) {
      const m = /^(-1|[1-4])(MO|TU|WE|TH|FR|SA|SU)$/.exec(parts.BYDAY)
      if (!m) return null
      return { ...shape, monthMode: 'weekday', nth: Number(m[1]), nthWeekday: m[2], explicitDays: true }
    }
    return { ...shape, monthMode: 'day' }
  }
  // Daily and yearly take no day parts in the builder.
  if (parts.BYDAY || parts.BYMONTHDAY) return null
  return shape
}

// The parts after the days: how the series ends, then what it counts from.
function tailParts(shape) {
  const parts = []
  if (shape.ends === 'after') {
    parts.push(`COUNT=${Math.max(Math.trunc(shape.count) || 1, 1)}`)
  } else if (shape.ends === 'on' && /^\d{4}-\d{2}-\d{2}$/.test(shape.until || '')) {
    parts.push(`UNTIL=${shape.until.replace(/-/g, '')}`)
  }
  if (shape.fromCompletion) parts.push('X-FROM=COMPLETION')
  return parts
}

// The shortest string the server accepts for a shape: an alias where one fits, else an RRULE.
// A weekly rule always names the weekdays the builder shows pressed, even one that is the due
// date's own: a plain "weekly" follows the due date, which the add-task step can still change
// after the rule is built, and a Wednesday picked here must stay Wednesday. A rule that ends, or
// counts from the finish, is always written out as an RRULE with those parts after the rest; one
// counted from the finish has no day parts, so "every 2 weeks" means two weeks after it is done.
export function buildRule(shape) {
  const { unit } = shape
  const interval = Math.min(Math.max(Math.trunc(shape.interval) || 1, 1), MAX_INTERVAL[unit])
  const plain = interval === 1 ? { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' }[unit] : `every ${interval} ${unit}s`
  const freq = `FREQ=${FREQ_OF[unit]}${interval > 1 ? `;INTERVAL=${interval}` : ''}`
  const tail = tailParts(shape)
  if (shape.fromCompletion) return [freq, ...tail].join(';')
  let body = freq
  if (unit === 'week') {
    const days = sortDays(shape.weekdays || [])
    if (!tail.length && interval === 1 && days.join() === WORKDAYS.join()) return 'weekdays'
    if (days.length === 0 && !tail.length) return plain
    if (days.length) body = `${freq};BYDAY=${days.join(',')}`
  } else if (unit === 'month') {
    body = shape.monthMode === 'weekday' ? `${freq};BYDAY=${shape.nth}${shape.nthWeekday}` : `${freq};BYMONTHDAY=${shape.monthDay}`
  } else if (unit === 'year' && shape.yearLastFeb) {
    body = `${freq};BYMONTH=2;BYMONTHDAY=-1`
  } else if (!tail.length) {
    return plain
  }
  return [body, ...tail].join(';')
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

function formatUntil(iso) {
  return dateOf(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// How a rule reads after "Repeats", or null when there is none. A rule the builder cannot show
// still repeats, so it reads as a custom rule rather than nothing. An end and the finish anchor
// come after the rest: "weekly on Mon, until Dec 31, 2026", "every 3 days after you finish it",
// "daily, 4 more after this" (COUNT=5: this task and four more).
export function describeRule(rule, dueIso) {
  const text = String(rule || '').trim()
  if (!text) return null
  const shape = parseRule(text, dueIso)
  if (!shape) return 'by a custom rule'
  let words = describeDays(text, shape)
  if (shape.fromCompletion) words += ' after you finish it'
  if (shape.ends === 'on') words += `, until ${formatUntil(shape.until)}`
  if (shape.ends === 'after') words += shape.count === 1 ? ', this is the last one' : `, ${shape.count - 1} more after this`
  return words
}

function describeDays(text, shape) {
  if (text.toLowerCase() === 'weekdays') return 'on weekdays'
  const { unit, interval } = shape
  const every = interval === 1 ? { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' }[unit] : `every ${interval} ${unit}s`
  if (shape.fromCompletion) return every
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
  if (unit === 'year' && shape.yearLastFeb) return `${every} on the last day of February`
  return every
}

// The quick picks a Repeat choice offers, in the order Google Calendar lists them, worded from the
// due date (or today when there is none): for a task due Wednesday, October 14, "Weekly on
// Wednesday", "Monthly on day 14", "Monthly on the second Wednesday", "Annually on October 14".
// Each is { rule, label }, the rule being what buildRule writes for it, and the first is no repeat.
// A day that is the month's last reads as the last day, and a weekday in the month's last seven
// days as the last one, so the rule keeps meaning the end of the month in a shorter one. For the
// same reason the last day of February (the 29th, or the 28th in a common year) is annually on the
// last day of February, not every fourth year or every 28th.
export function quickPicks(dueIso) {
  const date = dateOf(dueIso)
  const iso = isoOf(date)
  const base = defaultShape(iso)
  const weekday = weekdayOf(iso)
  const weekdayName = WEEKDAY_NAMES[weekday]
  const day = date.getDate()
  const lastDay = day === daysInMonth(date)
  const nth = day + 7 > daysInMonth(date) ? -1 : Math.ceil(day / 7)
  const monthDay = lastDay ? -1 : day
  const onDay = lastDay ? 'on the last day' : `on day ${day}`
  const month = date.toLocaleDateString('en-US', { month: 'long' })
  const build = (patch) => buildRule({ ...base, ...patch })
  return [
    { rule: '', label: 'Does not repeat' },
    { rule: build({ unit: 'day' }), label: 'Daily' },
    { rule: build({ unit: 'week', weekdays: WORKDAYS }), label: 'Every weekday (Monday to Friday)' },
    { rule: build({ unit: 'week', weekdays: ['SA', 'SU'] }), label: 'Weekends' },
    { rule: build({ unit: 'week', weekdays: [weekday] }), label: `Weekly on ${weekdayName}` },
    { rule: build({ unit: 'week', interval: 2, weekdays: [weekday] }), label: `Every 2 weeks on ${weekdayName}` },
    { rule: build({ unit: 'month', monthMode: 'day', monthDay }), label: `Monthly ${onDay}` },
    { rule: build({ unit: 'month', monthMode: 'weekday', nth, nthWeekday: weekday }), label: `Monthly on the ${NTH_NAMES[nth]} ${weekdayName}` },
    { rule: build({ unit: 'month', interval: 3, monthMode: 'day', monthDay }), label: `Every 3 months ${onDay}` },
    month === 'February' && lastDay
      ? { rule: build({ unit: 'year', yearLastFeb: true }), label: 'Annually on the last day of February' }
      : { rule: build({ unit: 'year' }), label: `Annually on ${month} ${day}` },
  ]
}

// The quick pick a rule is, as its rule string ('' for none), or null when it is none of them. An
// alias counts as the pick it means for this due date: "weekly" on a Wednesday is Weekly on
// Wednesday, and "monthly" on the 14th is Monthly on day 14.
export function matchQuickPick(rule, dueIso) {
  const text = String(rule || '').trim()
  if (!text) return ''
  const shape = parseRule(text, dueIso)
  const canonical = shape ? buildRule(shape) : text
  const pick = quickPicks(dueIso).find((p) => p.rule && p.rule === canonical)
  return pick ? pick.rule : null
}

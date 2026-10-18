import { describeRule } from './recurrenceRules'

// Local-timezone date helpers for the My Tasks list.
//
// Bucketing and comparisons always happen on YYYY-MM-DD strings, never on
// `new Date(task.dueAt)` directly: a bare "2026-09-15" string is parsed by
// the Date constructor as UTC midnight, which shifts to the wrong local day
// in negative-UTC-offset timezones. `shared.jsx`'s own isOverdue/todayIso
// helpers already avoid this by comparing sliced date strings; these helpers
// follow the same approach.

// Titles imported from markdown checkboxes can carry links, bold, italic, and
// code markers. Show the readable text only; the stored title is unchanged.
export function plainTitle(title) {
  return title
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/(^|\s)\*([^*\s][^*]*)\*/g, '$1$2')
}

export function localIso(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function addDays(date, n) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n)
}

// A due value with a zone or an offset ('...Z', '+02:00'), which the server turns into floating
// local time on the way in but an older row may still hold, is read as the local time of that
// moment, so the list, the picker, and a reminder agree; an edit then saves the floating form.
// A day or a floating time is returned as it is.
const ZONED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/
export function localDue(dueAt) {
  if (!dueAt || !ZONED_RE.test(dueAt)) return dueAt
  const d = new Date(dueAt.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  if (Number.isNaN(d.getTime())) return dueAt
  return `${localIso(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// Extract just the YYYY-MM-DD portion of a task's dueAt (its local day), or null.
export function dueDateOnly(dueAt) {
  return dueAt ? localDue(dueAt).slice(0, 10) : null
}

// A due time. dueAt is a day ('YYYY-MM-DD') or, with a time, 'YYYY-MM-DDTHH:MM': floating local
// time with no zone, as the server stores it (a zoned value is read as local time, see localDue). So
// a task due at a time sits in its day's group (Today, Overdue, ...) and is overdue only once the
// day is past, as the server counts it; the time orders it within the day, after the untimed
// tasks. These return 'HH:MM' or null.
const TIME_RE = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/
export function dueTimeOnly(dueAt) {
  const m = dueAt ? TIME_RE.exec(localDue(dueAt)) : null
  return m ? `${m[1]}:${m[2]}` : null
}

// A due date with its day and time put together: `date` ('YYYY-MM-DD', or null for no due date)
// and `time` ('HH:MM', or null or '' for none).
export function joinDue(date, time) {
  if (!date) return null
  return time ? `${date}T${time}` : date
}

// A new day for a due date, keeping the time it had: moving a task due Friday at 9:00 to Monday
// makes it Monday at 9:00. Null clears the whole due date.
export function withDueDate(dueAt, date) {
  return joinDue(date, dueTimeOnly(dueAt))
}

// 'HH:MM' as the owner's locale writes a time ("9:00 AM", or "09:00" where the clock is 24-hour).
export function formatTime(hhmm, locale) {
  const [h, m] = hhmm.split(':').map(Number)
  // Some ICU versions put a narrow no-break space before AM; a plain space reads the same.
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }).replace(/\u202f/g, ' ')
}

// Parse a YYYY-MM-DD string as a local date (not UTC), for display formatting only.
function parseLocalDateOnly(isoDateOnly) {
  const [y, m, d] = isoDateOnly.split('-').map(Number)
  return new Date(y, m - 1, d)
}

// today/tomorrow/in7, all as local YYYY-MM-DD strings, computed from `now`.
export function getDueBounds(now = new Date()) {
  return {
    today: localIso(now),
    tomorrow: localIso(addDays(now, 1)),
    in7: localIso(addDays(now, 7)),
  }
}

// Which group a task's due date falls into, given the bounds above.
export function bucketForTask(task, bounds) {
  const d = dueDateOnly(task.dueAt)
  if (d === null) return 'noDue'
  if (d < bounds.today) return 'overdue'
  if (d === bounds.today) return 'today'
  if (d === bounds.tomorrow) return 'tomorrow'
  if (d > bounds.tomorrow && d <= bounds.in7) return 'next7'
  return 'later'
}

// Split a task list into the six My Tasks groups.
export function groupTasks(tasks, bounds) {
  const groups = { overdue: [], today: [], tomorrow: [], next7: [], later: [], noDue: [] }
  for (const task of tasks) {
    groups[bucketForTask(task, bounds)].push(task)
  }
  return groups
}

// Display text + color for the Due date cell. Independent of which group the
// row is rendered in -- computed purely from the date's relation to bounds.
// How a task's recurrence reads after "Repeats" (recurrenceRules.js): the aliases and every rule
// the builder can make get their own words, and anything else is a custom rule. Null when the task
// does not repeat.
export function repeatLabel(recurrence) {
  return describeRule(recurrence)
}

// The cell text is the day as the list writes it (Today, Tomorrow, a weekday, or a short date),
// then the time when there is one: "Today 9:00 AM", "Fri 9:00 AM", "Oct 18, 9:00 AM". `date` and
// `time` are the two parts on their own, for a chip that puts them on two lines when it must.
export function formatDueCell(dueAt, bounds, locale) {
  const d = dueDateOnly(dueAt)
  if (d === null) return { text: '', color: null, date: '', time: '' }
  const t = dueTimeOnly(dueAt)
  const time = t ? formatTime(t, locale) : ''
  const out = (date, color, sep = ' ') => ({ text: time ? `${date}${sep}${time}` : date, color, date, time })
  if (d === bounds.today) return out('Today', 'var(--green)')
  if (d === bounds.tomorrow) return out('Tomorrow', 'var(--green)')

  const parsed = parseLocalDateOnly(d)

  if (d < bounds.today) {
    return out(parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), 'var(--red)', ', ')
  }
  if (d <= bounds.in7) {
    return out(parsed.toLocaleDateString('en-US', { weekday: 'short' }), null)
  }
  const opts = { month: 'short', day: 'numeric' }
  // The "current year" comes from bounds, like every other comparison here, not the real clock.
  if (d.slice(0, 4) !== bounds.today.slice(0, 4)) opts.year = 'numeric'
  return out(parsed.toLocaleDateString('en-US', opts), null, ', ')
}

// A due date in a short form for places with no Today or weekday words (a board card, a goal's
// task list): "Oct 18", or "Oct 18, 9:00 AM" with a time.
export function formatDueShort(dueAt, locale) {
  const d = dueDateOnly(dueAt)
  if (d === null) return ''
  const date = parseLocalDateOnly(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const t = dueTimeOnly(dueAt)
  return t ? `${date}, ${formatTime(t, locale)}` : date
}

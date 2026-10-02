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

// Extract just the YYYY-MM-DD portion of a task's dueAt, or null.
export function dueDateOnly(dueAt) {
  return dueAt ? dueAt.slice(0, 10) : null
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
export function formatDueCell(dueAt, bounds) {
  const d = dueDateOnly(dueAt)
  if (d === null) return { text: '', color: null }
  if (d === bounds.today) return { text: 'Today', color: 'var(--green)' }
  if (d === bounds.tomorrow) return { text: 'Tomorrow', color: 'var(--green)' }

  const parsed = parseLocalDateOnly(d)

  if (d < bounds.today) {
    return { text: parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), color: 'var(--red)' }
  }
  if (d <= bounds.in7) {
    return { text: parsed.toLocaleDateString('en-US', { weekday: 'short' }), color: null }
  }
  const opts = { month: 'short', day: 'numeric' }
  // The "current year" comes from bounds, like every other comparison here, not the real clock.
  if (d.slice(0, 4) !== bounds.today.slice(0, 4)) opts.year = 'numeric'
  return { text: parsed.toLocaleDateString('en-US', opts), color: null }
}

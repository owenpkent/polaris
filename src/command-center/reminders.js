// Due-date reminders for the Android app. The dashboard plans them from its own task list and the
// app schedules them on the phone (nativeApp.js), so nothing is sent anywhere. The choices are per
// device and off by default.

export const REMINDER_PREFS_KEY = 'cc-reminders-v1'
export const REMINDER_CHANGED_EVENT = 'cc-reminders-changed'
export const DEFAULT_REMINDER_PREFS = { enabled: false, time: '09:00' }

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const TASK_ID = /^t_[0-9a-z]{10}$/
const DAY_MS = 24 * 60 * 60 * 1000

export function loadReminderPrefs() {
  try {
    const raw = localStorage.getItem(REMINDER_PREFS_KEY)
    if (!raw) return { ...DEFAULT_REMINDER_PREFS }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_REMINDER_PREFS }
    return {
      enabled: parsed.enabled === true,
      time: typeof parsed.time === 'string' && TIME_PATTERN.test(parsed.time) ? parsed.time : DEFAULT_REMINDER_PREFS.time,
    }
  } catch {
    return { ...DEFAULT_REMINDER_PREFS }
  }
}

export function saveReminderPrefs(prefs) {
  try {
    localStorage.setItem(REMINDER_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // Ignore storage errors (private browsing, quota, disabled storage, etc).
  }
  try {
    window.dispatchEvent(new Event(REMINDER_CHANGED_EVENT))
  } catch {
    // No window to tell.
  }
}

// A positive 31-bit integer for a task id (FNV-1a), the shape Android notification ids need. The
// same task always gets the same id; 0 is never returned.
export function notificationIdFor(taskId) {
  let hash = 0x811c9dc5
  const text = String(taskId)
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return ((hash >>> 0) & 0x7fffffff) || 1
}

const pad = (n) => String(n).padStart(2, '0')

// The reminders to schedule: one per task with a due date still ahead and within `horizonDays`.
// A date-only due fires at prefs.time on that local day; a due with a time fires at that instant.
export function planReminders(tasks, prefs, now = new Date(), horizonDays = 14) {
  const [hours, minutes] = (TIME_PATTERN.test(prefs?.time) ? prefs.time : DEFAULT_REMINDER_PREFS.time).split(':').map(Number)
  const limit = now.getTime() + horizonDays * DAY_MS
  const plan = []
  for (const task of tasks || []) {
    if (!task?.dueAt || !task.id) continue
    let at
    let body
    const dateOnly = DATE_ONLY.exec(task.dueAt)
    if (dateOnly) {
      at = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), hours, minutes)
      body = 'Due today'
    } else {
      at = new Date(task.dueAt)
      body = `Due at ${pad(at.getHours())}:${pad(at.getMinutes())}`
    }
    if (Number.isNaN(at.getTime())) continue
    if (at.getTime() <= now.getTime() || at.getTime() > limit) continue
    plan.push({ id: notificationIdFor(task.id), taskId: task.id, title: task.title, body, at })
  }
  return plan.sort((a, b) => a.at - b.at)
}

/** Reads a `task` query parameter: a task id, or null. */
export function parseTaskParam(search) {
  try {
    const value = new URLSearchParams(search || '').get('task')
    return value && TASK_ID.test(value) ? value : null
  } catch {
    return null
  }
}

/** Removes the `task` parameter from the address bar, keeping every other parameter and the hash. */
export function stripTaskParam() {
  try {
    const params = new URLSearchParams(window.location.search)
    if (!params.has('task')) return
    params.delete('task')
    const search = params.toString()
    const url = window.location.pathname + (search ? `?${search}` : '') + window.location.hash
    window.history.replaceState(null, '', url)
  } catch {
    // Ignore URL/history errors; the id is already in state.
  }
}

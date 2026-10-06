import { describe, test, expect, vi, afterEach } from 'vitest'
import {
  REMINDER_PREFS_KEY,
  DEFAULT_REMINDER_PREFS,
  loadReminderPrefs,
  saveReminderPrefs,
  notificationIdFor,
  planReminders,
  parseTaskParam,
  stripTaskParam,
} from './reminders'

afterEach(() => {
  localStorage.clear()
  window.history.replaceState(null, '', '/')
})

const NOW = new Date(2026, 9, 4, 8, 0) // 4 Oct 2026, 08:00 local
const task = (id, dueAt, title = id) => ({ id, title, dueAt, status: 'open' })

describe('planReminders', () => {
  const prefs = { enabled: true, time: '09:30' }

  test('a date-only due fires at the chosen local time that day', () => {
    const [item] = planReminders([task('t_aaaaaaaaaa', '2026-10-06', 'Pay rent')], prefs, NOW)
    expect(item.at.getTime()).toBe(new Date(2026, 9, 6, 9, 30).getTime())
    expect(item.body).toBe('Due today')
    expect(item.title).toBe('Pay rent')
    expect(item.taskId).toBe('t_aaaaaaaaaa')
    expect(item.id).toBe(notificationIdFor('t_aaaaaaaaaa'))
  })

  test('a datetime due fires at that instant and says its local time', () => {
    const due = new Date(2026, 9, 5, 17, 5)
    const [item] = planReminders([task('t_aaaaaaaaaa', due.toISOString())], prefs, NOW)
    expect(item.at.getTime()).toBe(due.getTime())
    expect(item.body).toBe('Due at 17:05')
  })

  test('skips no due date, past times, and times beyond the horizon', () => {
    const plan = planReminders([
      task('t_aaaaaaaaaa', null),
      task('t_bbbbbbbbbb', '2026-10-03'),
      task('t_cccccccccc', '2026-10-04'), // 09:30 today is still ahead
      task('t_dddddddddd', '2026-10-17'), // inside 14 days
      task('t_eeeeeeeeee', '2026-10-18'), // 09:30 is past 08:00 + 14 days
    ], prefs, NOW)
    expect(plan.map((p) => p.taskId)).toEqual(['t_cccccccccc', 't_dddddddddd'])
  })

  test('a time of day that has passed today is skipped', () => {
    const late = new Date(2026, 9, 4, 12, 0)
    expect(planReminders([task('t_aaaaaaaaaa', '2026-10-04')], prefs, late)).toEqual([])
  })

  test('sorts by time', () => {
    const plan = planReminders([task('t_bbbbbbbbbb', '2026-10-08'), task('t_aaaaaaaaaa', '2026-10-05')], prefs, NOW)
    expect(plan.map((p) => p.taskId)).toEqual(['t_aaaaaaaaaa', 't_bbbbbbbbbb'])
  })
})

describe('notificationIdFor', () => {
  test('is deterministic, a positive 31-bit integer, and never 0', () => {
    const id = notificationIdFor('t_abc123def4')
    expect(notificationIdFor('t_abc123def4')).toBe(id)
    expect(notificationIdFor('t_abc123def5')).not.toBe(id)
    for (const text of ['', 't_aaaaaaaaaa', 't_zzzzzzzzzz', 'x'.repeat(50)]) {
      const n = notificationIdFor(text)
      expect(Number.isInteger(n)).toBe(true)
      expect(n).toBeGreaterThan(0)
      expect(n).toBeLessThanOrEqual(0x7fffffff)
    }
  })
})

describe('reminder prefs', () => {
  test('default to off at 09:00', () => {
    expect(loadReminderPrefs()).toEqual(DEFAULT_REMINDER_PREFS)
  })

  test('bad JSON gives the defaults', () => {
    localStorage.setItem(REMINDER_PREFS_KEY, '{nope')
    expect(loadReminderPrefs()).toEqual(DEFAULT_REMINDER_PREFS)
  })

  test('a bad time falls back to 09:00 and keeps enabled', () => {
    localStorage.setItem(REMINDER_PREFS_KEY, JSON.stringify({ enabled: true, time: '25:99' }))
    expect(loadReminderPrefs()).toEqual({ enabled: true, time: '09:00' })
  })

  test('save stores the prefs and announces the change', () => {
    const heard = vi.fn()
    window.addEventListener('cc-reminders-changed', heard)
    saveReminderPrefs({ enabled: true, time: '18:15' })
    window.removeEventListener('cc-reminders-changed', heard)
    expect(heard).toHaveBeenCalledTimes(1)
    expect(loadReminderPrefs()).toEqual({ enabled: true, time: '18:15' })
  })
})

describe('task link parameter', () => {
  test('parseTaskParam accepts a task id only', () => {
    expect(parseTaskParam('?task=t_abc123def4')).toBe('t_abc123def4')
    expect(parseTaskParam('?task=nope')).toBeNull()
    expect(parseTaskParam('?view=board')).toBeNull()
    expect(parseTaskParam('')).toBeNull()
  })

  test('stripTaskParam keeps other parameters and the hash', () => {
    window.history.replaceState(null, '', '/?task=t_abc123def4&x=1#h')
    stripTaskParam()
    expect(window.location.search).toBe('?x=1')
    expect(window.location.hash).toBe('#h')
  })
})

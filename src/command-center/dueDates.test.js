import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  plainTitle,
  localIso,
  addDays,
  dueDateOnly,
  getDueBounds,
  bucketForTask,
  groupTasks,
  formatDueCell,
  repeatLabel,
} from './dueDates'

describe('repeatLabel', () => {
  test('nothing for a task that does not repeat', () => {
    expect(repeatLabel(null)).toBeNull()
    expect(repeatLabel('')).toBeNull()
    expect(repeatLabel('   ')).toBeNull()
  })

  test('words the aliases the server accepts, whatever their case', () => {
    expect(repeatLabel('weekly')).toBe('weekly')
    expect(repeatLabel('Daily')).toBe('daily')
    expect(repeatLabel('weekdays')).toBe('on weekdays')
    expect(repeatLabel('MONTHLY')).toBe('monthly')
    expect(repeatLabel('yearly')).toBe('yearly')
  })

  test('keeps an every-N rule as written', () => {
    expect(repeatLabel('every 2 weeks')).toBe('every 2 weeks')
    expect(repeatLabel('Every 3 days')).toBe('every 3 days')
  })

  test('anything else is a custom rule', () => {
    expect(repeatLabel('FREQ=WEEKLY;BYDAY=MO')).toBe('by a custom rule')
    expect(repeatLabel('RRULE:FREQ=DAILY')).toBe('by a custom rule')
  })
})

describe('plainTitle', () => {
  test('returns plain text unchanged when there is no markdown', () => {
    expect(plainTitle('Buy groceries')).toBe('Buy groceries')
  })

  test('replaces a markdown link with its link text', () => {
    expect(plainTitle('[Fix bug](https://example.com/issue)')).toBe('Fix bug')
  })

  test('strips bold markers made of double asterisks', () => {
    expect(plainTitle('**Important** task')).toBe('Important task')
  })

  test('strips underline-style bold markers', () => {
    expect(plainTitle('__note__')).toBe('note')
  })

  test('strips inline code backticks', () => {
    expect(plainTitle('`npm test`')).toBe('npm test')
  })

  test('strips single-asterisk italics at the start of the string', () => {
    expect(plainTitle('*urgent* fix')).toBe('urgent fix')
  })

  test('strips single-asterisk italics preceded by whitespace', () => {
    expect(plainTitle('do *this* now')).toBe('do this now')
  })

  test('leaves an asterisk pair alone when not preceded by start or whitespace', () => {
    // The italic regex requires the opening `*` to be at the start of the
    // string or preceded by whitespace, so "a*b*" has no valid match.
    expect(plainTitle('a*b*')).toBe('a*b*')
  })

  test('handles a title combining a bold link and italics', () => {
    expect(plainTitle('[**Bold Link**](url) and *italic*')).toBe('Bold Link and italic')
  })

  test('returns empty string unchanged', () => {
    expect(plainTitle('')).toBe('')
  })

  test('throws for a null or undefined title, since it is not a valid string', () => {
    expect(() => plainTitle(undefined)).toThrow()
    expect(() => plainTitle(null)).toThrow()
  })
})

describe('localIso', () => {
  test('formats year-month-day with zero padding', () => {
    expect(localIso(new Date(2026, 0, 5))).toBe('2026-01-05')
  })

  test('formats a double-digit month and day without extra padding', () => {
    expect(localIso(new Date(2026, 10, 25))).toBe('2026-11-25')
  })

  test('uses local date components, not UTC', () => {
    // A local midnight date should format as that same local day regardless
    // of what the UTC-equivalent day would be.
    const d = new Date(2026, 8, 18, 0, 0, 0)
    expect(localIso(d)).toBe('2026-09-18')
  })
})

describe('addDays', () => {
  test('adds days within the same month', () => {
    const result = addDays(new Date(2026, 8, 10), 5)
    expect(localIso(result)).toBe('2026-09-15')
  })

  test('rolls over into the next month', () => {
    const result = addDays(new Date(2026, 0, 31), 1)
    expect(localIso(result)).toBe('2026-02-01')
  })

  test('rolls over into the next year', () => {
    const result = addDays(new Date(2026, 11, 31), 1)
    expect(localIso(result)).toBe('2027-01-01')
  })

  test('supports negative offsets to go backward', () => {
    const result = addDays(new Date(2026, 8, 1), -1)
    expect(localIso(result)).toBe('2026-08-31')
  })

  test('adding zero days returns an equivalent date', () => {
    const base = new Date(2026, 8, 18)
    const result = addDays(base, 0)
    expect(localIso(result)).toBe(localIso(base))
  })
})

describe('dueDateOnly', () => {
  test('returns null for a null dueAt', () => {
    expect(dueDateOnly(null)).toBeNull()
  })

  test('returns null for an undefined dueAt', () => {
    expect(dueDateOnly(undefined)).toBeNull()
  })

  test('returns null for an empty string', () => {
    expect(dueDateOnly('')).toBeNull()
  })

  test('slices a full ISO timestamp down to the date-only portion', () => {
    expect(dueDateOnly('2026-09-15T10:30:00.000Z')).toBe('2026-09-15')
  })

  test('leaves a bare date-only string unchanged', () => {
    expect(dueDateOnly('2026-09-15')).toBe('2026-09-15')
  })

  test('returns a short string as-is when it is under 10 characters', () => {
    expect(dueDateOnly('2026-09')).toBe('2026-09')
  })
})

describe('getDueBounds', () => {
  test('computes today/tomorrow/in7 from an explicit now', () => {
    const bounds = getDueBounds(new Date(2026, 8, 18))
    expect(bounds).toEqual({ today: '2026-09-18', tomorrow: '2026-09-19', in7: '2026-09-25' })
  })

  test('rolls tomorrow and in7 over a month boundary', () => {
    const bounds = getDueBounds(new Date(2026, 8, 30))
    expect(bounds).toEqual({ today: '2026-09-30', tomorrow: '2026-10-01', in7: '2026-10-07' })
  })

  test('rolls tomorrow and in7 over a year boundary', () => {
    const bounds = getDueBounds(new Date(2026, 11, 30))
    expect(bounds).toEqual({ today: '2026-12-30', tomorrow: '2026-12-31', in7: '2027-01-06' })
  })

  test('defaults to the current system time when now is omitted', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2030, 4, 1))
    try {
      const bounds = getDueBounds()
      expect(bounds).toEqual({ today: '2030-05-01', tomorrow: '2030-05-02', in7: '2030-05-08' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('bucketForTask', () => {
  const bounds = getDueBounds(new Date(2026, 8, 18)) // today=09-18, tomorrow=09-19, in7=09-25

  test('buckets a task with no dueAt as noDue', () => {
    expect(bucketForTask({ dueAt: null }, bounds)).toBe('noDue')
  })

  test('buckets a past date as overdue', () => {
    expect(bucketForTask({ dueAt: '2026-09-10' }, bounds)).toBe('overdue')
  })

  test('buckets the day right before today as overdue', () => {
    expect(bucketForTask({ dueAt: '2026-09-17' }, bounds)).toBe('overdue')
  })

  test('buckets exactly today as today', () => {
    expect(bucketForTask({ dueAt: '2026-09-18T23:59:00Z' }, bounds)).toBe('today')
  })

  test('buckets exactly tomorrow as tomorrow', () => {
    expect(bucketForTask({ dueAt: '2026-09-19' }, bounds)).toBe('tomorrow')
  })

  test('buckets the day after tomorrow as next7', () => {
    expect(bucketForTask({ dueAt: '2026-09-20' }, bounds)).toBe('next7')
  })

  test('buckets exactly the in7 boundary as next7', () => {
    expect(bucketForTask({ dueAt: '2026-09-25' }, bounds)).toBe('next7')
  })

  test('buckets one day past in7 as later', () => {
    expect(bucketForTask({ dueAt: '2026-09-26' }, bounds)).toBe('later')
  })

  test('buckets a far-future date as later', () => {
    expect(bucketForTask({ dueAt: '2027-01-01' }, bounds)).toBe('later')
  })
})

describe('groupTasks', () => {
  const bounds = getDueBounds(new Date(2026, 8, 18))

  test('returns all six empty buckets for an empty task list', () => {
    expect(groupTasks([], bounds)).toEqual({
      overdue: [], today: [], tomorrow: [], next7: [], later: [], noDue: [],
    })
  })

  test('splits a mixed list into the right buckets', () => {
    const tasks = [
      { id: 'a', dueAt: '2026-09-10' }, // overdue
      { id: 'b', dueAt: '2026-09-18' }, // today
      { id: 'c', dueAt: '2026-09-19' }, // tomorrow
      { id: 'd', dueAt: '2026-09-22' }, // next7
      { id: 'e', dueAt: '2027-01-01' }, // later
      { id: 'f', dueAt: null }, // noDue
    ]
    const groups = groupTasks(tasks, bounds)
    expect(groups.overdue.map((t) => t.id)).toEqual(['a'])
    expect(groups.today.map((t) => t.id)).toEqual(['b'])
    expect(groups.tomorrow.map((t) => t.id)).toEqual(['c'])
    expect(groups.next7.map((t) => t.id)).toEqual(['d'])
    expect(groups.later.map((t) => t.id)).toEqual(['e'])
    expect(groups.noDue.map((t) => t.id)).toEqual(['f'])
  })

  test('preserves the original relative order within each bucket', () => {
    const tasks = [
      { id: 'a', dueAt: '2026-09-10' },
      { id: 'b', dueAt: '2026-09-11' },
      { id: 'c', dueAt: '2026-09-12' },
    ]
    const groups = groupTasks(tasks, bounds)
    expect(groups.overdue.map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('formatDueCell', () => {
  const bounds = getDueBounds(new Date(2026, 8, 18)) // today=09-18, tomorrow=09-19, in7=09-25

  test('returns an empty cell for a task with no due date', () => {
    expect(formatDueCell(null, bounds)).toEqual({ text: '', color: null })
  })

  test('renders "Today" in green for the current day', () => {
    expect(formatDueCell('2026-09-18', bounds)).toEqual({ text: 'Today', color: 'var(--green)' })
  })

  test('renders "Tomorrow" in green for the next day', () => {
    expect(formatDueCell('2026-09-19', bounds)).toEqual({ text: 'Tomorrow', color: 'var(--green)' })
  })

  test('renders an overdue date as a short month/day in red', () => {
    expect(formatDueCell('2026-09-10', bounds)).toEqual({ text: 'Sep 10', color: 'var(--red)' })
  })

  test('renders a date within the next7 window as a short weekday with no color', () => {
    // 2026-09-20 is a Sunday.
    expect(formatDueCell('2026-09-20', bounds)).toEqual({ text: 'Sun', color: null })
  })

  test('renders the in7 boundary date itself as a short weekday', () => {
    // 2026-09-25 is a Friday.
    expect(formatDueCell('2026-09-25', bounds)).toEqual({ text: 'Fri', color: null })
  })

  test('renders a date past in7 as a short month/day with no color', () => {
    expect(formatDueCell('2026-10-05', bounds)).toEqual({ text: 'Oct 5', color: null })
  })

  test('appends the year for a far-future date in a different year than bounds.today', () => {
    expect(formatDueCell('2027-09-18', bounds)).toEqual({ text: 'Sep 18, 2027', color: null })
  })

  test('omits the year when the far-future date is in the same year as bounds.today', () => {
    expect(formatDueCell('2026-11-01', bounds)).toEqual({ text: 'Nov 1', color: null })
  })

  test('the year decision follows bounds, not the real clock', () => {
    // Real clock pinned to a different year than bounds.today: only bounds may decide.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2031, 0, 1))
    try {
      expect(formatDueCell('2026-11-01', bounds)).toEqual({ text: 'Nov 1', color: null })
      expect(formatDueCell('2031-03-01', bounds)).toEqual({ text: 'Mar 1, 2031', color: null })
    } finally {
      vi.useRealTimers()
    }
  })
})

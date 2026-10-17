import { describe, test, expect } from 'vitest'
import { parseRule, buildRule, describeRule, defaultShape, weekdayOf } from './recurrenceRules'

// 2026-10-14 is a Wednesday.
const DUE = '2026-10-14'

describe('weekdayOf and defaultShape', () => {
  test('weekdayOf names the weekday of a date', () => {
    expect(weekdayOf('2026-10-12')).toBe('MO')
    expect(weekdayOf('2026-10-14')).toBe('WE')
    expect(weekdayOf('2026-10-18')).toBe('SU')
  })

  test('defaultShape is weekly on the due date', () => {
    expect(defaultShape(DUE)).toEqual({
      interval: 1, unit: 'week', weekdays: ['WE'], monthMode: 'day', monthDay: 14, nth: 2, nthWeekday: 'WE',
    })
  })

  test('defaultShape caps the nth week at 4', () => {
    expect(defaultShape('2026-10-31').nth).toBe(4)
  })
})

describe('round trips', () => {
  const cases = [
    'daily', 'weekly', 'weekdays', 'monthly', 'yearly', 'every 2 weeks',
    'FREQ=WEEKLY;BYDAY=MO,WE', 'FREQ=MONTHLY;BYMONTHDAY=-1', 'FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR',
  ]
  for (const rule of cases) {
    test(`${rule}`, () => {
      const shape = parseRule(rule, DUE)
      expect(shape).not.toBeNull()
      const built = buildRule(shape, DUE)
      expect(parseRule(built, DUE)).toEqual(shape)
    })
  }

  test('aliases and explicit rules come back as written when already shortest', () => {
    for (const rule of ['daily', 'weekly', 'weekdays', 'yearly', 'every 2 weeks', 'FREQ=WEEKLY;BYDAY=MO,WE', 'FREQ=MONTHLY;BYMONTHDAY=-1', 'FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR']) {
      expect(buildRule(parseRule(rule, DUE), DUE)).toBe(rule)
    }
  })

  test('monthly becomes a day-of-month rule on the due day', () => {
    expect(buildRule(parseRule('monthly', DUE), DUE)).toBe('FREQ=MONTHLY;BYMONTHDAY=14')
  })
})

describe('building', () => {
  test('weekly on the due date weekday collapses to weekly', () => {
    expect(buildRule(parseRule('FREQ=WEEKLY;BYDAY=WE', DUE), DUE)).toBe('weekly')
  })

  test('weekly on another weekday keeps BYDAY', () => {
    expect(buildRule(parseRule('FREQ=WEEKLY;BYDAY=TU', DUE), DUE)).toBe('FREQ=WEEKLY;BYDAY=TU')
  })

  test('Monday to Friday every week becomes weekdays', () => {
    expect(buildRule(parseRule('FREQ=WEEKLY;BYDAY=FR,MO,TU,WE,TH', DUE), DUE)).toBe('weekdays')
  })

  test('Monday to Friday every 2 weeks stays an RRULE', () => {
    expect(buildRule(parseRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR', DUE), DUE))
      .toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR')
  })

  test('interval is clamped to the unit maximum', () => {
    expect(buildRule({ ...defaultShape(DUE), unit: 'year', interval: 99 }, DUE)).toBe('every 10 years')
  })
})

describe('unsupported rules parse to null', () => {
  const bad = [
    '', null, 'garbage', 'FREQ=YEARLY;BYMONTH=3', 'FREQ=DAILY;COUNT=5', 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1',
    'FREQ=WEEKLY;INTERVAL=54', 'every 54 weeks', 'every 0 days', 'FREQ=DAILY;INTERVAL=367', 'FREQ=MONTHLY;BYMONTHDAY=32',
    'FREQ=MONTHLY;BYDAY=5MO', 'FREQ=WEEKLY;BYDAY=XX',
  ]
  for (const rule of bad) {
    test(`${JSON.stringify(rule)}`, () => {
      expect(parseRule(rule, DUE)).toBeNull()
    })
  }
})

describe('describeRule', () => {
  test('none reads as null', () => {
    expect(describeRule('', DUE)).toBeNull()
    expect(describeRule(null, DUE)).toBeNull()
  })

  test('aliases and intervals', () => {
    expect(describeRule('daily')).toBe('daily')
    expect(describeRule('weekly')).toBe('weekly')
    expect(describeRule('weekdays')).toBe('on weekdays')
    expect(describeRule('monthly')).toBe('monthly')
    expect(describeRule('yearly')).toBe('yearly')
    expect(describeRule('every 2 weeks')).toBe('every 2 weeks')
  })

  test('weekday lists', () => {
    expect(describeRule('FREQ=WEEKLY;BYDAY=MO,WE')).toBe('weekly on Mon and Wed')
    expect(describeRule('FREQ=WEEKLY;BYDAY=MO,WE,FR')).toBe('weekly on Mon, Wed and Fri')
    expect(describeRule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')).toBe('on weekdays')
  })

  test('month rules', () => {
    expect(describeRule('FREQ=MONTHLY;BYMONTHDAY=-1')).toBe('monthly on the last day')
    expect(describeRule('FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR')).toBe('every 2 months on the last Friday')
    expect(describeRule('FREQ=MONTHLY;BYDAY=2TU')).toBe('monthly on the second Tuesday')
  })

  test('ordinals', () => {
    const words = (n) => describeRule(`FREQ=MONTHLY;BYMONTHDAY=${n}`)
    expect(words(1)).toBe('monthly on the 1st')
    expect(words(2)).toBe('monthly on the 2nd')
    expect(words(3)).toBe('monthly on the 3rd')
    expect(words(4)).toBe('monthly on the 4th')
    expect(words(11)).toBe('monthly on the 11th')
    expect(words(12)).toBe('monthly on the 12th')
    expect(words(13)).toBe('monthly on the 13th')
    expect(words(21)).toBe('monthly on the 21st')
    expect(words(22)).toBe('monthly on the 22nd')
    expect(words(23)).toBe('monthly on the 23rd')
  })

  test('a rule the builder cannot show is a custom rule', () => {
    expect(describeRule('FREQ=YEARLY;BYMONTH=3')).toBe('by a custom rule')
  })
})

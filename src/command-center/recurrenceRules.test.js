import { describe, test, expect, vi, afterEach } from 'vitest'
import {
  parseRule, buildRule, describeRule, defaultShape, weekdayOf, quickPicks, matchQuickPick, countsFromCompletion,
} from './recurrenceRules'

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
      interval: 1, unit: 'week', weekdays: ['WE'], monthMode: 'day', monthDay: 14, nth: 2, nthWeekday: 'WE', yearLastFeb: false,
      ends: 'never', until: '2027-01-14', count: 10, fromCompletion: false,
    })
  })

  test('defaultShape caps the nth week at 4', () => {
    expect(defaultShape('2026-10-31').nth).toBe(4)
  })

  test('the end date it offers is three months on, held to the end of a shorter month', () => {
    expect(defaultShape('2026-11-30').until).toBe('2027-02-28')
    expect(defaultShape('2027-11-30').until).toBe('2028-02-29')
  })
})

describe('round trips', () => {
  const cases = [
    'daily', 'weekly', 'weekdays', 'monthly', 'yearly', 'every 2 weeks',
    'FREQ=WEEKLY;BYDAY=MO,WE', 'FREQ=MONTHLY;BYMONTHDAY=-1', 'FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR',
    'FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231', 'FREQ=DAILY;COUNT=5', 'FREQ=DAILY;INTERVAL=3;X-FROM=COMPLETION',
    'FREQ=WEEKLY;INTERVAL=2;COUNT=4;X-FROM=COMPLETION', 'FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20270630',
    'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=3', 'FREQ=YEARLY;UNTIL=20300101', 'FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=12',
    'FREQ=MONTHLY;X-FROM=COMPLETION', 'FREQ=YEARLY;UNTIL=20301231;X-FROM=COMPLETION', 'FREQ=WEEKLY;BYDAY=SA,SU',
  ]
  for (const rule of cases) {
    test(`${rule}`, () => {
      const shape = parseRule(rule, DUE)
      expect(shape).not.toBeNull()
      const built = buildRule(shape)
      expect(parseRule(built, DUE)).toEqual(shape)
    })
  }

  test('aliases and explicit rules come back as written when already shortest', () => {
    for (const rule of [
      'daily', 'weekdays', 'yearly', 'FREQ=WEEKLY;BYDAY=MO,WE', 'FREQ=MONTHLY;BYMONTHDAY=-1', 'FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR',
      'FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231', 'FREQ=DAILY;COUNT=5', 'FREQ=DAILY;INTERVAL=3;X-FROM=COMPLETION',
      'FREQ=WEEKLY;INTERVAL=2;COUNT=4;X-FROM=COMPLETION', 'FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20270630',
    ]) {
      expect(buildRule(parseRule(rule, DUE))).toBe(rule)
    }
  })

  test('monthly becomes a day-of-month rule on the due day', () => {
    expect(buildRule(parseRule('monthly', DUE))).toBe('FREQ=MONTHLY;BYMONTHDAY=14')
  })
})

describe('building', () => {
  // A plain "weekly" follows the due date, which the add-task step can change after the rule is
  // built, so the builder always writes the weekday it shows.
  test('a weekly rule names its weekday, even the due date\'s own', () => {
    expect(buildRule(parseRule('FREQ=WEEKLY;BYDAY=WE', DUE))).toBe('FREQ=WEEKLY;BYDAY=WE')
    expect(buildRule(parseRule('weekly', DUE))).toBe('FREQ=WEEKLY;BYDAY=WE')
    expect(buildRule(parseRule('every 2 weeks', DUE))).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=WE')
  })

  test('weekly on another weekday keeps BYDAY', () => {
    expect(buildRule(parseRule('FREQ=WEEKLY;BYDAY=TU', DUE))).toBe('FREQ=WEEKLY;BYDAY=TU')
  })

  test('Monday to Friday every week becomes weekdays', () => {
    expect(buildRule(parseRule('FREQ=WEEKLY;BYDAY=FR,MO,TU,WE,TH', DUE))).toBe('weekdays')
  })

  test('Monday to Friday every 2 weeks stays an RRULE', () => {
    expect(buildRule(parseRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR', DUE)))
      .toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR')
  })

  test('interval is clamped to the unit maximum', () => {
    expect(buildRule({ ...defaultShape(DUE), unit: 'year', interval: 99 })).toBe('every 10 years')
  })

  test('an end turns an alias into an RRULE with COUNT or UNTIL after the rest', () => {
    const base = defaultShape(DUE)
    expect(buildRule({ ...base, unit: 'day', ends: 'after', count: 5 })).toBe('FREQ=DAILY;COUNT=5')
    expect(buildRule({ ...base, unit: 'day', interval: 2, ends: 'on', until: '2026-12-31' })).toBe('FREQ=DAILY;INTERVAL=2;UNTIL=20261231')
    expect(buildRule({ ...base, unit: 'week', weekdays: ['MO', 'TU', 'WE', 'TH', 'FR'], ends: 'on', until: '2026-12-31' }))
      .toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;UNTIL=20261231')
    expect(buildRule({ ...base, unit: 'year', ends: 'after', count: 3 })).toBe('FREQ=YEARLY;COUNT=3')
    expect(buildRule({ ...base, unit: 'day', ends: 'never', count: 5 })).toBe('daily')
  })

  test('counted from the finish, a rule drops its day parts and carries X-FROM last', () => {
    const base = defaultShape(DUE)
    expect(buildRule({ ...base, unit: 'week', fromCompletion: true })).toBe('FREQ=WEEKLY;X-FROM=COMPLETION')
    expect(buildRule({ ...base, unit: 'month', monthMode: 'weekday', fromCompletion: true })).toBe('FREQ=MONTHLY;X-FROM=COMPLETION')
    expect(buildRule({ ...base, unit: 'day', interval: 3, fromCompletion: true, ends: 'after', count: 2 }))
      .toBe('FREQ=DAILY;INTERVAL=3;COUNT=2;X-FROM=COMPLETION')
  })
})

describe('parsing ends and the finish anchor', () => {
  test('UNTIL with a time keeps its date, COUNT reads as After', () => {
    expect(parseRule('FREQ=DAILY;UNTIL=20261231T235959Z', DUE)).toMatchObject({ ends: 'on', until: '2026-12-31' })
    expect(parseRule('FREQ=DAILY;COUNT=7', DUE)).toMatchObject({ ends: 'after', count: 7 })
    expect(parseRule('FREQ=DAILY;COUNT=150', DUE)).toMatchObject({ ends: 'after', count: 150 })
  })

  test('X-FROM=COMPLETION in any case and on an alias', () => {
    expect(parseRule('every 3 days;X-FROM=COMPLETION', DUE)).toMatchObject({ unit: 'day', interval: 3, fromCompletion: true })
    expect(parseRule('freq=weekly;x-from=completion', DUE)).toMatchObject({ unit: 'week', fromCompletion: true })
    expect(parseRule('daily', DUE).fromCompletion).toBe(false)
  })

  test('countsFromCompletion', () => {
    expect(countsFromCompletion('FREQ=DAILY;X-FROM=COMPLETION')).toBe(true)
    expect(countsFromCompletion('FREQ=DAILY;x-from = completion')).toBe(true)
    expect(countsFromCompletion('FREQ=DAILY')).toBe(false)
    expect(countsFromCompletion(null)).toBe(false)
  })
})

describe('unsupported rules parse to null', () => {
  const bad = [
    '', null, 'garbage', 'FREQ=YEARLY;BYMONTH=3', 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1',
    'FREQ=WEEKLY;INTERVAL=54', 'every 54 weeks', 'every 0 days', 'FREQ=DAILY;INTERVAL=367', 'FREQ=MONTHLY;BYMONTHDAY=32',
    'FREQ=MONTHLY;BYDAY=5MO', 'FREQ=WEEKLY;BYDAY=XX',
    'FREQ=DAILY;X-FOO=1', 'FREQ=DAILY;X-FROM=DUE', 'FREQ=DAILY;X-FROM=COMPLETION;X-FROM=COMPLETION', 'X-FROM=COMPLETION',
    'FREQ=DAILY;COUNT=2;UNTIL=20261231', 'FREQ=WEEKLY;BYDAY=MO;X-FROM=COMPLETION', 'weekdays;X-FROM=COMPLETION',
    'FREQ=DAILY;UNTIL=2026-12-31', 'FREQ=DAILY;COUNT=0', 'FREQ=DAILY;COUNT=two',
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
    expect(describeRule('FREQ=YEARLY;BYMONTH=3;X-FROM=COMPLETION')).toBe('by a custom rule')
  })

  test('the last day and the last weekday of the month', () => {
    expect(describeRule('FREQ=MONTHLY;BYMONTHDAY=-1')).toBe('monthly on the last day')
    expect(describeRule('FREQ=MONTHLY;BYDAY=-1FR')).toBe('monthly on the last Friday')
  })

  test('ends: until a date, or how many are left including this one', () => {
    expect(describeRule('FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231')).toBe('weekly on Mon, until Dec 31, 2026')
    expect(describeRule('FREQ=DAILY;COUNT=5')).toBe('daily, 4 more after this')
    expect(describeRule('FREQ=DAILY;COUNT=1')).toBe('daily, this is the last one')
    expect(describeRule('FREQ=DAILY;COUNT=2')).toBe('daily, 1 more after this')
    expect(describeRule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;UNTIL=20270101')).toBe('on weekdays, until Jan 1, 2027')
    expect(describeRule('FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=12')).toBe('monthly on the last day, 11 more after this')
  })

  test('counted from the finish', () => {
    expect(describeRule('FREQ=DAILY;INTERVAL=3;X-FROM=COMPLETION')).toBe('every 3 days after you finish it')
    expect(describeRule('FREQ=WEEKLY;X-FROM=COMPLETION')).toBe('weekly after you finish it')
    expect(describeRule('FREQ=WEEKLY;INTERVAL=2;COUNT=4;X-FROM=COMPLETION')).toBe('every 2 weeks after you finish it, 3 more after this')
  })
})

describe('quickPicks', () => {
  afterEach(() => { vi.useRealTimers() })

  test('worded from a Wednesday, October 14 due date, as Google Calendar lists them', () => {
    expect(quickPicks(DUE)).toEqual([
      { rule: '', label: 'Does not repeat' },
      { rule: 'daily', label: 'Daily' },
      { rule: 'weekdays', label: 'Every weekday (Monday to Friday)' },
      { rule: 'FREQ=WEEKLY;BYDAY=SA,SU', label: 'Weekends' },
      { rule: 'FREQ=WEEKLY;BYDAY=WE', label: 'Weekly on Wednesday' },
      { rule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE', label: 'Every 2 weeks on Wednesday' },
      { rule: 'FREQ=MONTHLY;BYMONTHDAY=14', label: 'Monthly on day 14' },
      { rule: 'FREQ=MONTHLY;BYDAY=2WE', label: 'Monthly on the second Wednesday' },
      { rule: 'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=14', label: 'Every 3 months on day 14' },
      { rule: 'yearly', label: 'Annually on October 14' },
    ])
  })

  test('the month\'s last day and its last weekday read as the last', () => {
    const picks = Object.fromEntries(quickPicks('2026-10-31').map((p) => [p.label, p.rule]))
    expect(picks['Monthly on the last day']).toBe('FREQ=MONTHLY;BYMONTHDAY=-1')
    expect(picks['Monthly on the last Saturday']).toBe('FREQ=MONTHLY;BYDAY=-1SA')
    expect(picks['Every 3 months on the last day']).toBe('FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=-1')
    // The fourth Wednesday of October 2026 is also its last.
    expect(quickPicks('2026-10-28').map((p) => p.label)).toContain('Monthly on the last Wednesday')
    expect(quickPicks('2026-10-21').map((p) => p.label)).toContain('Monthly on the third Wednesday')
    expect(quickPicks('2026-02-28').map((p) => p.label)).toContain('Monthly on the last day')
  })

  // "yearly" from February 29 comes back only in leap years, so the pick is the last day of February.
  test('a February 29 due date offers the last day of February every year', () => {
    const picks = quickPicks('2028-02-29')
    const annual = picks[picks.length - 1]
    expect(annual).toEqual({ rule: 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1', label: 'Annually on the last day of February' })
    expect(describeRule(annual.rule, '2028-02-29')).toBe('yearly on the last day of February')
    expect(describeRule(annual.rule)).toBe('yearly on the last day of February')
    expect(matchQuickPick(annual.rule, '2028-02-29')).toBe(annual.rule)
    expect(buildRule(parseRule(annual.rule, '2028-02-29'))).toBe(annual.rule)
    expect(buildRule({ ...parseRule(annual.rule, '2028-02-29'), ends: 'after', count: 4 })).toBe('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1;COUNT=4')
    expect(describeRule('FREQ=YEARLY;INTERVAL=2;BYMONTH=2;BYMONTHDAY=-1')).toBe('every 2 years on the last day of February')
    // Any other month and day stays a custom rule, and a plain yearly from February 29 is not this pick.
    expect(parseRule('FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=-1', DUE)).toBeNull()
    expect(matchQuickPick('yearly', '2028-02-29')).toBeNull()
    // February 28 is the last day in a common year, so it gets the same pick, and the rule a
    // February 29 task carries is still checked once its series reaches a common year.
    expect(quickPicks('2027-02-28').at(-1)).toEqual(annual)
    expect(matchQuickPick(annual.rule, '2029-02-28')).toBe(annual.rule)
    expect(matchQuickPick(annual.rule, '2028-02-29')).toBe(annual.rule)
    // In a leap year February 28 is not the last day, so it stays a plain yearly.
    expect(quickPicks('2028-02-28').at(-1)).toEqual({ rule: 'yearly', label: 'Annually on February 28' })
    expect(matchQuickPick(annual.rule, '2028-02-28')).toBeNull()
  })

  test('with no due date they are worded from today', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 14, 9, 0))
    expect(quickPicks(null).map((p) => p.label)).toContain('Weekly on Wednesday')
    expect(quickPicks(null).map((p) => p.label)).toContain('Annually on October 14')
  })

  test('every pick parses back to itself and is matched as itself', () => {
    for (const due of [DUE, '2026-10-31', '2026-02-28', '2028-02-29']) {
      for (const { rule } of quickPicks(due).slice(1)) {
        expect(buildRule(parseRule(rule, due))).toBe(rule)
        expect(matchQuickPick(rule, due)).toBe(rule)
      }
    }
  })
})

describe('matchQuickPick', () => {
  test('an alias is the pick it means for the due date', () => {
    expect(matchQuickPick('weekly', DUE)).toBe('FREQ=WEEKLY;BYDAY=WE')
    expect(matchQuickPick('weekly', '2026-10-16')).toBe('FREQ=WEEKLY;BYDAY=FR')
    expect(matchQuickPick('every 2 weeks', DUE)).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=WE')
    expect(matchQuickPick('monthly', DUE)).toBe('FREQ=MONTHLY;BYMONTHDAY=14')
    expect(matchQuickPick('yearly', DUE)).toBe('yearly')
    expect(matchQuickPick('weekdays', DUE)).toBe('weekdays')
    expect(matchQuickPick('FREQ=WEEKLY;BYDAY=SU,SA', DUE)).toBe('FREQ=WEEKLY;BYDAY=SA,SU')
  })

  test('no rule is the first pick, and anything else is none', () => {
    expect(matchQuickPick('', DUE)).toBe('')
    expect(matchQuickPick(null, DUE)).toBe('')
    expect(matchQuickPick('every 3 days', DUE)).toBeNull()
    expect(matchQuickPick('FREQ=DAILY;COUNT=5', DUE)).toBeNull()
    expect(matchQuickPick('FREQ=DAILY;X-FROM=COMPLETION', DUE)).toBeNull()
    expect(matchQuickPick('FREQ=YEARLY;BYMONTH=3', DUE)).toBeNull()
    expect(matchQuickPick('FREQ=WEEKLY;BYDAY=WE', '2026-10-16')).toBeNull()
  })
})

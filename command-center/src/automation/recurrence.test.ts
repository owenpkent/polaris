import { test } from 'node:test';
import assert from 'node:assert/strict';
import rrulePkg from 'rrule';
import { openApp } from '../app.ts';
import { nextOccurrence } from './recurrence.ts';

// rrule is the reference the walk in recurrence.ts is checked against (see DIFFERENTIAL below).
const { RRule } = rrulePkg;

test('daily advances one day', () => {
  assert.equal(nextOccurrence('FREQ=DAILY', '2026-09-10', '2026-09-10'), '2026-09-11');
});

test('weekdays alias skips the weekend', () => {
  // 2026-09-11 is a Friday; the next weekday is Monday 2026-09-14.
  assert.equal(nextOccurrence('weekdays', '2026-09-11', '2026-09-11'), '2026-09-14');
});

test('monthly on the 31st skips months without one', () => {
  assert.equal(nextOccurrence('FREQ=MONTHLY;BYMONTHDAY=31', '2026-01-31', '2026-01-31'), '2026-03-31');
});

test('completing a weekly task three weeks late spawns one instance, not three', () => {
  // Weekly from 2026-09-04 (Friday): 09-11, 09-18, 09-25, ... Completed on 09-25, three weeks
  // after the 09-04 due date. The next instance should be due around today, not back-dated.
  assert.equal(nextOccurrence('FREQ=WEEKLY', '2026-09-04', '2026-09-25'), '2026-09-25');
});

test('COUNT exhausted returns null', () => {
  assert.equal(nextOccurrence('FREQ=DAILY;COUNT=1', '2026-09-10', '2026-09-10'), null);
});

test('UNTIL exhausted returns null', () => {
  assert.equal(nextOccurrence('FREQ=DAILY;UNTIL=20260910', '2026-09-10', '2026-09-10'), null);
});

test('datetime previousDue keeps its time of day and zone', () => {
  assert.equal(nextOccurrence('FREQ=WEEKLY', '2026-09-10T09:30:00Z', '2026-09-10'), '2026-09-17T09:30:00Z');
});

test('RRULE: prefix is accepted', () => {
  assert.equal(nextOccurrence('RRULE:FREQ=DAILY', '2026-09-10', '2026-09-10'), '2026-09-11');
});

test('friendly aliases: daily, weekly, monthly, yearly, every N weeks', () => {
  assert.equal(nextOccurrence('daily', '2026-09-10', '2026-09-10'), '2026-09-11');
  assert.equal(nextOccurrence('weekly', '2026-09-10', '2026-09-10'), '2026-09-17');
  assert.equal(nextOccurrence('monthly', '2026-09-10', '2026-09-10'), '2026-10-10');
  assert.equal(nextOccurrence('yearly', '2026-09-10', '2026-09-10'), '2027-09-10');
  assert.equal(nextOccurrence('every 2 weeks', '2026-09-10', '2026-09-10'), '2026-09-24');
  assert.equal(nextOccurrence('EVERY 3 DAYS', '2026-09-10', '2026-09-10'), '2026-09-13');
});

test('a task finished early still advances to the next scheduled occurrence, not today', () => {
  assert.equal(nextOccurrence('FREQ=WEEKLY', '2026-09-17', '2026-09-10'), '2026-09-24');
});

test('invalid rules throw a clear error', () => {
  assert.throws(() => nextOccurrence('not a valid rrule', '2026-09-10', '2026-09-10'), /invalid recurrence rule/);
  assert.throws(() => nextOccurrence('FREQ=BOGUS', '2026-09-10', '2026-09-10'), /invalid recurrence rule/);
  assert.throws(() => nextOccurrence('BYDAY=MO', '2026-09-10', '2026-09-10'), /FREQ/);
  assert.throws(() => nextOccurrence('', '2026-09-10', '2026-09-10'), /invalid recurrence rule/);
});

test('invalid previousDue throws a clear error', () => {
  assert.throws(() => nextOccurrence('FREQ=DAILY', 'not-a-date', '2026-09-10'), /invalid date/);
});


// ---- bounds: a rule is expanded on the request thread, so every rule has to be one that ends

test('a negative, zero, or non-numeric INTERVAL is refused instead of being expanded', () => {
  for (const rule of ['FREQ=DAILY;INTERVAL=-1', 'FREQ=DAILY;INTERVAL=0', 'FREQ=DAILY;INTERVAL=abc', 'FREQ=DAILY;INTERVAL=1.5', 'FREQ=DAILY;INTERVAL=367']) {
    assert.throws(() => nextOccurrence(rule, '2026-09-10', '2026-09-12'), /INTERVAL must be a whole number from 1 to 366/, rule);
  }
  assert.equal(nextOccurrence('FREQ=DAILY;INTERVAL=366', '2026-09-10', '2026-09-10'), '2027-09-11');
});

test('COUNT below one and a sub-daily FREQ are refused', () => {
  assert.throws(() => nextOccurrence('FREQ=DAILY;COUNT=0', '2026-09-10', '2026-09-12'), /COUNT must be a whole number from 1/);
  assert.throws(() => nextOccurrence('FREQ=DAILY;COUNT=-3', '2026-09-10', '2026-09-12'), /COUNT/);
  for (const freq of ['HOURLY', 'MINUTELY', 'SECONDLY']) {
    assert.throws(() => nextOccurrence(`FREQ=${freq}`, '2026-09-10', '2026-09-12'), /FREQ must be DAILY, WEEKLY, MONTHLY, or YEARLY/, freq);
  }
});

test('a day that never comes is refused instead of being searched for until the year 9999', () => {
  const started = Date.now();
  assert.throws(() => nextOccurrence('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30', '2026-09-10', '2026-09-12'), /never come up/);
  assert.throws(() => nextOccurrence('FREQ=DAILY;BYMONTH=2;BYMONTHDAY=31', '2026-09-10', '2026-09-12'), /never come up/);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
  assert.equal(nextOccurrence('FREQ=YEARLY;UNTIL=20270101', '2026-09-10', '2026-09-12'), null);
  assert.equal(nextOccurrence('FREQ=YEARLY;UNTIL=99991231', '2026-09-10', '2026-09-12'), '2027-09-10');
});

test('an overlong rule is refused before it is parsed', () => {
  assert.throws(() => nextOccurrence(`FREQ=DAILY;BYMONTHDAY=${Array.from({ length: 120 }, () => '1').join(',')}`, '2026-09-10', '2026-09-12'), /200 characters or fewer/);
});

test('the same bounds hold on the write path through openApp, whose validation hook is the production one', () => {
  // The MCP and REST fixtures stub the recurrence hook, so only openApp reaches this code from a
  // task write. The audit's reproduction was create_task with INTERVAL=-1 through openApp.
  const app = openApp({ dbPath: ':memory:' });
  try {
    const started = Date.now();
    assert.throws(() => app.store.createTask({ title: 'never', recurrence: 'FREQ=DAILY;INTERVAL=-1' }), /INTERVAL must be a whole number/);
    assert.throws(() => app.store.createTask({ title: 'never', recurrence: 'FREQ=DAILY;INTERVAL=0' }), /INTERVAL must be a whole number/);
    assert.throws(() => app.store.createTask({ title: 'never', recurrence: 'FREQ=SECONDLY' }), /FREQ must be/);
    assert.ok(Date.now() - started < 2000, `validation took ${Date.now() - started}ms`);
    const weekly = app.store.createTask({ title: 'fine', recurrence: 'FREQ=WEEKLY;BYDAY=MO' });
    assert.equal(weekly.recurrence, 'FREQ=WEEKLY;BYDAY=MO');
  } finally {
    app.close();
  }
});


// ---- the walk agrees with rrule wherever a rule is accepted

const DIFFERENTIAL: [string, string[]][] = [
  ['FREQ=DAILY', ['2026-09-10', '2024-02-28']],
  ['FREQ=DAILY;INTERVAL=3', ['2026-09-10']],
  ['FREQ=DAILY;BYDAY=MO,WE,FR', ['2026-09-10', '2026-09-12']],
  ['FREQ=DAILY;BYMONTH=2', ['2026-09-10', '2028-02-28']],
  ['FREQ=DAILY;BYMONTHDAY=31', ['2026-09-10', '2026-08-31']],
  ['FREQ=DAILY;BYMONTHDAY=-1', ['2026-09-10', '2026-02-28']],
  ['FREQ=DAILY;COUNT=3', ['2026-09-10']],
  ['FREQ=DAILY;UNTIL=20260912', ['2026-09-10', '2026-09-12']],
  ['FREQ=WEEKLY', ['2026-09-10', '2026-09-13']],
  ['FREQ=WEEKLY;INTERVAL=2', ['2026-09-10', '2026-09-13', '2026-09-14']],
  ['FREQ=WEEKLY;INTERVAL=2;WKST=SU;BYDAY=MO,SA', ['2026-09-10', '2026-09-13', '2026-09-14']],
  ['FREQ=WEEKLY;INTERVAL=3;WKST=SU', ['2026-09-10']],
  ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', ['2026-09-11', '2026-09-12', '2026-09-13']],
  ['FREQ=WEEKLY;BYDAY=SU', ['2026-09-10', '2026-09-13']],
  ['FREQ=WEEKLY;BYDAY=2TU', ['2026-09-10']],
  ['FREQ=WEEKLY;BYMONTHDAY=13;BYDAY=FR', ['2026-09-10']],
  ['FREQ=WEEKLY;BYMONTH=1', ['2026-09-10']],
  ['FREQ=MONTHLY', ['2026-09-10', '2026-01-31', '2026-01-30', '2026-02-29', '2024-02-29']],
  ['FREQ=MONTHLY;INTERVAL=2', ['2026-09-10', '2026-01-31']],
  ['FREQ=MONTHLY;INTERVAL=14', ['2026-09-10']],
  ['FREQ=MONTHLY;BYMONTHDAY=1,15', ['2026-09-10', '2026-09-15', '2026-09-01']],
  ['FREQ=MONTHLY;BYMONTHDAY=-1', ['2026-09-10', '2026-09-30']],
  ['FREQ=MONTHLY;BYMONTHDAY=-2,3', ['2026-09-10']],
  ['FREQ=MONTHLY;BYDAY=MO', ['2026-09-10', '2026-09-14']],
  ['FREQ=MONTHLY;BYDAY=2TU', ['2026-09-10', '2026-09-08', '2026-09-09']],
  ['FREQ=MONTHLY;BYDAY=-1FR', ['2026-09-10', '2026-09-25']],
  ['FREQ=MONTHLY;BYDAY=5MO', ['2026-09-10']],
  ['FREQ=MONTHLY;BYDAY=1MO,3WE', ['2026-09-10']],
  ['FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13', ['2026-09-10']],
  ['FREQ=MONTHLY;BYMONTH=3,6;BYMONTHDAY=15', ['2026-09-10']],
  ['FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=29', ['2026-09-10', '2028-02-29']],
  ['FREQ=MONTHLY;BYDAY=MO,2TU', ['2026-09-10']],
  ['FREQ=YEARLY', ['2026-09-10', '2024-02-29', '2026-12-31']],
  ['FREQ=YEARLY;INTERVAL=3', ['2026-09-10', '2024-02-29']],
  ['FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29', ['2026-09-10', '2024-02-29']],
  ['FREQ=YEARLY;BYMONTH=1,7', ['2026-09-10', '2026-01-31']],
  ['FREQ=YEARLY;BYMONTHDAY=1', ['2026-09-10']],
  ['FREQ=YEARLY;BYDAY=-1MO', ['2026-09-10', '2026-12-28']],
  ['FREQ=YEARLY;BYDAY=1MO', ['2026-09-10', '2026-01-05']],
  ['FREQ=YEARLY;BYDAY=53MO', ['2026-09-10']],
  ['FREQ=YEARLY;BYMONTH=11;BYDAY=4TH', ['2026-09-10', '2026-11-26']],
  ['FREQ=YEARLY;BYMONTH=5;BYDAY=-1MO', ['2026-09-10']],
  ['FREQ=YEARLY;BYDAY=FR;BYMONTHDAY=13', ['2026-09-10']],
  ['FREQ=YEARLY;BYDAY=MO;BYMONTH=2', ['2026-09-10']],
  ['FREQ=YEARLY;COUNT=2;INTERVAL=2', ['2026-09-10']],
  ['FREQ=YEARLY;UNTIL=20270101', ['2026-09-10', '2026-12-31']],
];

test('the walk gives the same next occurrence as rrule for every accepted rule shape', () => {
  let checked = 0;
  for (const [rule, starts] of DIFFERENTIAL) {
    for (const start of starts) {
      const dtstart = new Date(`${start}T00:00:00Z`);
      const reference = new RRule({ ...RRule.parseString(rule), dtstart });
      // rrule's own answer: the first occurrence strictly after DTSTART, in the same time frame as
      // nextOccurrence when today is the previous due date.
      const expected = reference.after(dtstart, false);
      const actual = nextOccurrence(rule, start, start);
      assert.equal(actual, expected ? expected.toISOString().slice(0, 10) : null, `${rule} from ${start}`);
      checked++;
    }
  }
  assert.ok(checked > 80);
});

test('the walk also agrees with rrule about occurrences at or after a later date', () => {
  for (const [rule, start, today] of [
    ['FREQ=WEEKLY;BYDAY=MO,TH', '2026-09-10', '2026-10-01'],
    ['FREQ=MONTHLY;BYDAY=2TU', '2026-09-10', '2027-03-01'],
    ['FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29', '2024-02-29', '2029-01-01'],
    ['FREQ=DAILY;INTERVAL=7;COUNT=3', '2026-09-10', '2026-09-25'],
    ['FREQ=DAILY;INTERVAL=7;COUNT=3', '2026-09-10', '2026-09-20'],
    ['FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=31', '2026-01-31', '2026-06-01'],
  ]) {
    const dtstart = new Date(`${start}T00:00:00Z`);
    const reference = new RRule({ ...RRule.parseString(rule), dtstart });
    const first = reference.after(dtstart, false);
    const todayDate = new Date(`${today}T00:00:00Z`);
    const expected = first && first < todayDate ? reference.after(todayDate, true) : first;
    assert.equal(nextOccurrence(rule, start, today), expected ? expected.toISOString().slice(0, 10) : null, `${rule} from ${start} on ${today}`);
  }
});

test('parts that are not supported, and ranges that make no sense, are refused with their name', () => {
  const cases: [string, RegExp][] = [
    ['FREQ=MONTHLY;BYSETPOS=2;BYDAY=MO', /BYSETPOS is not supported/],
    ['FREQ=YEARLY;BYWEEKNO=20', /BYWEEKNO is not supported/],
    ['FREQ=YEARLY;BYYEARDAY=100', /BYYEARDAY is not supported/],
    ['FREQ=DAILY;BYHOUR=9', /BYHOUR is not supported/],
    ['FREQ=DAILY;BYMINUTE=30', /BYMINUTE is not supported/],
    ['FREQ=DAILY;BYSECOND=0', /BYSECOND is not supported/],
    ['FREQ=YEARLY;BYMONTH=13', /BYMONTH must be a whole number from 1 to 12/],
    ['FREQ=MONTHLY;BYMONTHDAY=32', /BYMONTHDAY must be a whole number from -31 to 31/],
    ['FREQ=MONTHLY;BYMONTHDAY=0', /BYMONTHDAY/],
    ['FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30', /never come up/],
    ['FREQ=MONTHLY;BYDAY=2MO;BYMONTHDAY=1', /cannot be combined with BYMONTHDAY/],
    ['FREQ=MONTHLY;BYDAY=6MO', /between -5 and 5/],
    ['FREQ=YEARLY;BYMONTH=3;BYDAY=6MO', /between -5 and 5/],
    ['FREQ=YEARLY;BYDAY=54MO', /between -53 and 53/],
    ['FREQ=YEARLY;INTERVAL=11', /INTERVAL must be a whole number from 1 to 10/],
    ['FREQ=MONTHLY;INTERVAL=121', /INTERVAL must be a whole number from 1 to 120/],
    ['FREQ=WEEKLY;INTERVAL=54', /INTERVAL must be a whole number from 1 to 53/],
    ['FREQ=DAILY;INTERVAL=367', /INTERVAL must be a whole number from 1 to 366/],
  ];
  for (const [rule, message] of cases) {
    assert.throws(() => nextOccurrence(rule, '2026-09-10', '2026-09-12'), message, rule);
  }
});

test('a rule that is valid but never comes up again within the horizon ends the series at once', () => {
  // A plain and a positioned weekday together must both hold, as in rrule, which nothing satisfies.
  const started = Date.now();
  assert.equal(nextOccurrence('FREQ=MONTHLY;BYDAY=MO,2TU', '2026-09-10', '2026-09-12'), null);
  // Every third day landing on a February 29th depends on how the days count out; from this
  // start the first such day is 2204-02-29, at the far end of the walk, and it is found at once.
  assert.equal(nextOccurrence('FREQ=DAILY;INTERVAL=3;BYMONTH=2;BYMONTHDAY=29', '2026-09-11', '2026-09-12'), '2204-02-29');
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
});

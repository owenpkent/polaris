// Property tests for the recurrence engine (automation/recurrence.ts) and the COUNT helpers
// (core/recurrenceCount.ts). Rules are typed by the owner or sent by an agent, so any text must
// either give a date, end the series, or be refused with an "invalid ..." error, in bounded time.
//
// The harness is in dev/property.ts. Replay a failure with the seed and path it prints:
//   CC_PROPERTY_SEED=<seed> CC_PROPERTY_PATH=<path> node --test src/automation/recurrence.property.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { check, anyText } from '../dev/property.ts';
import { nextOccurrence, previewOccurrences } from './recurrence.ts';
import { remainingCount, withOneFewer } from '../core/recurrenceCount.ts';

const DAY = '2026-01-15';
const rule = fc.record({
  freq: fc.constantFrom('DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'),
  interval: fc.integer({ min: 1, max: 12 }),
  count: fc.option(fc.integer({ min: 2, max: 10 }), { nil: undefined }),
  byday: fc.option(fc.constantFrom('MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'), { nil: undefined }),
}).map((r) => [`FREQ=${r.freq}`, `INTERVAL=${r.freq === 'YEARLY' ? Math.min(r.interval, 10) : r.interval}`, r.count ? `COUNT=${r.count}` : '', r.byday && r.freq === 'WEEKLY' ? `BYDAY=${r.byday}` : '']
  .filter(Boolean).join(';'));
const ruleish = fc.oneof(
  anyText(),
  fc.array(fc.constantFrom('FREQ=DAILY', 'FREQ=WEEKLY', 'FREQ=MONTHLY', 'FREQ=YEARLY', 'INTERVAL=2', 'COUNT=3', 'UNTIL=20270101', 'BYDAY=MO', 'BYMONTHDAY=31', 'BYMONTH=2', 'WKST=SU', 'X-FROM=COMPLETION', 'daily', 'every 2 weeks'), { maxLength: 5 }).map((p) => p.join(';')),
);

test('property: any text gives a date, null, or an "invalid" error, in bounded time', () => {
  check(ruleish, (r) => {
    const start = Date.now();
    try {
      const next = nextOccurrence(r, DAY, DAY);
      assert.ok(next === null || /^\d{4}-\d{2}-\d{2}/.test(next), String(next));
    } catch (e) {
      assert.ok(e instanceof Error && e.message.startsWith('invalid '), String(e));
    }
    assert.ok(Date.now() - start < 2000, 'took too long');
  });
});

test('property: a valid rule gives null or a date after the due date and not before today', () => {
  check(rule, (r) => {
    const next = nextOccurrence(r, DAY, DAY);
    if (next !== null) assert.ok(next > DAY, `${next} for ${r}`);
  });
});

test('property: a preview is strictly increasing and COUNT=N leaves at most N-1 dates', () => {
  check(fc.tuple(rule, fc.integer({ min: 1, max: 8 })), ([r, n]) => {
    const dates = previewOccurrences(r, DAY, DAY, n);
    assert.ok(dates.length <= n);
    dates.forEach((d, i) => assert.ok(d > (i === 0 ? DAY : dates[i - 1]), `${d} for ${r}`));
    const count = remainingCount(r);
    if (count !== null) assert.ok(dates.length <= count - 1, `${dates.length} dates for COUNT=${count}`);
  });
});

test('property: withOneFewer lowers COUNT by one, or leaves the rule alone at COUNT 1 or none', () => {
  check(fc.oneof(rule, anyText()), (r) => {
    const left = remainingCount(r);
    if (left === null || left === 1) assert.equal(withOneFewer(r), r);
    else assert.equal(remainingCount(withOneFewer(r)), left - 1);
  });
});

test('property: withOneFewer never throws', () => {
  check(anyText(), (r) => { withOneFewer(r); });
});

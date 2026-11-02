import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remainingCount, withOneFewer } from './recurrenceCount.ts';

test('remainingCount reads COUNT wherever it sits, or null without one', () => {
  assert.equal(remainingCount('FREQ=DAILY;COUNT=5'), 5);
  assert.equal(remainingCount('COUNT=2;FREQ=DAILY'), 2);
  assert.equal(remainingCount('RRULE:COUNT=7;FREQ=WEEKLY'), 7);
  assert.equal(remainingCount('freq=daily;count=3;x-from=completion'), 3);
  assert.equal(remainingCount('FREQ=DAILY;UNTIL=20261231'), null);
  assert.equal(remainingCount('weekly'), null);
  assert.equal(remainingCount('FREQ=DAILY;XCOUNT=3'), null);
});

test('withOneFewer lowers COUNT by one and leaves everything else as written', () => {
  assert.equal(withOneFewer('FREQ=DAILY;COUNT=5'), 'FREQ=DAILY;COUNT=4');
  assert.equal(withOneFewer('COUNT=10;FREQ=DAILY'), 'COUNT=9;FREQ=DAILY');
  assert.equal(withOneFewer('RRULE:COUNT=2;FREQ=WEEKLY;BYDAY=MO'), 'RRULE:COUNT=1;FREQ=WEEKLY;BYDAY=MO');
  assert.equal(withOneFewer('FREQ=DAILY;count=3;X-FROM=COMPLETION'), 'FREQ=DAILY;count=2;X-FROM=COMPLETION');
});

// Validation refuses both shapes below; if one ever got through, the store would still read the
// COUNT rrule reads (the last one) rather than one the engine ignores, and no sign at all.
test('COUNT is read as rrule reads it: the last of two, and never with a sign', () => {
  assert.equal(remainingCount('FREQ=DAILY;COUNT=2;COUNT=5'), 5);
  assert.equal(withOneFewer('FREQ=DAILY;COUNT=2;COUNT=5'), 'FREQ=DAILY;COUNT=2;COUNT=4');
  assert.equal(remainingCount('FREQ=DAILY;COUNT=+2'), null);
});

// Validation refuses spaces around a part; read them anyway rather than miss the COUNT.
test('a COUNT with spaces around it is still read and lowered', () => {
  assert.equal(remainingCount('FREQ=DAILY;COUNT=2 ;X-FROM=COMPLETION'), 2);
  assert.equal(withOneFewer('FREQ=DAILY; COUNT = 3 ;X-FROM=COMPLETION'), 'FREQ=DAILY;COUNT=2;X-FROM=COMPLETION');
});

test('withOneFewer leaves COUNT=1 and a rule with no COUNT alone', () => {
  assert.equal(withOneFewer('FREQ=DAILY;COUNT=1'), 'FREQ=DAILY;COUNT=1');
  assert.equal(withOneFewer('FREQ=DAILY'), 'FREQ=DAILY');
  assert.equal(withOneFewer('every 2 weeks'), 'every 2 weeks');
});

// Found by fuzz/targets/recurrence.fuzz.ts: Number() of a 100-digit COUNT is 2e99, and lowering it
// wrote "COUNT=2.02402e+99", which the next read did not recognise as a COUNT.
test('regression: a COUNT past the safe integer range is not a COUNT, so the rule is left as written', () => {
  const huge = `FREQ=DAILY;COUNT=${'2024020000'.repeat(10)}`;
  assert.equal(remainingCount(huge), null);
  assert.equal(withOneFewer(huge), huge);
  const edge = `FREQ=DAILY;COUNT=${Number.MAX_SAFE_INTEGER}`;
  assert.equal(remainingCount(withOneFewer(edge)), Number.MAX_SAFE_INTEGER - 1);
});

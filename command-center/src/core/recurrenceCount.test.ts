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

test('withOneFewer leaves COUNT=1 and a rule with no COUNT alone', () => {
  assert.equal(withOneFewer('FREQ=DAILY;COUNT=1'), 'FREQ=DAILY;COUNT=1');
  assert.equal(withOneFewer('FREQ=DAILY'), 'FREQ=DAILY');
  assert.equal(withOneFewer('every 2 weeks'), 'every 2 weeks');
});

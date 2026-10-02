import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays } from './dates.ts';

test('adds a single day', () => {
  assert.equal(addDays('2026-09-10', 1), '2026-09-11');
});

test('subtracts a day for a negative offset', () => {
  assert.equal(addDays('2026-09-10', -1), '2026-09-09');
});

test('zero days is a no-op', () => {
  assert.equal(addDays('2026-09-10', 0), '2026-09-10');
});

test('rolls over the end of a month', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
});

test('rolls over the end of a year', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('leap day: Feb 29 exists in a leap year', () => {
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
});

test('leap day: Feb 29 does not exist in a non-leap year', () => {
  assert.equal(addDays('2023-02-28', 1), '2023-03-01');
});

test('large positive offset across a non-leap year', () => {
  assert.equal(addDays('2026-01-01', 365), '2027-01-01');
});

test('large negative offset walks back across a year boundary', () => {
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
});

test('an invalid date string throws rather than silently returning garbage', () => {
  assert.throws(() => addDays('not-a-date', 1));
});

test('a full ISO datetime is not a supported input and throws', () => {
  // The module contract is plain YYYY-MM-DD calendar dates; passing a datetime double-appends
  // "T00:00:00Z" (dates.ts does not slice its input the way mcp/shared.ts's addDays does).
  assert.throws(() => addDays('2026-09-10T09:30:00Z', 1));
});

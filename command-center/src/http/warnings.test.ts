import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobWarnings } from './warnings.ts';

const now = new Date('2026-09-21T12:00:00Z');
const ok = { lastRunAt: '2026-09-21T03:15:00Z', lastError: null, running: false };

test('healthy jobs and a fresh backup raise nothing', () => {
  assert.deepEqual(jobWarnings({ import: ok, backup: ok }, now), []);
});

test('a failing job is named with the first line of its error only', () => {
  const w = jobWarnings({ github: { ...ok, lastError: 'rate limited\nstack line' }, backup: ok }, now);
  assert.deepEqual(w, [{ job: 'github', message: 'The github job is failing: rate limited' }]);
});

test('a backup older than 36 hours is stale, one from last night is not', () => {
  assert.deepEqual(jobWarnings({ backup: { ...ok, lastRunAt: '2026-09-20T03:15:00Z' } }, now), []);
  const w = jobWarnings({ backup: { ...ok, lastRunAt: '2026-09-18T03:15:00Z' } }, now);
  assert.deepEqual(w, [{ job: 'backup', message: 'The last database backup is 3 day(s) old.' }]);
});

test('a backup that never ran is a warning, unless it is running now', () => {
  assert.equal(jobWarnings({ backup: { lastRunAt: null, lastError: null, running: false } }, now).length, 1);
  assert.deepEqual(jobWarnings({ backup: { lastRunAt: null, lastError: null, running: true } }, now), []);
});

test('a failing backup is reported once, as failing', () => {
  const w = jobWarnings({ backup: { lastRunAt: null, lastError: 'disk full', running: false } }, now);
  assert.deepEqual(w.map((x) => x.message), ['The backup job is failing: disk full']);
});

test('a daemon started without the backup job says nothing about backups', () => {
  assert.deepEqual(jobWarnings({ import: ok }, now), []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyUpdateStatus, UPDATER_STOPPED_PREFIX, type UpdateStatus } from '../update/status.ts';
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

const update = (extra: Partial<UpdateStatus>): UpdateStatus => ({ ...emptyUpdateStatus(), updaterInstalled: true, lastRunAt: '2026-09-21T11:58:00Z', running: '2.0.0', ...extra });

test('the update status file: no file, a success, or a run in progress raise nothing', () => {
  assert.deepEqual(jobWarnings({ backup: ok }, now), [], 'no status given');
  assert.deepEqual(jobWarnings({ backup: ok }, now, emptyUpdateStatus()), []);
  assert.deepEqual(jobWarnings({ backup: ok }, now, update({ lastResult: { ok: true, message: 'Updated to 2.1.0', at: '2026-09-21T04:05:00Z', version: '2.1.0' } })), []);
  assert.deepEqual(jobWarnings({ backup: ok }, now, update({ request: { id: 'up_1', state: 'picked_up', message: 'Updating', finishedAt: null } })), []);
});

test('a failed update is a warning, whether by hand or by the updater, until the next result replaces it', () => {
  const failed = update({ lastResult: { ok: false, message: 'Rolled back: the build failed', at: '2026-09-21T04:05:00Z', version: '2.0.0' }, failures: 1, backoffUntil: '2026-09-22T04:05:00Z' });
  assert.deepEqual(jobWarnings({ backup: ok }, now, failed), [{ job: 'update', message: 'The last update failed: Rolled back: the build failed' }]);
  const byHand = update({ updaterInstalled: false, lastResult: { ok: false, message: 'Rolled back: the health check failed', at: '2026-09-21T04:05:00Z', version: '2.0.0' } });
  assert.deepEqual(jobWarnings({}, now, byHand).map((w) => w.message), ['The last update failed: Rolled back: the health check failed']);
  // Beside a failing job, in the same list.
  const both = jobWarnings({ github: { ...ok, lastError: 'rate limited' } }, now, failed);
  assert.deepEqual(both.map((w) => w.job), ['github', 'update']);
});

test('a stopped updater says so in its own words: the stopped message with no backoff', () => {
  const message = `${UPDATER_STOPPED_PREFIX}: 3 updates in a row failed, the last one: Rolled back: the build failed. Run cc update --release by hand, which clears the count.`;
  const stopped = update({ lastResult: { ok: false, message, at: '2026-09-21T04:05:00Z', version: '2.0.0' }, failures: 3, backoffUntil: null });
  assert.deepEqual(jobWarnings({ backup: ok }, now, stopped), [{ job: 'update', message }]);
  // The same words while a backoff is still running are a plain failure, not a stop.
  const pausedWords = update({ lastResult: { ok: false, message, at: '2026-09-21T04:05:00Z', version: '2.0.0' }, failures: 2, backoffUntil: '2026-09-24T04:05:00Z' });
  assert.equal(jobWarnings({}, now, pausedWords)[0].message, `The last update failed: ${message}`);
});

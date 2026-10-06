import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  UPDATE_STATUS_VERSION,
  emptyUpdateStatus,
  readUpdateStatus,
  updateStatusPath,
  updaterInstalled,
  writeUpdateStatus,
} from './status.ts';

function scratchDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'cc-update-status-')), 'constellation.db');
}

test('a missing status file reads as the empty status', () => {
  const dbPath = scratchDb();
  assert.deepEqual(readUpdateStatus(dbPath), emptyUpdateStatus());
  assert.equal(updateStatusPath(dbPath), join(dirname(dbPath), 'update-status.json'));
});

test('a written status reads back whole, with no partial file left behind', () => {
  const dbPath = scratchDb();
  const status = { ...emptyUpdateStatus(), updaterInstalled: true, lastRunAt: '2026-10-06T04:00:00.000Z', running: '2.0.0' };
  writeUpdateStatus(dbPath, status);
  assert.deepEqual(readUpdateStatus(dbPath), status);
  assert.deepEqual(readdirSync(join(dbPath, '..')), ['update-status.json']);
  assert.equal(JSON.parse(readFileSync(updateStatusPath(dbPath), 'utf8')).version, UPDATE_STATUS_VERSION);
});

test('a malformed or foreign file reads as the empty status', () => {
  const dbPath = scratchDb();
  writeFileSync(updateStatusPath(dbPath), '{not json');
  assert.deepEqual(readUpdateStatus(dbPath), emptyUpdateStatus());
  writeFileSync(updateStatusPath(dbPath), JSON.stringify({ version: 99, updaterInstalled: true }));
  assert.deepEqual(readUpdateStatus(dbPath), emptyUpdateStatus());
  writeFileSync(updateStatusPath(dbPath), JSON.stringify({ version: UPDATE_STATUS_VERSION }));
  assert.deepEqual(readUpdateStatus(dbPath), emptyUpdateStatus());
});

test('the updater counts as installed only on a recent heartbeat', () => {
  const now = new Date('2026-10-06T04:10:00.000Z');
  const base = { ...emptyUpdateStatus(), updaterInstalled: true };
  assert.equal(updaterInstalled(base, now), false, 'no heartbeat yet');
  assert.equal(updaterInstalled({ ...base, lastRunAt: '2026-10-06T04:00:00.000Z' }, now), true);
  assert.equal(updaterInstalled({ ...base, lastRunAt: '2026-10-06T03:00:00.000Z' }, now), false, 'an hour old');
  assert.equal(updaterInstalled({ ...base, updaterInstalled: false, lastRunAt: '2026-10-06T04:09:00.000Z' }, now), false, 'a manual run');
  assert.equal(updaterInstalled({ ...base, lastRunAt: 'not a date' }, now), false);
});

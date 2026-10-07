// The write barrier on its own (barrier.ts), and the CLI's gate on it: a command that opens the
// store is refused while a fresh barrier stands, with the message and exit 1, and `cc backup
// check`, which never opens the store, is not. The CLI is run as a child process, since its gate
// is in cli.ts's main.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../core/index.ts';
import { assertNotUpdating, BARRIER_MAX_AGE_MS, barrierPath, pidAlive, readBarrier, removeBarrier, UPDATE_BARRIER_FILE, UpdateInProgressError, updatingMessage, writeBarrier } from './barrier.ts';

const here = dirname(fileURLToPath(import.meta.url));

function scratch(t: { after(fn: () => void): void }): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cc-barrier-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, dbPath: join(dir, 'data', 'constellation.db') };
}

test('the barrier is written next to the database, owner-only, with this pid, the moment, and the version', (t) => {
  const { dbPath } = scratch(t);
  const written = writeBarrier(dbPath, '2.1.0');
  const file = barrierPath(dbPath);
  assert.equal(file, join(dirname(dbPath), UPDATE_BARRIER_FILE));
  assert.ok(existsSync(file));
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), written);
  assert.equal(written.pid, process.pid);
  assert.ok(Math.abs(Date.now() - Date.parse(written.startedAt)) < 5000, 'stamped with the wall clock');
  assert.deepEqual(readBarrier(dbPath), written);
  assert.equal(updatingMessage(written), `Polaris is being updated (started ${written.startedAt}). Try again in a minute.`);
  assert.throws(() => assertNotUpdating(dbPath), (e: unknown) => e instanceof UpdateInProgressError && e.message === updatingMessage(written));
  removeBarrier(dbPath);
  assert.equal(existsSync(file), false);
  assert.equal(readBarrier(dbPath), null);
  assert.doesNotThrow(() => assertNotUpdating(dbPath));
  removeBarrier(dbPath);
  assert.equal(readBarrier(':memory:'), null, 'an in-memory database has no folder for one');
});

test('a stale barrier reads as none and is removed: a dead pid, two hours old, or unreadable', (t) => {
  const { dbPath } = scratch(t);
  const file = barrierPath(dbPath);
  mkdirSync(dirname(file), { recursive: true });
  const fresh = { pid: process.pid, startedAt: new Date().toISOString(), version: '2.1.0' };

  writeFileSync(file, JSON.stringify(fresh));
  assert.equal(readBarrier(dbPath, { alive: () => false }), null);
  assert.equal(existsSync(file), false, 'removed by the reader that found it stale');

  writeFileSync(file, JSON.stringify(fresh));
  assert.deepEqual(readBarrier(dbPath, { now: () => Date.parse(fresh.startedAt) + BARRIER_MAX_AGE_MS }), fresh, 'two hours exactly is still fresh');
  assert.equal(readBarrier(dbPath, { now: () => Date.parse(fresh.startedAt) + BARRIER_MAX_AGE_MS + 1 }), null, 'a moment more is stale');
  assert.equal(existsSync(file), false);

  for (const text of ['not json', '{}', JSON.stringify({ ...fresh, pid: 'x' }), JSON.stringify({ ...fresh, startedAt: 'never' }), JSON.stringify({ ...fresh, pid: 0 })]) {
    writeFileSync(file, text);
    assert.equal(readBarrier(dbPath), null, text);
    assert.equal(existsSync(file), false, text);
  }

  // A real dead pid: a child that has already exited.
  const child = spawnSync(process.execPath, ['-e', '0'], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.ok(child.pid && !pidAlive(child.pid), 'the child is gone');
  assert.ok(pidAlive(process.pid), 'this process is here');
  writeFileSync(file, JSON.stringify({ ...fresh, pid: child.pid }));
  assert.equal(readBarrier(dbPath), null);
  assert.equal(existsSync(file), false);
});

test('the CLI refuses to open the store behind a fresh barrier, with the message and exit 1, and cc backup check is not blocked', (t) => {
  const { dir, dbPath } = scratch(t);
  mkdirSync(dirname(dbPath), { recursive: true });
  const store = openStore(dbPath);
  store.db.close();
  writeBarrier(dbPath, '2.1.0');
  const cli = (args: string[]) => spawnSync(process.execPath, [join(here, '..', 'cli.ts'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, CC_DB: dbPath, CC_BACKUP_DIR: join(dir, 'backups'), CC_SECRETS_DIR: join(dir, 'secrets') },
  });

  const add = cli(['add', 'written during the update']);
  assert.equal(add.status, 1, add.stderr);
  assert.match(add.stderr, /^Polaris is being updated \(started \S+\)\. Try again in a minute\.$/m);
  assert.ok(!add.stderr.includes('    at '), 'the message, not a stack');
  const after = openStore(dbPath);
  try {
    assert.deepEqual(after.searchAllTasks(), [], 'nothing was written');
  } finally {
    after.db.close();
  }
  assert.ok(existsSync(barrierPath(dbPath)), 'a refused command leaves the barrier to the update that holds it');

  const check = cli(['backup', 'check']);
  assert.ok(!`${check.stdout}\n${check.stderr}`.includes('Polaris is being updated'), `backup check never opens the store: ${check.stderr}`);

  removeBarrier(dbPath);
  const added = cli(['add', 'written after the update']);
  assert.equal(added.status, 0, added.stderr);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { countRows, inspectDatabaseFile, openStore } from './index.ts';
import { MIGRATIONS } from './schema.ts';

function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'cc-db-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('countRows and backupFingerprint count tasks, projects, and events, and report the schema version', () => {
  const store = openStore(':memory:');
  try {
    assert.deepEqual(countRows(store.db), { tasks: 0, projects: 0, events: 0 });
    const project = store.createProject({ name: 'P' });
    store.createTask({ title: 'a', projectId: project.id });
    store.createTask({ title: 'b', projectId: project.id });
    const print = store.backupFingerprint();
    assert.equal(print.schemaVersion, MIGRATIONS.length);
    assert.equal(print.counts.tasks, 2);
    assert.equal(print.counts.projects, 1);
    assert.ok(print.counts.events >= 3, 'each create is an event');
    assert.deepEqual(print.counts, countRows(store.db));
  } finally {
    store.db.close();
  }
});

test('inspectDatabaseFile: a sound copy reports ok, no violations, and the same fingerprint as its source', (t) => {
  const dir = tempDir(t);
  const store = openStore(':memory:');
  try {
    const project = store.createProject({ name: 'P' });
    store.createTask({ title: 'a', projectId: project.id });
    const file = join(dir, 'copy.db');
    store.backupTo(file);
    const found = inspectDatabaseFile(file);
    assert.deepEqual(found.integrity, ['ok']);
    assert.equal(found.foreignKeyViolations, 0);
    assert.deepEqual({ schemaVersion: found.schemaVersion, counts: found.counts }, store.backupFingerprint());
  } finally {
    store.db.close();
  }
});

test('inspectDatabaseFile only reads: no -wal or -shm appears, and an old schema is reported, not migrated', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'old.db');
  // A database from before the newest migration: everything but the last one applied.
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
  for (const sql of MIGRATIONS.slice(0, -1)) old.exec(sql);
  old.prepare('INSERT INTO schema_version (version) VALUES (?)').run(MIGRATIONS.length - 1);
  old.close();

  assert.equal(inspectDatabaseFile(file).schemaVersion, MIGRATIONS.length - 1);
  assert.equal(inspectDatabaseFile(file).schemaVersion, MIGRATIONS.length - 1, 'still unmigrated on a second look');
  assert.deepEqual(readdirSync(dir), ['old.db']);
});

test('inspectDatabaseFile: foreign key violations are counted', (t) => {
  const dir = tempDir(t);
  const store = openStore(':memory:');
  const file = join(dir, 'copy.db');
  try {
    store.backupTo(file);
  } finally {
    store.db.close();
  }
  // With enforcement off, as any other SQLite tool would open it, a broken row gets in.
  const raw = new DatabaseSync(file, { enableForeignKeyConstraints: false });
  raw.prepare('INSERT INTO sections (id, project_id, name, position) VALUES (?, ?, ?, ?)').run('s_orphan', 'p_missing', 'Orphan', 0);
  raw.close();
  const found = inspectDatabaseFile(file);
  assert.deepEqual(found.integrity, ['ok'], 'the file itself is sound');
  assert.equal(found.foreignKeyViolations, 1);
});

test('inspectDatabaseFile throws for a missing file and for a file that is not a database', (t) => {
  const dir = tempDir(t);
  assert.throws(() => inspectDatabaseFile(join(dir, 'missing.db')));
  const junk = join(dir, 'junk.db');
  writeFileSync(junk, 'not a database at all, just text long enough to be read as a header');
  assert.throws(() => inspectDatabaseFile(junk));
  assert.deepEqual(readdirSync(dir), ['junk.db'], 'a missing file is not created by looking for it');
});

// A database saved from a running daemon is in WAL mode. SQLite's own read-only open creates
// -wal and -shm beside such a file, so these are the cases the VACUUM INTO copies never show.
function closedWalDatabase(dir: string): string {
  const file = join(dir, 'archived.db');
  const store = openStore(file);
  const project = store.createProject({ name: 'P' });
  store.createTask({ title: 'archived', projectId: project.id });
  store.db.close(); // checkpoints, and removes the sidecars
  return file;
}

test('inspectDatabaseFile: a closed WAL-mode database is read without adding files beside it', (t) => {
  const dir = tempDir(t);
  const file = closedWalDatabase(dir);
  assert.deepEqual(readdirSync(dir), ['archived.db']);
  const found = inspectDatabaseFile(file);
  assert.deepEqual(found.integrity, ['ok']);
  assert.equal(found.counts.tasks, 1);
  assert.deepEqual(readdirSync(dir), ['archived.db']);
});

test('inspectDatabaseFile: rows still in the -wal of a database in use are counted', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'live.db');
  const store = openStore(file);
  try {
    const project = store.createProject({ name: 'P' });
    store.createTask({ title: 'not checkpointed yet', projectId: project.id });
    assert.ok(readdirSync(dir).includes('live.db-wal'));
    assert.equal(inspectDatabaseFile(file).counts.tasks, 1);
  } finally {
    store.db.close();
  }
});

// Windows has no folder permission bits to take away.
test('inspectDatabaseFile: works in a folder that cannot be written', { skip: process.platform === 'win32' }, (t) => {
  const dir = tempDir(t);
  const file = closedWalDatabase(dir);
  chmodSync(dir, 0o555);
  try {
    assert.equal(inspectDatabaseFile(file).counts.tasks, 1);
    assert.deepEqual(readdirSync(dir), ['archived.db']);
  } finally {
    // Restore before the tempDir hook removes the folder: after hooks run in registration order.
    chmodSync(dir, 0o755);
  }
});

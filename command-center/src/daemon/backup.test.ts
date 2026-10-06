import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../core/index.ts';
import { windowsDpapiSecretStore } from '../ingest/secrets.ts';
import { backupDatabase, backupDir, inspectBackup, isSnapshotFile, listSnapshots, newestBackup, restoreDatabaseFile, snapshotDatabase, snapshotName, verifyBackup } from './backup.ts';
import { decryptBuffer, isEncryptedBackup } from './backupCrypto.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'cc-backup-'));
}

test('backupDatabase writes a copy that opens and holds the same tasks', () => {
  const dir = tempDir();
  const store = openStore(':memory:');
  try {
    const project = store.createProject({ name: 'Backup test' });
    store.createTask({ title: 'Survives the backup', projectId: project.id });
    const { file, removed } = backupDatabase(store, dir, '2026-09-21');
    assert.equal(file, join(dir, 'constellation-2026-09-21.db'));
    assert.deepEqual(removed, []);

    const copy = openStore(file);
    try {
      assert.deepEqual(copy.searchAllTasks().map((t) => t.title), ['Survives the backup']);
    } finally {
      copy.db.close();
    }
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a second backup on the same day replaces the first', () => {
  const dir = tempDir();
  const store = openStore(':memory:');
  try {
    backupDatabase(store, dir, '2026-09-21');
    backupDatabase(store, dir, '2026-09-21');
    assert.deepEqual(readdirSync(dir), ['constellation-2026-09-21.db']);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// The daemon's nightly run and `cc sync backup` in another process can overlap. This is that
// overlap at its worst: attempt B runs start to finish while A is between making its copy and
// publishing it. Each stages on the local disk and publishes through a name of its own.
test('two overlapping attempts both succeed and leave one readable copy and nothing else', () => {
  const dir = tempDir();
  const store = openStore(':memory:');
  try {
    const project = store.createProject({ name: 'P' });
    store.createTask({ title: 'kept', projectId: project.id });
    const realBackupTo = store.backupTo.bind(store);
    let nestedResult: string | undefined;
    store.backupTo = (file: string) => {
      realBackupTo(file);
      if (nestedResult !== undefined) return;
      nestedResult = 'running';
      nestedResult = backupDatabase(store, dir, '2026-09-21').file;
    };
    const a = backupDatabase(store, dir, '2026-09-21');

    assert.equal(nestedResult, a.file, 'B ran inside A and published the same dated name');
    assert.deepEqual(readdirSync(dir), ['constellation-2026-09-21.db']);
    const copy = openStore(a.file);
    try {
      assert.deepEqual(copy.searchAllTasks().map((t) => t.title), ['kept']);
    } finally {
      copy.db.close();
    }
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a staging file is only cleared once it is a day old: a younger one may belong to a live attempt', () => {
  const dir = tempDir();
  const store = openStore(':memory:');
  try {
    const young = join(dir, 'constellation-2026-09-21.db.4242.aaaaaa.partial');
    const old = join(dir, 'constellation-2026-09-19.db.4242.bbbbbb.partial');
    writeFileSync(young, 'in use');
    writeFileSync(old, 'left by a crash');
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60_000);
    utimesSync(old, twoDaysAgo, twoDaysAgo);
    backupDatabase(store, dir, '2026-09-21');
    assert.deepEqual(readdirSync(dir).sort(), ['constellation-2026-09-21.db', 'constellation-2026-09-21.db.4242.aaaaaa.partial']);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only the newest `keep` dated copies stay, and other files are never touched', () => {
  const dir = tempDir();
  const store = openStore(':memory:');
  try {
    writeFileSync(join(dir, 'notes.txt'), 'not a backup');
    writeFileSync(join(dir, 'constellation-manual.db'), 'not a dated backup');
    for (const day of ['2026-09-18', '2026-09-19', '2026-09-20']) backupDatabase(store, dir, day, 3);
    const { removed } = backupDatabase(store, dir, '2026-09-21', 3);
    assert.deepEqual(removed, ['constellation-2026-09-18.db']);
    assert.deepEqual(readdirSync(dir).sort(), [
      'constellation-2026-09-19.db', 'constellation-2026-09-20.db', 'constellation-2026-09-21.db',
      'constellation-manual.db', 'notes.txt',
    ]);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keep below 1 is refused before anything is written', () => {
  const dir = tempDir();
  const store = openStore(':memory:');
  try {
    assert.throws(() => backupDatabase(store, dir, '2026-09-21', 0), /keep must be/);
    assert.equal(existsSync(join(dir, 'constellation-2026-09-21.db')), false);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- verification ----

test('verifyBackup: a sound copy has no problems, and a copy taken while another process wrote is accepted', () => {
  const dir = tempDir();
  const store = openStore(':memory:');
  try {
    const project = store.createProject({ name: 'P' });
    store.createTask({ title: 'one', projectId: project.id });
    const before = store.backupFingerprint();
    const { file } = backupDatabase(store, dir, '2026-09-21');
    assert.deepEqual(verifyBackup(file, before), []);

    store.createTask({ title: 'written after the copy', projectId: project.id });
    assert.deepEqual(verifyBackup(file, before, store.backupFingerprint()), []);
    // The same copy judged against only the later state is short of rows.
    assert.match(verifyBackup(file, store.backupFingerprint()).join('; '), /tasks: 1 rows, expected 2/);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyBackup: a file that is not a database, and a missing file, are reported and never thrown', () => {
  const dir = tempDir();
  const store = openStore(':memory:');
  try {
    const junk = join(dir, 'junk.db');
    writeFileSync(junk, 'this is not a database, it only has the right name');
    assert.equal(verifyBackup(junk, store.backupFingerprint()).length, 1);
    assert.match(verifyBackup(join(dir, 'missing.db'), store.backupFingerprint())[0], /cannot be opened/);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyBackup: a copy from another schema version is a problem', () => {
  const dir = tempDir();
  const store = openStore(':memory:');
  try {
    const { file } = backupDatabase(store, dir, '2026-09-21');
    const live = store.backupFingerprint();
    assert.match(verifyBackup(file, { ...live, schemaVersion: live.schemaVersion + 1 }).join(), /schema version/);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backupDatabase: a copy that fails its check is deleted, the job fails, and the previous good copy stays', () => {
  const dir = tempDir();
  const store = openStore(':memory:');
  try {
    backupDatabase(store, dir, '2026-09-20');
    store.backupTo = (file: string) => writeFileSync(file, 'disk went bad halfway');
    assert.throws(() => backupDatabase(store, dir, '2026-09-21', 1), /failed its check and was deleted/);
    assert.deepEqual(readdirSync(dir), ['constellation-2026-09-20.db']);
    assert.equal(newestBackup(dir), join(dir, 'constellation-2026-09-20.db'));
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- where backups live ----

test('backupDir: CC_BACKUP_DIR wins, the default is next to the database, and an in-memory database has none', () => {
  assert.equal(backupDir(join('data', 'constellation.db'), {}), join('data', 'backups'));
  assert.equal(backupDir(join('data', 'constellation.db'), { CC_BACKUP_DIR: 'D:/synced' }), 'D:/synced');
  assert.equal(backupDir(':memory:', {}), undefined);
  assert.equal(backupDir(':memory:', { CC_BACKUP_DIR: 'D:/synced' }), 'D:/synced');
});

test('newestBackup: the latest dated copy by name, ignoring partial and undated files, undefined when there is none', () => {
  const dir = tempDir();
  try {
    assert.equal(newestBackup(join(dir, 'no-such-folder')), undefined);
    assert.equal(newestBackup(dir), undefined);
    for (const f of ['constellation-2026-09-09.db', 'constellation-2026-09-21.db', 'constellation-2026-09-22.db.partial', 'constellation-manual.db', 'zzz.db']) {
      writeFileSync(join(dir, f), '');
    }
    assert.equal(newestBackup(dir), join(dir, 'constellation-2026-09-21.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- encrypted backups ----

const ENC = { passphrase: 'a long enough passphrase', logN: 10 };

test('with a passphrase the published copy is encrypted, opens with it, and holds the same tasks', () => {
  const dir = tempDir();
  const store = openStore(':memory:');
  try {
    const project = store.createProject({ name: 'Secret project' });
    store.createTask({ title: 'a title nobody else should read', projectId: project.id });
    const { file } = backupDatabase(store, dir, '2026-09-21', 14, new Date(), ENC);

    assert.equal(file, join(dir, 'constellation-2026-09-21.db.enc'));
    assert.deepEqual(readdirSync(dir), ['constellation-2026-09-21.db.enc']);
    assert.equal(isEncryptedBackup(file), true);
    assert.equal(readFileSync(file).includes('nobody else should read'), false);
    assert.equal(decryptBuffer(file, ENC.passphrase).subarray(0, 15).toString(), 'SQLite format 3');
    assert.equal(inspectBackup(file, ENC.passphrase).counts.tasks, 1);
    assert.throws(() => inspectBackup(file), /encrypted and no passphrase/);
    assert.throws(() => inspectBackup(file, 'the wrong passphrase'), /passphrase is wrong/);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no readable database ever appears in the backup folder while encrypting', () => {
  const dir = tempDir();
  const store = openStore(':memory:');
  try {
    const realBackupTo = store.backupTo.bind(store);
    let stagedIn = '';
    let seenInDir: string[] = ['not looked yet'];
    store.backupTo = (file: string) => {
      realBackupTo(file);
      stagedIn = file;
      seenInDir = readdirSync(dir);
    };
    backupDatabase(store, dir, '2026-09-21', 14, new Date(), ENC);
    assert.deepEqual(seenInDir, [], 'the readable copy was staged somewhere else');
    assert.equal(stagedIn.startsWith(dir), false);
    assert.equal(existsSync(stagedIn), false, 'and it is gone afterwards');
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('turning encryption on replaces the plain copy of that day, and turning it off replaces the encrypted one', () => {
  const dir = tempDir();
  const store = openStore(':memory:');
  try {
    backupDatabase(store, dir, '2026-09-21');
    backupDatabase(store, dir, '2026-09-21', 14, new Date(), ENC);
    assert.deepEqual(readdirSync(dir), ['constellation-2026-09-21.db.enc']);
    backupDatabase(store, dir, '2026-09-21');
    assert.deepEqual(readdirSync(dir), ['constellation-2026-09-21.db']);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retention and newestBackup count plain and encrypted copies alike', () => {
  const dir = tempDir();
  const store = openStore(':memory:');
  try {
    backupDatabase(store, dir, '2026-09-19', 2);
    backupDatabase(store, dir, '2026-09-20', 2, new Date(), ENC);
    const { removed } = backupDatabase(store, dir, '2026-09-21', 2, new Date(), ENC);
    assert.deepEqual(removed, ['constellation-2026-09-19.db']);
    assert.deepEqual(readdirSync(dir).sort(), ['constellation-2026-09-20.db.enc', 'constellation-2026-09-21.db.enc']);
    assert.equal(newestBackup(dir), join(dir, 'constellation-2026-09-21.db.enc'));
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed encrypted backup leaves nothing behind in the folder or on the local disk', () => {
  const dir = tempDir();
  const store = openStore(':memory:');
  try {
    let stagedIn = '';
    store.backupTo = (file: string) => { stagedIn = file; writeFileSync(file, 'disk went bad halfway'); };
    assert.throws(() => backupDatabase(store, dir, '2026-09-21', 14, new Date(), ENC), /failed its check/);
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(existsSync(stagedIn), false);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- publication under a lock ----

// The window the lock closes: A has published today's plain copy and is about to remove the other
// format's copy of the day, when B, which read the secret store after encryption was turned on,
// publishes the encrypted copy and removes A's. Without the lock, A then removes B's, both report
// success, and the folder is empty.
test('two attempts in different modes, one inside the other, end with exactly one copy that can be restored', () => {
  const dir = tempDir();
  const store = openStore(':memory:');
  try {
    const project = store.createProject({ name: 'P' });
    store.createTask({ title: 'kept', projectId: project.id });
    const realBackupTo = store.backupTo.bind(store);
    let inner: string | undefined;
    store.backupTo = (file: string) => {
      realBackupTo(file);
      if (inner !== undefined) return;
      inner = 'running';
      inner = backupDatabase(store, dir, '2026-09-21', 14, new Date(), ENC).file;
    };
    const outer = backupDatabase(store, dir, '2026-09-21');

    assert.equal(inner, join(dir, 'constellation-2026-09-21.db.enc'));
    assert.equal(outer.file, join(dir, 'constellation-2026-09-21.db'));
    const left = readdirSync(dir);
    assert.equal(left.length, 1, `one copy of the day, got ${left.join(', ')}`);
    const survivor = join(dir, left[0]);
    assert.equal(inspectBackup(survivor, ENC.passphrase).counts.tasks, 1, 'and it can be restored');
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a live lock from another attempt makes this one give up, with its staging file removed and the other copy untouched', () => {
  const dir = tempDir();
  const store = openStore(':memory:');
  try {
    backupDatabase(store, dir, '2026-09-21', 14, new Date(), ENC);
    writeFileSync(join(dir, 'constellation-2026-09-21.lock'), '');
    assert.throws(() => backupDatabase(store, dir, '2026-09-21', 14, new Date(), { lockTimeoutMs: 150 }), /locked by another process/);
    assert.deepEqual(readdirSync(dir).sort(), ['constellation-2026-09-21.db.enc', 'constellation-2026-09-21.lock']);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock left by a dead attempt is taken over, and the lock is gone afterwards', () => {
  const dir = tempDir();
  const store = openStore(':memory:');
  try {
    const lock = join(dir, 'constellation-2026-09-21.lock');
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, old, old);
    backupDatabase(store, dir, '2026-09-21', 14, new Date(), { lockTimeoutMs: 150 });
    assert.deepEqual(readdirSync(dir), ['constellation-2026-09-21.db']);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// The passphrase a person saved must open the file the job wrote, through the real secret store.
test('a passphrase with spaces at the ends survives the real Windows secret store and opens the backup it made', { skip: process.platform !== 'win32' }, async () => {
  const dir = tempDir();
  const secretsDir = tempDir();
  const store = openStore(':memory:');
  try {
    const saved = '  what the owner typed and saved  ';
    const secrets = windowsDpapiSecretStore({ baseDir: secretsDir });
    await secrets.set('backup-passphrase', saved);
    const fromStore = await secrets.get('backup-passphrase');
    assert.equal(fromStore, saved);
    const { file } = backupDatabase(store, dir, '2026-09-21', 14, new Date(), { passphrase: fromStore, logN: 10 });
    assert.equal(decryptBuffer(file, saved).subarray(0, 15).toString(), 'SQLite format 3');
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(secretsDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- pre-update snapshots

test('snapshotName carries the running version and the moment, and snapshotDatabase writes a copy that opens', () => {
  const dir = tempDir();
  const store = openStore(':memory:');
  try {
    const name = snapshotName('2.0.0', new Date('2026-10-06T04:05:06.789Z'));
    assert.equal(name, 'constellation-pre-update-2.0.0-2026-10-06T04-05-06.db');
    assert.equal(isSnapshotFile(name), true);
    const project = store.createProject({ name: 'Snapshot test' });
    store.createTask({ title: 'Survives the update', projectId: project.id });
    const { file, removed } = snapshotDatabase(store, dir, name);
    assert.equal(file, join(dir, name));
    assert.deepEqual(removed, []);
    assert.deepEqual(readdirSync(dir), [name], 'no staging file or lock left behind');
    const copy = openStore(file);
    try {
      assert.deepEqual(copy.searchAllTasks().map((t) => t.title), ['Survives the update']);
    } finally {
      copy.db.close();
    }
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a snapshot needs a snapshot name', () => {
  const dir = tempDir();
  const store = openStore(':memory:');
  try {
    assert.throws(() => snapshotDatabase(store, dir, 'constellation-2026-10-06.db'), /not a snapshot name/);
    assert.throws(() => snapshotDatabase(store, dir, 'constellation-pre-update-2.0.0-2026-10-06T04-05-06.db.enc'), /not a snapshot name/);
    assert.throws(() => snapshotDatabase(store, dir, snapshotName('2.0.0', new Date()), { keep: 0 }), /keep must be/);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only the newest three snapshots stay, by the moment in the name and not by version text', () => {
  const dir = tempDir();
  const store = openStore(':memory:');
  try {
    const at = (h: number) => new Date(Date.UTC(2026, 9, 6, h, 0, 0));
    // 2.9.0 is older than 2.10.0, and "2.9" sorts after "2.10" as text: the moment decides.
    const names = [
      snapshotName('2.9.0', at(1)),
      snapshotName('2.10.0', at(2)),
      snapshotName('2.10.1', at(3)),
      snapshotName('2.11.0', at(4)),
    ];
    const results = names.map((name) => snapshotDatabase(store, dir, name));
    assert.deepEqual(results[3].removed, [names[0]], 'the oldest went when the fourth arrived');
    assert.deepEqual(readdirSync(dir).sort(), names.slice(1).sort());
    assert.deepEqual(listSnapshots(dir), names.slice(1).map((n) => join(dir, n)), 'oldest first');
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the daily backup never counts, replaces, or removes a snapshot, and newestBackup never returns one', () => {
  const dir = tempDir();
  const store = openStore(':memory:');
  try {
    const snapshot = snapshotDatabase(store, dir, snapshotName('2.0.0', new Date('2026-10-06T04:00:00Z'))).file;
    assert.equal(newestBackup(dir), undefined, 'a snapshot is not a dated copy');
    backupDatabase(store, dir, '2026-10-05', 1);
    const { file, removed } = backupDatabase(store, dir, '2026-10-06', 1);
    assert.deepEqual(removed, [`constellation-2026-10-05.db`], 'retention saw only the dated copies');
    assert.equal(newestBackup(dir), file);
    assert.ok(existsSync(snapshot), 'the snapshot is still there');
    // And a snapshot's own retention leaves the dated copies alone.
    for (let i = 0; i < 4; i++) snapshotDatabase(store, dir, snapshotName('2.0.0', new Date(Date.UTC(2026, 9, 7, i))));
    assert.ok(existsSync(file));
    assert.equal(listSnapshots(dir).length, 3);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with a passphrase the snapshot is encrypted and restoreDatabaseFile puts it back in place', () => {
  const dir = tempDir();
  const live = join(dir, 'live.db');
  const store = openStore(live);
  try {
    const project = store.createProject({ name: 'P' });
    store.createTask({ title: 'before', projectId: project.id });
    const { file } = snapshotDatabase(store, dir, snapshotName('2.0.0', new Date('2026-10-06T04:00:00Z')), ENC);
    assert.ok(isEncryptedBackup(file));
    assert.ok(file.endsWith('.db.enc'));
    assert.equal(inspectBackup(file, ENC.passphrase).counts.tasks, 1);
    store.createTask({ title: 'after', projectId: project.id });
    assert.ok(existsSync(`${live}-wal`), 'the live database is in WAL mode');
    store.db.close();

    assert.throws(() => restoreDatabaseFile(file, live), /no passphrase/);
    restoreDatabaseFile(file, live, ENC.passphrase);
    assert.equal(existsSync(`${live}-wal`), false);
    assert.equal(existsSync(`${live}-shm`), false);
    const restored = openStore(live);
    try {
      assert.deepEqual(restored.searchAllTasks().map((t) => t.title), ['before']);
    } finally {
      restored.db.close();
    }
  } finally {
    try { store.db.close(); } catch { /* closed above */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restoreDatabaseFile refuses a file that is not a sound database and leaves the live one alone', () => {
  const dir = tempDir();
  const live = join(dir, 'live.db');
  const store = openStore(live);
  try {
    store.createTask({ title: 'kept' });
    store.db.close();
    const bad = join(dir, 'bad.db');
    writeFileSync(bad, 'not a database');
    assert.throws(() => restoreDatabaseFile(bad, live), /cannot be opened|not a sound database|not a database/);
    const again = openStore(live);
    try {
      assert.deepEqual(again.searchAllTasks().map((t) => t.title), ['kept']);
    } finally {
      again.db.close();
    }
  } finally {
    try { store.db.close(); } catch { /* closed above */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

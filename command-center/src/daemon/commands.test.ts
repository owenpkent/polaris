import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import { MIGRATIONS } from '../core/schema.ts';
import { DatabaseSync } from 'node:sqlite';
import { backupDatabase } from './backup.ts';
import { commands, jobsForSync } from './commands.ts';

const backupCheck = commands.find((c) => c.name === 'backup check')!;

// A file-backed scratch database, and CC_BACKUP_DIR cleared so the command can only ever look in
// the scratch folder, whatever this machine has set.
function scratch(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-daemon-commands-'));
  const saved = process.env.CC_BACKUP_DIR;
  delete process.env.CC_BACKUP_DIR;
  t.after(() => {
    if (saved !== undefined) process.env.CC_BACKUP_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  });
  const dbPath = join(dir, 'test.db');
  const out: string[] = [];
  const err: string[] = [];
  return {
    dir, dbPath, out, err, backups: join(dir, 'backups'),
    // openApp throws: the check must never open the store, which would create and migrate the live database.
    ctx: { openApp: (): never => { throw new Error('backup check must not open the store'); }, config: () => ({ ...loadConfig({}), dbPath, repoRoot: dir }), stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) },
  };
}

function seed(dbPath: string, dir: string, titles: string[]): void {
  const app = openApp({ dbPath, repoRoot: dir });
  try {
    const project = app.store.listProjects()[0] ?? app.store.createProject({ name: 'P' });
    for (const title of titles) app.store.createTask({ title, projectId: project.id });
  } finally { app.close(); }
}

function backUp(dbPath: string, dir: string, day: string): string {
  const app = openApp({ dbPath, repoRoot: dir });
  try { return backupDatabase(app.store, join(dir, 'backups'), day).file; } finally { app.close(); }
}

test('backup check: with no backup it fails and says how to make one', async (t) => {
  const s = scratch(t);
  assert.equal(await backupCheck.run([], s.ctx), 1);
  assert.match(s.err.join('\n'), /No backup found in .*backups.*sync backup/s);
});

test('backup check: the newest backup is chosen, reported with live counts, and passes', async (t) => {
  const s = scratch(t);
  seed(s.dbPath, s.dir, ['one']);
  backUp(s.dbPath, s.dir, '2026-09-20');
  seed(s.dbPath, s.dir, ['two']);
  const newest = backUp(s.dbPath, s.dir, '2026-09-21');

  assert.equal(await backupCheck.run([], s.ctx), 0);
  assert.equal(s.out[0], newest);
  assert.match(s.out[1], /tasks 2; projects 1;/);
  assert.match(s.out[2], /live database: schema \d+; tasks 2; projects 1;/);
  assert.match(s.out.at(-1)!, /ok: this backup can be restored/);
  assert.deepEqual(s.err, []);
});

test('backup check: an older copy with fewer rows is still a good backup', async (t) => {
  const s = scratch(t);
  seed(s.dbPath, s.dir, ['one']);
  const old = backUp(s.dbPath, s.dir, '2026-09-20');
  seed(s.dbPath, s.dir, ['two', 'three']);

  assert.equal(await backupCheck.run([old], s.ctx), 0);
  assert.match(s.out[1], /tasks 1;/);
  assert.match(s.out[2], /live database: .*tasks 3;/);
});

test('backup check: a named file that is not a database fails with a problem line', async (t) => {
  const s = scratch(t);
  const junk = join(s.dir, 'junk.db');
  writeFileSync(junk, 'not a database');
  assert.equal(await backupCheck.run([junk], s.ctx), 1);
  assert.ok(s.err.some((l) => l.includes('PROBLEM')));
  assert.match(s.out.at(-1)!, /should not be trusted/);
});

// A recovery host: the backup is all there is. Its worth cannot hang on the database it replaces.
test('backup check: with no live database a good backup still passes, and no live database is created', async (t) => {
  const s = scratch(t);
  seed(s.dbPath, s.dir, ['one']);
  const copy = backUp(s.dbPath, s.dir, '2026-09-21');
  for (const f of readdirSync(s.dir)) if (f.startsWith('test.db')) rmSync(join(s.dir, f));

  assert.equal(await backupCheck.run([copy], s.ctx), 0);
  assert.match(s.out.join(' '), /live database: none at/);
  assert.match(s.out.at(-1)!, /ok: this backup can be restored/);
  assert.equal(existsSync(s.dbPath), false);
  assert.deepEqual(readdirSync(s.dir), ['backups']);
});

test('backup check: a corrupt live database is reported, left byte for byte, and does not fail a good backup', async (t) => {
  const s = scratch(t);
  seed(s.dbPath, s.dir, ['one']);
  const copy = backUp(s.dbPath, s.dir, '2026-09-21');
  for (const f of readdirSync(s.dir)) if (f.startsWith('test.db')) rmSync(join(s.dir, f));
  writeFileSync(s.dbPath, 'the disk ate this one');

  assert.equal(await backupCheck.run([copy], s.ctx), 0);
  assert.match(s.out.join(' '), /live database: could not be read/);
  assert.equal(readFileSync(s.dbPath, 'utf8'), 'the disk ate this one');
  assert.deepEqual(readdirSync(s.dir).sort(), ['backups', 'test.db']);
});

test('backup check: a copy holding more than a recreated live database is still a good backup', async (t) => {
  const s = scratch(t);
  seed(s.dbPath, s.dir, ['one', 'two']);
  const copy = backUp(s.dbPath, s.dir, '2026-09-21');
  const emptier = join(s.dir, 'recreated.db');
  seed(emptier, s.dir, []);
  const ctx = { ...s.ctx, config: () => ({ ...loadConfig({}), dbPath: emptier, repoRoot: s.dir }) };
  assert.equal(await backupCheck.run([copy], ctx), 0);
  assert.match(s.out.join(' '), /tasks 2;.*live database: .*tasks 0;/);
});

test('backup check: a backup from a newer schema than this code is a problem, an older one is not', async (t) => {
  const s = scratch(t);
  seed(s.dbPath, s.dir, ['one']);
  const copy = backUp(s.dbPath, s.dir, '2026-09-21');
  const raw = new DatabaseSync(copy);
  raw.prepare('UPDATE schema_version SET version = ?').run(MIGRATIONS.length - 1);
  raw.close();
  assert.equal(await backupCheck.run([copy], s.ctx), 0);

  const again = new DatabaseSync(copy);
  again.prepare('UPDATE schema_version SET version = ?').run(MIGRATIONS.length + 1);
  again.close();
  assert.equal(await backupCheck.run([copy], s.ctx), 1);
  assert.ok(s.err.some((l) => /newer than this code supports/.test(l)));
});

test('backup check only reads: the data folder and the backup folder hold the same files afterwards', async (t) => {
  const s = scratch(t);
  seed(s.dbPath, s.dir, ['one']);
  backUp(s.dbPath, s.dir, '2026-09-21');
  const before = [readdirSync(s.dir).sort(), readdirSync(s.backups)];
  await backupCheck.run([], s.ctx);
  assert.deepEqual([readdirSync(s.dir).sort(), readdirSync(s.backups)], before);
  assert.deepEqual(before, [['backups', 'test.db'], ['constellation-2026-09-21.db']]);
});

test('jobsForSync: a bare sync runs every interval job and no daily one; a named daily job still runs', () => {
  const bare = jobsForSync([]).map((j) => j.name);
  assert.ok(bare.includes('import') && bare.includes('rules'));
  assert.ok(!bare.includes('backup') && !bare.includes('digest'));
  assert.deepEqual(jobsForSync(['backup']).map((j) => j.name), ['backup']);
  assert.deepEqual(jobsForSync(['digest', 'rules']).map((j) => j.name).sort(), ['digest', 'rules']);
});

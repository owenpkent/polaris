import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKUP_PASSPHRASE_KEY, backupDatabase } from '../daemon/backup.ts';
import { windowsDpapiSecretStore } from '../ingest/secrets.ts';
import { TOOL_CATALOG } from '../mcp/catalog.ts';
import { api, fakeApp, withServer } from './test-support.ts';

const PASS = 'a long enough passphrase';

// The test app's database is in memory, so the backup folder comes from CC_BACKUP_DIR. It is set to
// a scratch folder and put back afterwards, whatever this machine has.
function scratchBackupDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'cc-backup-routes-'));
  const saved = process.env.CC_BACKUP_DIR;
  process.env.CC_BACKUP_DIR = dir;
  t.after(() => {
    if (saved === undefined) delete process.env.CC_BACKUP_DIR; else process.env.CC_BACKUP_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('GET /api/backup: a fresh server reports encryption off, the folder, and no copies', async (t) => {
  const dir = scratchBackupDir(t);
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const { status, json } = await api(base, 'GET', '/api/backup');
    assert.equal(status, 200);
    assert.equal(json.encryption, false);
    assert.equal(json.folder, dir);
    assert.equal(json.copies, 0);
    assert.equal(json.newest, null);
    assert.equal(json.job, null, 'this server runs no jobs');
    assert.equal(json.minPassphraseLength, 12);
  });
});

test('GET /api/backup: counts plain and encrypted copies, names the newest, and carries the job status', async (t) => {
  const dir = scratchBackupDir(t);
  const app = fakeApp();
  t.after(() => app.close());
  backupDatabase(app.store, dir, '2026-09-20');
  backupDatabase(app.store, dir, '2026-09-21', 14, new Date(), { passphrase: PASS, logN: 10 });
  writeFileSync(join(dir, 'notes.txt'), 'not a backup');
  const job = { lastRunAt: '2026-09-21T03:15:00Z', lastError: null, running: false };
  await withServer(app, { getJobStatus: () => ({ backup: job }) }, async (base) => {
    const { json } = await api(base, 'GET', '/api/backup');
    assert.equal(json.copies, 2);
    assert.equal(json.plainCopies, 1);
    assert.equal(json.newest.name, 'constellation-2026-09-21.db.enc');
    assert.equal(json.newest.encrypted, true);
    assert.ok(json.newest.bytes > 0);
    assert.deepEqual(json.job, job);
  });
});

test('POST /api/backup/encryption: sets the passphrase, and no response ever contains it', async (t) => {
  scratchBackupDir(t);
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const set = await api(base, 'POST', '/api/backup/encryption', { passphrase: PASS });
    assert.equal(set.status, 200);
    assert.equal(set.json.encryption, true);
    assert.equal(await app.secrets!.get(BACKUP_PASSPHRASE_KEY), PASS);

    const seen = [set, await api(base, 'GET', '/api/backup'), await api(base, 'POST', '/api/backup/check')];
    for (const res of seen) assert.ok(!JSON.stringify(res.json).includes(PASS));
  });
});

test('POST /api/backup/encryption: a short passphrase is refused, without echoing it, and nothing is stored', async (t) => {
  scratchBackupDir(t);
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const res = await api(base, 'POST', '/api/backup/encryption', { passphrase: 'short-one' });
    assert.equal(res.status, 400);
    assert.ok(!JSON.stringify(res.json).includes('short-one'));
    assert.equal(await app.secrets!.get(BACKUP_PASSPHRASE_KEY), undefined);

    const spaces = await api(base, 'POST', '/api/backup/encryption', { passphrase: '            ' });
    assert.equal(spaces.status, 400, 'twelve spaces are not a passphrase');
    assert.equal(await app.secrets!.get(BACKUP_PASSPHRASE_KEY), undefined);
    assert.equal((await api(base, 'POST', '/api/backup/encryption', { passphrase: '  kept as typed  ' })).status, 200);
    assert.equal(await app.secrets!.get(BACKUP_PASSPHRASE_KEY), '  kept as typed  ', 'spaces at the ends are kept');
    await app.secrets!.delete(BACKUP_PASSPHRASE_KEY);
    assert.equal((await api(base, 'POST', '/api/backup/encryption', {})).status, 400);
    assert.equal((await api(base, 'POST', '/api/backup/encryption', { passphrase: PASS, extra: 1 })).status, 400);
  });
});

test('POST /api/backup/encryption: an existing passphrase is only changed with replace: true', async (t) => {
  scratchBackupDir(t);
  const app = fakeApp();
  t.after(() => app.close());
  await app.secrets!.set(BACKUP_PASSPHRASE_KEY, PASS);
  await withServer(app, {}, async (base) => {
    const refused = await api(base, 'POST', '/api/backup/encryption', { passphrase: 'another long passphrase' });
    assert.equal(refused.status, 409);
    assert.equal(await app.secrets!.get(BACKUP_PASSPHRASE_KEY), PASS);

    const replaced = await api(base, 'POST', '/api/backup/encryption', { passphrase: 'another long passphrase', replace: true });
    assert.equal(replaced.status, 200);
    assert.equal(await app.secrets!.get(BACKUP_PASSPHRASE_KEY), 'another long passphrase');
  });
});

test('POST /api/backup/encryption: of two turn-on requests at once, one is stored and the other gets 409', async (t) => {
  scratchBackupDir(t);
  const dir = mkdtempSync(join(tmpdir(), 'cc-backup-routes-dpapi-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = fakeApp();
  t.after(() => app.close());
  // A store whose PowerShell takes a while, as the real one does, so the two requests overlap.
  app.secrets = windowsDpapiSecretStore({
    baseDir: dir,
    runPowerShell: async (_script, stdin) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return stdin.trim().split('').reverse().join('');
    },
  });
  await withServer(app, {}, async (base) => {
    const passphrases = ['the first long passphrase', 'the second long passphrase'];
    const results = await Promise.all(passphrases.map((passphrase) => api(base, 'POST', '/api/backup/encryption', { passphrase })));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const accepted = passphrases[results.findIndex((r) => r.status === 200)];
    assert.equal(await app.secrets!.get(BACKUP_PASSPHRASE_KEY), accepted);
  });
});

test('DELETE /api/backup/encryption: turns it off, and doing it twice is not an error', async (t) => {
  scratchBackupDir(t);
  const app = fakeApp();
  t.after(() => app.close());
  await app.secrets!.set(BACKUP_PASSPHRASE_KEY, PASS);
  await withServer(app, {}, async (base) => {
    const off = await api(base, 'DELETE', '/api/backup/encryption');
    assert.equal(off.status, 200);
    assert.equal(off.json.encryption, false);
    assert.equal(await app.secrets!.get(BACKUP_PASSPHRASE_KEY), undefined);
    assert.equal((await api(base, 'DELETE', '/api/backup/encryption')).status, 200);
  });
});

test('POST /api/backup/check: no backup yet, a good plain one, and a good encrypted one', async (t) => {
  const dir = scratchBackupDir(t);
  const app = fakeApp();
  t.after(() => app.close());
  const project = app.store.createProject({ name: 'P' });
  app.store.createTask({ title: 'one', projectId: project.id });
  await withServer(app, {}, async (base) => {
    const none = await api(base, 'POST', '/api/backup/check');
    assert.deepEqual(none.json, { checked: false, message: 'There is no backup to check yet.' });

    backupDatabase(app.store, dir, '2026-09-20');
    const plain = await api(base, 'POST', '/api/backup/check');
    assert.equal(plain.json.ok, true);
    assert.equal(plain.json.encrypted, false);
    assert.equal(plain.json.counts.tasks, 1);

    await app.secrets!.set(BACKUP_PASSPHRASE_KEY, PASS);
    backupDatabase(app.store, dir, '2026-09-21', 14, new Date(), { passphrase: PASS, logN: 10 });
    const enc = await api(base, 'POST', '/api/backup/check');
    assert.equal(enc.json.name, 'constellation-2026-09-21.db.enc');
    assert.equal(enc.json.ok, true);
    assert.equal(enc.json.encrypted, true);
    assert.deepEqual(readdirSync(dir).sort(), ['constellation-2026-09-20.db', 'constellation-2026-09-21.db.enc'], 'checking leaves no readable copy behind');
  });
});

test('POST /api/backup/check: a copy made under another passphrase says so in plain words, with no path or passphrase', async (t) => {
  const dir = scratchBackupDir(t);
  const app = fakeApp();
  t.after(() => app.close());
  backupDatabase(app.store, dir, '2026-09-21', 14, new Date(), { passphrase: 'the earlier passphrase', logN: 10 });
  await withServer(app, {}, async (base) => {
    for (const stored of [undefined, PASS]) {
      if (stored) await app.secrets!.set(BACKUP_PASSPHRASE_KEY, stored);
      const res = await api(base, 'POST', '/api/backup/check');
      assert.equal(res.json.ok, false);
      assert.match(res.json.problems[0], /made under another passphrase/);
      assert.ok(!JSON.stringify(res.json).includes(dir));
    }
  });
});

test('the backup routes need the api token like every other route', async (t) => {
  scratchBackupDir(t);
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    for (const [method, path] of [['GET', '/api/backup'], ['POST', '/api/backup/encryption'], ['DELETE', '/api/backup/encryption'], ['POST', '/api/backup/check']]) {
      const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  });
});

test('no MCP tool can read or change backup encryption: an agent must not be able to turn it off', () => {
  const names = TOOL_CATALOG.map((tool) => tool.name);
  assert.ok(names.length > 0);
  for (const name of names) assert.ok(!/backup|passphrase|encrypt/i.test(name), name);
});

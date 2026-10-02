// The encryption side of the backup commands: `backup encrypt`, `backup decrypt`, and `backup check`
// on an encrypted copy. Every test has an in-memory secret store and a prompt that answers from a
// list, so none reaches the real secret store or a terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import { memorySecretStore, type SecretStore } from '../ingest/secrets.ts';
import { BACKUP_PASSPHRASE_KEY, backupDatabase } from './backup.ts';
import { isEncryptedBackup } from './backupCrypto.ts';
import { commands } from './commands.ts';

const backupCheck = commands.find((c) => c.name === 'backup check')!;
const backupEncrypt = commands.find((c) => c.name === 'backup encrypt')!;
const backupDecrypt = commands.find((c) => c.name === 'backup decrypt')!;
const PASS = 'a long enough passphrase';

function scratch(t: { after(fn: () => void): void }, answers: string[] = [], secrets: SecretStore = memorySecretStore()) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-backup-commands-'));
  const saved = process.env.CC_BACKUP_DIR;
  delete process.env.CC_BACKUP_DIR;
  t.after(() => {
    if (saved !== undefined) process.env.CC_BACKUP_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  });
  const dbPath = join(dir, 'test.db');
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const queue = [...answers];
  return {
    dir, dbPath, out, err, asked, secrets, backups: join(dir, 'backups'),
    ctx: {
      openApp: (): never => { throw new Error('backup commands must not open the store'); },
      config: () => ({ ...loadConfig({}), dbPath, repoRoot: dir }),
      secrets,
      readSecret: async (question: string) => {
        asked.push(question);
        if (!queue.length) throw new Error('asked more than expected');
        return queue.shift()!;
      },
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
    },
  };
}

function seed(dbPath: string, dir: string, titles: string[]): void {
  const app = openApp({ dbPath, repoRoot: dir });
  try {
    const project = app.store.createProject({ name: 'P' });
    for (const title of titles) app.store.createTask({ title, projectId: project.id });
  } finally { app.close(); }
}

function backUp(dbPath: string, dir: string, day: string, passphrase?: string): string {
  const app = openApp({ dbPath, repoRoot: dir });
  try { return backupDatabase(app.store, join(dir, 'backups'), day, 14, new Date(), { passphrase, logN: 10 }).file; } finally { app.close(); }
}

// ---- backup encrypt ----

test('backup encrypt: a typed passphrase is asked for twice, stored, and never printed back', async (t) => {
  const s = scratch(t, [PASS, PASS]);
  assert.equal(await backupEncrypt.run(['--status'], s.ctx), 0);
  assert.match(s.out.at(-1)!, /encryption is off/);

  assert.equal(await backupEncrypt.run([], s.ctx), 0);
  assert.equal(s.asked.length, 2);
  assert.equal(await s.secrets.get(BACKUP_PASSPHRASE_KEY), PASS);
  assert.ok(!s.out.join(' ').includes(PASS));
  assert.match(s.out.join(' '), /password manager/);

  assert.equal(await backupEncrypt.run(['--status'], s.ctx), 0);
  assert.match(s.out.at(-1)!, /encryption is on/);
});

test('backup encrypt: an empty answer makes a passphrase, shows it once, and stores that same one', async (t) => {
  const s = scratch(t, ['']);
  assert.equal(await backupEncrypt.run([], s.ctx), 0);
  const stored = await s.secrets.get(BACKUP_PASSPHRASE_KEY);
  assert.match(stored!, /^([A-Za-z0-9_-]{4}-){5}[A-Za-z0-9_-]{4}$/);
  assert.equal(s.out.filter((line) => line.includes(stored!)).length, 1);
  assert.equal(s.asked.length, 1, 'a made passphrase is not asked for again');
});

test('backup encrypt: a short passphrase changes nothing, and so do twelve spaces', async (t) => {
  const s = scratch(t, ['too short']);
  assert.equal(await backupEncrypt.run([], s.ctx), 1);
  assert.equal(await s.secrets.get(BACKUP_PASSPHRASE_KEY), undefined);
  assert.match(s.err.join(' '), /12 or more/);
  const spaces = scratch(t, ['            ', '            ']);
  assert.equal(await backupEncrypt.run([], spaces.ctx), 1);
  assert.equal(await spaces.secrets.get(BACKUP_PASSPHRASE_KEY), undefined);
});

test('backup encrypt: spaces at the ends are kept as typed', async (t) => {
  const s = scratch(t, ['  kept as typed  ', '  kept as typed  ']);
  assert.equal(await backupEncrypt.run([], s.ctx), 0);
  assert.equal(await s.secrets.get(BACKUP_PASSPHRASE_KEY), '  kept as typed  ');
});

test('backup encrypt: two answers that differ change nothing', async (t) => {
  const s = scratch(t, [PASS, `${PASS} with a typo`]);
  assert.equal(await backupEncrypt.run([], s.ctx), 1);
  assert.equal(await s.secrets.get(BACKUP_PASSPHRASE_KEY), undefined);
  assert.match(s.err.join(' '), /did not match/);
});

test('backup encrypt: an existing passphrase is refused without --replace, before anything is asked', async (t) => {
  const s = scratch(t, [], memorySecretStore({ [BACKUP_PASSPHRASE_KEY]: PASS }));
  assert.equal(await backupEncrypt.run([], s.ctx), 1);
  assert.deepEqual(s.asked, []);
  assert.equal(await s.secrets.get(BACKUP_PASSPHRASE_KEY), PASS);
});

test('backup encrypt --replace changes the passphrase and warns that older backups need the old one', async (t) => {
  const next = 'another long passphrase';
  const s = scratch(t, [next, next], memorySecretStore({ [BACKUP_PASSPHRASE_KEY]: PASS }));
  assert.equal(await backupEncrypt.run(['--replace'], s.ctx), 0);
  assert.equal(await s.secrets.get(BACKUP_PASSPHRASE_KEY), next);
  assert.match(s.out.join(' '), /still need the old passphrase/);
});

test('backup encrypt --off removes the passphrase, says old backups still need it, and is not an error twice', async (t) => {
  const s = scratch(t, [], memorySecretStore({ [BACKUP_PASSPHRASE_KEY]: PASS }));
  assert.equal(await backupEncrypt.run(['--off'], s.ctx), 0);
  assert.equal(await s.secrets.get(BACKUP_PASSPHRASE_KEY), undefined);
  assert.match(s.out.join(' '), /still need their passphrase/);
  assert.equal(await backupEncrypt.run(['--off'], s.ctx), 0);
  assert.deepEqual(s.asked, []);
});

// ---- backup check on an encrypted copy ----

test('backup check: an encrypted backup opens with the stored passphrase, nobody is asked, and no readable copy is left', async (t) => {
  const s = scratch(t, [], memorySecretStore({ [BACKUP_PASSPHRASE_KEY]: PASS }));
  seed(s.dbPath, s.dir, ['one']);
  const file = backUp(s.dbPath, s.dir, '2026-09-21', PASS);

  assert.equal(await backupCheck.run([], s.ctx), 0);
  assert.equal(s.out[0], file);
  assert.match(s.out.join(' '), /encrypted, and the passphrase opens it.*tasks 1;.*ok: this backup can be restored/);
  assert.deepEqual(s.asked, []);
  assert.deepEqual(readdirSync(s.backups), ['constellation-2026-09-21.db.enc']);
});

test('backup check: on a recovery host with an empty secret store the passphrase is asked for', async (t) => {
  const s = scratch(t, [PASS]);
  seed(s.dbPath, s.dir, ['one']);
  backUp(s.dbPath, s.dir, '2026-09-21', PASS);
  assert.equal(await backupCheck.run([], s.ctx), 0);
  assert.deepEqual(s.asked, ['Backup passphrase: ']);
});

test('backup check: a backup made under an earlier passphrase asks for that one', async (t) => {
  const s = scratch(t, ['the earlier passphrase'], memorySecretStore({ [BACKUP_PASSPHRASE_KEY]: PASS }));
  seed(s.dbPath, s.dir, ['one']);
  backUp(s.dbPath, s.dir, '2026-09-21', 'the earlier passphrase');
  assert.equal(await backupCheck.run([], s.ctx), 0);
  assert.match(s.asked[0], /stored passphrase does not open this backup/);
});

test('backup check: a wrong passphrase fails the check and says the backup cannot be trusted', async (t) => {
  const s = scratch(t, ['not the passphrase']);
  seed(s.dbPath, s.dir, ['one']);
  backUp(s.dbPath, s.dir, '2026-09-21', PASS);
  assert.equal(await backupCheck.run([], s.ctx), 1);
  assert.ok(s.err.some((line) => /passphrase is wrong, or the file is damaged/.test(line)));
  assert.match(s.out.at(-1)!, /should not be trusted/);
});

test('backup check: a plain backup still needs no passphrase and asks nobody', async (t) => {
  const s = scratch(t);
  seed(s.dbPath, s.dir, ['one']);
  backUp(s.dbPath, s.dir, '2026-09-21');
  assert.equal(await backupCheck.run([], s.ctx), 0);
  assert.deepEqual(s.asked, []);
  assert.ok(!s.out.join(' ').includes('encrypted'));
});

// ---- backup decrypt ----

test('backup decrypt: writes a database that opens with the same tasks, and never overwrites', async (t) => {
  const s = scratch(t, [], memorySecretStore({ [BACKUP_PASSPHRASE_KEY]: PASS }));
  seed(s.dbPath, s.dir, ['restored']);
  const file = backUp(s.dbPath, s.dir, '2026-09-21', PASS);
  const out = join(s.dir, 'restored.db');

  assert.equal(await backupDecrypt.run([file, out], s.ctx), 0);
  assert.equal(isEncryptedBackup(out), false);
  const app = openApp({ dbPath: out, repoRoot: s.dir });
  try {
    assert.deepEqual(app.store.searchAllTasks().map((task) => task.title), ['restored']);
  } finally { app.close(); }
  assert.match(s.out.join(' '), /readable by anyone who can open it/);

  assert.equal(await backupDecrypt.run([file, out], s.ctx), 1);
  assert.ok(s.err.some((line) => /already exists/.test(line)));
});

test('backup decrypt: a wrong passphrase writes nothing', async (t) => {
  const s = scratch(t, ['wrong passphrase']);
  seed(s.dbPath, s.dir, ['one']);
  const file = backUp(s.dbPath, s.dir, '2026-09-21', PASS);
  const out = join(s.dir, 'out.db');
  assert.equal(await backupDecrypt.run([file, out], s.ctx), 1);
  assert.equal(existsSync(out), false);
});

test('backup decrypt: a plain backup is turned away, and so is no file at all', async (t) => {
  const s = scratch(t);
  seed(s.dbPath, s.dir, ['one']);
  const plain = backUp(s.dbPath, s.dir, '2026-09-21');
  assert.equal(await backupDecrypt.run([plain, join(s.dir, 'out.db')], s.ctx), 1);
  assert.ok(s.err.some((line) => /needs no decrypting/.test(line)));
  assert.equal(await backupDecrypt.run([], s.ctx), 1);
  assert.deepEqual(s.asked, []);
});

// ---- the real prompt, in a real process ----

// The command tests above inject a prompt. These run the real one (prompt.ts) reading a real
// piped stdin, which is how a script would drive `backup encrypt`.
function runEncryptInChild(stdin: string, args: string[] = []): Promise<{ code: number; stored: boolean; storedLength: number; out: string[]; err: string[] }> {
  const script = fileURLToPath(new URL('./fixtures/encrypt-runner.ts', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', script, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) { reject(new Error(`runner exited ${code}: ${err}`)); return; }
      const report = JSON.parse(out);
      report.terminal = err; // what the prompt wrote to the terminal
      resolve(report);
    });
    child.stdin.end(stdin);
  });
}

test('piped stdin: both answers in one chunk set the passphrase, and it is never echoed', async () => {
  const r = await runEncryptInChild('a passphrase typed twice\na passphrase typed twice\n') as unknown as { code: number; stored: boolean; storedLength: number; out: string[]; terminal: string };
  assert.equal(r.code, 0, JSON.stringify(r));
  assert.equal(r.stored, true);
  assert.equal(r.storedLength, 'a passphrase typed twice'.length);
  assert.ok(!r.out.join(' ').includes('typed twice'));
  assert.ok(!r.terminal.includes('typed twice'));
  assert.match(r.terminal, /Passphrase \(12 or more.*The same passphrase again/s);
});

test('piped stdin: two answers that differ store nothing', async () => {
  const r = await runEncryptInChild('a passphrase typed twice\na passphrase typed once\n');
  assert.equal(r.code, 1);
  assert.equal(r.stored, false);
  assert.match(r.err.join(' '), /did not match/);
});

test('piped stdin: one answer where two are needed fails with No answer, and stores nothing', async () => {
  const r = await runEncryptInChild('a passphrase typed once\n');
  assert.equal(r.code, 1);
  assert.equal(r.stored, false);
  assert.match(r.err.join(' '), /No answer was given/);
});

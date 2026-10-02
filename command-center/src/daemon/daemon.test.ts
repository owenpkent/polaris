import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { App } from '../app.ts';
import { openStore } from '../core/index.ts';
import { loadConfig } from '../config.ts';
import { memorySecretStore } from '../ingest/secrets.ts';
import { BACKUP_PASSPHRASE_KEY } from './backup.ts';
import { isEncryptedBackup } from './backupCrypto.ts';
import { todayIn } from '../automation/index.ts';
import { runDaemon } from './daemon.ts';
import { JOBS, runJob } from './jobs.ts';

function memoryApp(): App & { closed: boolean } {
  const store = openStore(':memory:');
  const app = {
    config: { ...loadConfig(), dbPath: ':memory:' },
    store,
    secrets: memorySecretStore(),
    today: () => todayIn('UTC'),
    closed: false,
    close() { app.closed = true; },
  };
  return app;
}

test('runJob records lastAt on success and never throws', async () => {
  const app = memoryApp();
  const rules = JOBS.find((j) => j.name === 'rules')!;
  const outcome = await runJob(app, rules);
  assert.equal(outcome.ok, true);
  assert.ok(app.store.getKv<string>('sync.rules.lastAt'));

  const failing = { name: 'boom', summary: '', everyMs: 1000, run: async () => { throw new Error('nope'); } };
  const bad = await runJob(app, failing);
  assert.equal(bad.ok, false);
  assert.match(app.store.getKv<string>('sync.boom.lastError') ?? '', /nope/);
});

test('daemon runs the initial pass, serves HTTP with job status, and shuts down cleanly', async () => {
  process.env.CC_API_TOKEN = 'test-token';
  process.env.CC_MCP_TOKEN = 'test-mcp';
  process.env.CC_MCP_READONLY_TOKEN = 'test-mcp-ro';
  const app = memoryApp();
  const lines: string[] = [];
  let stop!: () => void;
  const until = new Promise<void>((r) => { stop = r; });

  const done = runDaemon(app, {
    http: true, port: 0, host: '127.0.0.1', readonlyMcp: false, only: ['rules'], skip: [],
    stdout: (s) => lines.push(s), stderr: () => {}, until,
  });

  // Wait for the HTTP line, then query job status through the API.
  for (let i = 0; i < 100 && !lines.some((l) => l.includes('HTTP API')); i++) await new Promise((r) => setTimeout(r, 20));
  const url = /at (http:\/\/\S+)/.exec(lines.find((l) => l.includes('HTTP API'))!)![1];
  for (let i = 0; i < 100 && !app.store.getKv('sync.rules.lastAt'); i++) await new Promise((r) => setTimeout(r, 20));
  const res = await fetch(`${url}/api/sync`, { headers: { Authorization: 'Bearer test-token' } });
  const body = await res.json() as { jobs: Record<string, { lastRunAt: string | null }> };
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(body.jobs), ['rules']);
  assert.ok(body.jobs.rules.lastRunAt);

  stop();
  assert.equal(await done, 0);
  assert.equal(app.closed, true);
  delete process.env.CC_API_TOKEN;
  delete process.env.CC_MCP_TOKEN;
  delete process.env.CC_MCP_READONLY_TOKEN;
});

// The backup is a daily job, and daily jobs are left out of the startup pass unless they catch up.
async function runBackupOnlyDaemon(app: App, dir: string): Promise<string[]> {
  const saved = process.env.CC_BACKUP_DIR;
  process.env.CC_BACKUP_DIR = dir;
  const lines: string[] = [];
  let stop!: () => void;
  const until = new Promise<void>((r) => { stop = r; });
  try {
    const done = runDaemon(app, {
      http: false, port: 0, host: '127.0.0.1', readonlyMcp: false, only: ['backup'], skip: [],
      stdout: (s) => lines.push(s), stderr: () => {}, until,
    });
    for (let i = 0; i < 100 && !lines.some((l) => l.includes('backup:')); i++) await new Promise((r) => setTimeout(r, 20));
    stop();
    assert.equal(await done, 0);
    return lines;
  } finally {
    if (saved === undefined) delete process.env.CC_BACKUP_DIR; else process.env.CC_BACKUP_DIR = saved;
  }
}

test('daemon startup: a database that was never backed up gets a checked backup straight away', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-daemon-backup-'));
  const app = memoryApp();
  try {
    const lines = await runBackupOnlyDaemon(app, dir);
    assert.ok(lines.some((l) => l.includes('backup: wrote')), lines.join('\n'));
    assert.deepEqual(readdirSync(dir), [`constellation-${app.today()}.db`]);
    assert.ok(app.store.getKv('sync.backup.lastAt'));
    assert.equal(app.store.getKv('sync.backup.lastError'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('daemon startup: a backup from the last day is left alone until 03:15', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-daemon-backup-'));
  const app = memoryApp();
  try {
    const recent = new Date(Date.now() - 60 * 60_000).toISOString();
    app.store.setKv('sync.backup.lastAt', recent);
    const lines = await runBackupOnlyDaemon(app, dir);
    assert.ok(!lines.some((l) => l.includes('backup:')), lines.join('\n'));
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(app.store.getKv('sync.backup.lastAt'), recent);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('daemon backup: with a passphrase in the secret store the copy is encrypted, and the log says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-daemon-backup-'));
  const app = memoryApp();
  try {
    await app.secrets!.set(BACKUP_PASSPHRASE_KEY, 'a long enough passphrase');
    const lines = await runBackupOnlyDaemon(app, dir);
    assert.ok(lines.some((l) => l.includes('.db.enc (encrypted)')), lines.join(' | '));
    const files = readdirSync(dir);
    assert.deepEqual(files, [`constellation-${app.today()}.db.enc`]);
    assert.equal(isEncryptedBackup(join(dir, files[0])), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('daemon backup: a stored passphrase that cannot be used fails the job and writes no readable copy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-daemon-backup-'));
  const app = memoryApp();
  try {
    await app.secrets!.set(BACKUP_PASSPHRASE_KEY, '            ');
    const lines = await runBackupOnlyDaemon(app, dir);
    assert.ok(lines.some((l) => /backup: FAILED .*cannot be used/.test(l)), lines.join(' | '));
    assert.deepEqual(readdirSync(dir), []);
    assert.match(String(app.store.getKv('sync.backup.lastError')), /cannot be used/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

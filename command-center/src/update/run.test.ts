// The whole update flow against a scripted runner: no git, npm, build, or restart is ever run.
// The fake answers each program from a small model of a checkout (which commit the tree is on,
// whether the daemon listens, what version it reports) and moves that model the way the real
// programs would move the real one, so the order of steps and every rollback can be checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { inspectDatabaseFile, openStore } from '../core/index.ts';
import { MIGRATIONS } from '../core/schema.ts';
import { listSnapshots } from '../daemon/backup.ts';
import { identityProof } from '../http/identity.ts';
import { memorySecretStore } from '../ingest/secrets.ts';
import type { Exec, ExecResult } from './exec.ts';
import { runUpdate, updateLogPath, type UpdateDeps } from './run.ts';
import { readUpdateStatus, updateStatusPath } from './status.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PREVIOUS = 'a'.repeat(40);
const TARGET = 'b'.repeat(40);
const TOKEN = 'test-api-token';
const PORT = 8790;

interface Scenario {
  dirty?: string[];
  branch?: string | null;
  tag?: string;
  ahead?: number;
  behind?: number;
  running?: string;
  target?: string;
  changed?: string[];
  fail?: 'npm-ci' | 'test' | 'build' | 'health' | 'health-after-migration';
  checkOnly?: boolean;
  yes?: boolean;
  confirm?: boolean;
  passphrase?: string;
}

interface Call { cmd: string; args: string[]; cwd?: string }

function harness(t: { after(fn: () => void): void }, s: Scenario) {
  const root = mkdtempSync(join(tmpdir(), 'cc-update-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const running = s.running ?? '2.0.0';
  const target = s.target ?? '2.1.0';
  const dataDir = join(root, 'command-center', 'data');
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, 'constellation.db');
  const store = openStore(dbPath);
  store.createTask({ title: 'before the update' });
  store.db.close();
  writeFileSync(join(dataDir, 'api-token'), TOKEN);
  const dist = join(root, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'index.html'), 'old');
  const writeVersion = (v: string) => writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'polaris', version: v }));
  writeVersion(running);

  const state = { head: 'previous' as 'previous' | 'target', listening: true, daemonVersion: running, snapshotsAtCheckout: -1 };
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
  const fail = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr });
  const sha = () => (state.head === 'target' ? TARGET : PREVIOUS);

  const exec: Exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd });
    const line = `${cmd} ${args.join(' ')}`;
    if (cmd === 'git') {
      switch (args[0]) {
        case 'status': return ok((s.dirty ?? []).map((p) => ` M ${p}`).join('\n'));
        case 'rev-parse':
          if (args[1] === '--abbrev-ref') return ok(`${s.branch === undefined ? 'main' : s.branch ?? 'HEAD'}\n`);
          return ok(`${args[2] === 'origin/main^{commit}' ? TARGET : sha()}\n`);
        case 'tag': return ok(s.tag ? `${s.tag}\n` : '');
        case 'fetch': return ok();
        case 'rev-list': return ok(`${s.ahead ?? 0}\t${s.behind ?? 1}\n`);
        case 'log': return ok('bbbbbbb feat: the newer thing\n');
        case 'diff': return ok((s.changed ?? []).join('\n'));
        case 'show': return args[1] === 'origin/main:package.json' ? ok(JSON.stringify({ version: target })) : { code: 128, stdout: '', stderr: 'no such path' };
        case 'merge':
          state.snapshotsAtCheckout = listSnapshots(join(dataDir, 'backups')).length;
          state.head = 'target'; writeVersion(target); return ok();
        case 'reset': state.head = 'previous'; writeVersion(running); return ok();
        default: return fail(`unexpected ${line}`);
      }
    }
    if (cmd === 'npm') {
      if (args[0] === 'ci' && s.fail === 'npm-ci' && state.head === 'target') return fail('npm ERR! lockfile out of sync');
      if (args[0] === 'run' && s.fail === 'test' && state.head === 'target') return fail('1 failing');
      return ok();
    }
    if (cmd === 'npx' && args[0] === 'vite') {
      if (s.fail === 'build') return fail('error during build');
      const outDir = args[args.indexOf('--outDir') + 1];
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'index.html'), 'new');
      return ok();
    }
    if (cmd === 'systemctl' && args[0] === '--user') {
      if (args[1] === 'show') return ok('loaded\n');
      if (args[1] === 'stop') { state.listening = false; return ok(); }
      if (args[1] === 'start') {
        state.listening = true;
        if (state.head === 'target') {
          state.daemonVersion = s.fail === 'health' || s.fail === 'health-after-migration' ? 'broken' : target;
          if (s.fail === 'health-after-migration') {
            // The new code's first start migrated the live database past what the old code knows.
            const db = new DatabaseSync(dbPath);
            db.exec(`UPDATE schema_version SET version = ${MIGRATIONS.length + 1}`);
            db.close();
          }
        } else {
          state.daemonVersion = running;
        }
        return ok();
      }
    }
    return fail(`unexpected ${line}`);
  };

  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (!state.listening) throw new Error('ECONNREFUSED');
    if (url.pathname === '/api/identity') {
      return Response.json({ proof: identityProof(TOKEN, PORT, url.searchParams.get('challenge') ?? '') });
    }
    if (url.pathname === '/api/health') {
      const auth = new Headers(init?.headers).get('authorization');
      if (auth !== `Bearer ${TOKEN}`) return new Response('', { status: 401 });
      return Response.json({ ok: true, version: state.daemonVersion });
    }
    return new Response('', { status: 404 });
  };

  let clock = Date.parse('2026-10-06T04:00:00.000Z');
  const deps: UpdateDeps = {
    exec,
    fetch: fetchFn,
    now: () => new Date((clock += 1000)),
    sleep: async () => {},
    portListening: async () => state.listening,
    platform: 'linux',
    env: {},
    secrets: memorySecretStore(s.passphrase ? { 'backup-passphrase': s.passphrase } : {}),
    confirm: async () => s.confirm ?? true,
  };
  const run = (overrides: Partial<UpdateDeps> = {}) => runUpdate({
    repoRoot: root, dbPath, dashboardDir: dist, port: PORT,
    checkOnly: s.checkOnly ?? false, yes: s.yes ?? true, restartSpec: 'systemd-user:polaris',
    stdout: (l) => out.push(l), stderr: (l) => err.push(l),
  }, { ...deps, ...overrides });
  const commandLines = () => calls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
  const version = () => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string;
  const distFile = (name: string) => (existsSync(join(root, name, 'index.html')) ? readFileSync(join(root, name, 'index.html'), 'utf8') : null);
  const tasks = () => { const st = openStore(dbPath); try { return st.searchAllTasks().map((x) => x.title); } finally { st.db.close(); } };
  return { root, dbPath, dataDir, dist, state, calls, out, err, deps, run, commandLines, version, distFile, tasks, log: () => (existsSync(updateLogPath(dbPath)) ? readFileSync(updateLogPath(dbPath), 'utf8') : '') };
}

const npmAndRestartCalls = (lines: string[]) => lines.filter((l) => l.startsWith('npm ') || l.startsWith('npx ') || / (stop|start) /.test(l));

test('run.ts imports everything statically: the old code must keep running after the checkout moves', () => {
  const source = readFileSync(join(here, 'run.ts'), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!source.includes('await import('), 'no dynamic import in run.ts');
  assert.ok(!/\bimport\(/.test(source), 'no import() call in run.ts');
  assert.ok(/^import .* from '\.\/exec\.ts';$/m.test(source), 'the runner is a static import');
});

test('refuses a dirty tree before fetching, and writes no status', async (t) => {
  const h = harness(t, { dirty: ['src/x.js'] });
  assert.equal(await h.run(), 1);
  assert.match(h.err.join('\n'), /uncommitted changes/);
  assert.ok(!h.commandLines().some((l) => l.startsWith('git fetch')), 'nothing fetched');
  assert.deepEqual(npmAndRestartCalls(h.commandLines()), []);
  assert.equal(existsSync(updateStatusPath(h.dbPath)), false);
  assert.match(h.log(), /Refused: the working tree/);
});

test('refuses a checkout that is not on main: a branch, a detached HEAD, a release tag', async (t) => {
  const onBranch = harness(t, { branch: 'feat/x' });
  assert.equal(await onBranch.run(), 1);
  assert.match(onBranch.err.join('\n'), /on feat\/x, not main/);
  const detached = harness(t, { branch: null });
  assert.equal(await detached.run(), 1);
  assert.match(detached.err.join('\n'), /detached/);
  const onTag = harness(t, { branch: null, tag: 'v2.0.0' });
  assert.equal(await onTag.run(), 1);
  assert.match(onTag.err.join('\n'), /release tag v2\.0\.0/);
  for (const h of [onBranch, detached, onTag]) assert.deepEqual(npmAndRestartCalls(h.commandLines()), []);
});

test('refuses local commits that are not on the remote', async (t) => {
  const h = harness(t, { ahead: 2, behind: 1 });
  assert.equal(await h.run(), 1);
  assert.match(h.err.join('\n'), /2 local commits are not on origin\/main/);
  assert.deepEqual(npmAndRestartCalls(h.commandLines()), []);
  assert.equal(h.version(), '2.0.0');
});

test('refuses a target that is not strictly newer, and a target with no version', async (t) => {
  const same = harness(t, { target: '2.0.0' });
  assert.equal(await same.run(), 1);
  assert.match(same.err.join('\n'), /2\.0\.0, which is not newer than the running 2\.0\.0/);
  const older = harness(t, { target: '1.9.9' });
  assert.equal(await older.run(), 1);
  assert.match(older.err.join('\n'), /not newer/);
  const malformed = harness(t, { target: 'v2.1.0' });
  assert.equal(await malformed.run(), 1);
  assert.match(malformed.err.join('\n'), /no MAJOR\.MINOR\.PATCH version/);
  for (const h of [same, older, malformed]) {
    assert.deepEqual(npmAndRestartCalls(h.commandLines()), []);
    assert.equal(h.version(), '2.0.0');
    assert.deepEqual(listSnapshots(join(h.dataDir, 'backups')), [], 'no snapshot for a refused update');
  }
});

test('a malformed running version refuses too', async (t) => {
  const h = harness(t, { running: '2.0.0-dev' });
  assert.equal(await h.run(), 1);
  assert.match(h.err.join('\n'), /"2\.0\.0-dev" is not MAJOR\.MINOR\.PATCH/);
});

test('a bad CC_UPDATE_RESTART stops the run before anything moves', async (t) => {
  const h = harness(t, {});
  const code = await runUpdate({
    repoRoot: h.root, dbPath: h.dbPath, dashboardDir: h.dist, port: PORT, checkOnly: false, yes: true, restartSpec: 'cron',
    stdout: (l) => h.out.push(l), stderr: (l) => h.err.push(l),
  }, { exec: async (cmd, args) => ({ code: 0, stdout: cmd === 'git' && args[0] === 'rev-parse' ? 'main\n' : '', stderr: '' }), fetch, now: () => new Date(), sleep: async () => {}, portListening: async () => true, platform: 'linux', env: {}, secrets: memorySecretStore(), confirm: async () => true });
  assert.equal(code, 1);
  assert.match(h.err.join('\n'), /CC_UPDATE_RESTART is "cron"/);
});

test('--check fetches and reports what would change and installs nothing', async (t) => {
  const h = harness(t, { checkOnly: true, changed: ['command-center/src/core/schema.ts', 'package-lock.json'] });
  assert.equal(await h.run(), 0);
  const text = h.out.join('\n');
  assert.match(text, /origin\/main is 2\.1\.0/);
  assert.match(text, /feat: the newer thing/);
  assert.match(text, /The schema changes/);
  assert.match(text, /package-lock\.json/);
  assert.match(text, /2\.1\.0 is available/);
  assert.ok(h.commandLines().some((l) => l.startsWith('git fetch')));
  assert.ok(!h.commandLines().some((l) => l.startsWith('git merge')));
  assert.deepEqual(npmAndRestartCalls(h.commandLines()), []);
  assert.equal(h.version(), '2.0.0');
  assert.equal(existsSync(updateStatusPath(h.dbPath)), false);
});

test('nothing to do when the checkout is at origin/main', async (t) => {
  const h = harness(t, { behind: 0, target: '2.0.0' });
  assert.equal(await h.run(), 0);
  assert.match(h.out.join('\n'), /Already up to date/);
  assert.deepEqual(npmAndRestartCalls(h.commandLines()), []);
});

test('without --yes the owner is asked, and a no installs nothing', async (t) => {
  const h = harness(t, { yes: false, confirm: false });
  assert.equal(await h.run(), 0);
  assert.match(h.out.join('\n'), /Not updating/);
  assert.deepEqual(npmAndRestartCalls(h.commandLines()), []);
  assert.deepEqual(listSnapshots(join(h.dataDir, 'backups')), []);
});

test('the happy path: snapshot, checkout, npm ci, tests, staged build, restart with the swap, health check, status', async (t) => {
  const h = harness(t, { changed: ['command-center/src/core/schema.ts'] });
  assert.equal(await h.run(), 0, h.err.join('\n'));
  assert.equal(h.state.snapshotsAtCheckout, 1, 'the snapshot was taken before the checkout moved');
  const lines = h.commandLines();
  const after = (a: string, b: string) => assert.ok(lines.findIndex((l) => l.startsWith(a)) < lines.findIndex((l) => l.startsWith(b)), `${a} before ${b}`);
  after('git fetch', 'git merge --ff-only origin/main');
  after('git merge', 'npm ci --ignore-scripts');
  after('npm ci --ignore-scripts', 'npm rebuild esbuild');
  after('npm rebuild esbuild', 'npm run test:fast');
  after('npm run test:fast', 'npx vite build');
  after('npx vite build', 'systemctl --user stop polaris');
  after('systemctl --user stop polaris', 'systemctl --user start polaris');
  assert.deepEqual(h.calls.filter((c) => c.cmd === 'npm' && c.args[0] === 'ci').map((c) => c.cwd), [h.root, join(h.root, 'command-center')]);
  assert.deepEqual(h.calls.find((c) => c.cmd === 'npx')!.args, ['vite', 'build', '--outDir', `${h.dist}.next`, '--emptyOutDir']);
  assert.equal(h.version(), '2.1.0');
  assert.equal(h.distFile('dist'), 'new');
  assert.equal(h.distFile('dist.prev'), 'old');
  assert.equal(existsSync(`${h.dist}.next`), false);
  const snapshots = listSnapshots(join(h.dataDir, 'backups'));
  assert.equal(snapshots.length, 1);
  assert.match(snapshots[0], /constellation-pre-update-2\.0\.0-2026-10-06T04-\d{2}-\d{2}\.db$/);
  const status = readUpdateStatus(h.dbPath);
  assert.equal(status.updaterInstalled, false);
  assert.equal(status.running, '2.1.0');
  assert.equal(status.lastResult?.ok, true);
  assert.match(status.lastResult!.message, /Updated to 2\.1\.0/);
  assert.match(h.log(), /Updated to 2\.1\.0/);
  assert.ok(readFileSync(updateLogPath(h.dbPath), 'utf8').split('\n').every((l) => !l || /^2026-10-06T/.test(l) || l.startsWith('    ')), 'every log line is timestamped or indented program output');
  assert.deepEqual(h.tasks(), ['before the update']);
  assert.ok(!h.log().includes(TOKEN) && !h.out.join('\n').includes(TOKEN), 'the api token is never printed');
});

test('with backup encryption on, the snapshot is encrypted', async (t) => {
  const h = harness(t, { passphrase: 'a long enough passphrase' });
  assert.equal(await h.run(), 0, h.err.join('\n'));
  const snapshots = listSnapshots(join(h.dataDir, 'backups'));
  assert.equal(snapshots.length, 1);
  assert.ok(snapshots[0].endsWith('.db.enc'));
  assert.ok(!h.log().includes('a long enough passphrase'));
});

test('a failing npm ci rolls the checkout back: the daemon is never stopped and dist is untouched', async (t) => {
  const h = harness(t, { fail: 'npm-ci' });
  assert.equal(await h.run(), 1);
  const lines = h.commandLines();
  assert.ok(!lines.some((l) => / (stop|start) /.test(l)), 'the daemon was never stopped');
  assert.ok(!lines.some((l) => l.startsWith('npx vite')), 'nothing was built');
  assert.ok(lines.includes(`git reset --hard ${PREVIOUS}`));
  assert.ok(lines.filter((l) => l === 'npm ci --ignore-scripts').length >= 3, 'npm ci ran again after the reset');
  assert.equal(h.version(), '2.0.0');
  assert.equal(h.distFile('dist'), 'old');
  assert.equal(existsSync(`${h.dist}.next`), false);
  assert.equal(existsSync(`${h.dist}.prev`), false);
  assert.match(h.err.join('\n'), /npm ci --ignore-scripts failed/);
  assert.match(h.out.join('\n'), /was not restarted and runs 2\.0\.0/);
  const status = readUpdateStatus(h.dbPath);
  assert.equal(status.lastResult?.ok, false);
  assert.equal(status.running, '2.0.0');
  assert.match(status.lastResult!.message, /Rolled back: npm ci/);
});

test('a failing test run or build rolls back the same way and leaves no dist.next', async (t) => {
  for (const fail of ['test', 'build'] as const) {
    const h = harness(t, { fail });
    assert.equal(await h.run(), 1, fail);
    assert.ok(!h.commandLines().some((l) => / (stop|start) /.test(l)), `${fail}: the daemon was never stopped`);
    assert.equal(h.version(), '2.0.0', fail);
    assert.equal(h.distFile('dist'), 'old', fail);
    assert.equal(existsSync(`${h.dist}.next`), false, fail);
    assert.equal(readUpdateStatus(h.dbPath).lastResult?.ok, false, fail);
  }
});

test('a failing health check rolls back the code and dist and restarts the previous version', async (t) => {
  const h = harness(t, { fail: 'health' });
  assert.equal(await h.run(), 1);
  const lines = h.commandLines();
  assert.equal(lines.filter((l) => l === 'systemctl --user stop polaris').length, 2, 'stopped for the update and for the rollback');
  assert.equal(lines.filter((l) => l === 'systemctl --user start polaris').length, 2);
  assert.ok(lines.indexOf(`git reset --hard ${PREVIOUS}`) > lines.indexOf('systemctl --user start polaris'));
  assert.equal(h.version(), '2.0.0');
  assert.equal(h.distFile('dist'), 'old');
  assert.equal(existsSync(`${h.dist}.prev`), false);
  assert.equal(existsSync(`${h.dist}.next`), false);
  assert.equal(h.state.daemonVersion, '2.0.0', 'the previous version is what runs');
  assert.match(h.err.join('\n'), /health check failed: the daemon reports version broken, expected 2\.1\.0/);
  assert.match(h.out.join('\n'), /Rolled back\. The daemon is up on port 8790 running 2\.0\.0/);
  assert.equal(inspectDatabaseFile(h.dbPath).schemaVersion, MIGRATIONS.length, 'the database was not touched');
  assert.ok(!h.log().includes('Restored the database'));
  assert.deepEqual(h.tasks(), ['before the update']);
  const status = readUpdateStatus(h.dbPath);
  assert.equal(status.lastResult?.ok, false);
  assert.equal(status.running, '2.0.0');
});

test('a failing health check after the new code migrated the database restores the snapshot', async (t) => {
  const h = harness(t, { fail: 'health-after-migration', changed: ['command-center/src/core/schema.ts'] });
  assert.equal(await h.run(), 1);
  assert.equal(inspectDatabaseFile(h.dbPath).schemaVersion, MIGRATIONS.length, 'the schema is back where the old code knows it');
  assert.equal(existsSync(`${h.dbPath}-wal`), false);
  assert.deepEqual(h.tasks(), ['before the update']);
  assert.match(h.log(), /Restored the database from .*constellation-pre-update-2\.0\.0-/);
  assert.equal(h.version(), '2.0.0');
  assert.equal(h.distFile('dist'), 'old');
  assert.equal(h.state.daemonVersion, '2.0.0');
  assert.deepEqual(readdirSync(h.dataDir).filter((f) => f.endsWith('.restore')), [], 'no restore staging file left');
  assert.equal(readUpdateStatus(h.dbPath).lastResult?.ok, false);
});

test('a rollback that fails is loud and leaves the previous commit and the snapshot path on screen', async (t) => {
  const h = harness(t, { fail: 'health' });
  const code = await h.run({
    exec: async (cmd, args, opts) => (cmd === 'git' && args[0] === 'reset' ? { code: 1, stdout: '', stderr: 'disk full' } : h.deps.exec(cmd, args, opts)),
  });
  assert.equal(code, 2);
  const text = h.err.join('\n');
  assert.match(text, /ROLLBACK FAILED: git reset --hard .* disk full/);
  assert.match(text, new RegExp(`The previous commit is ${PREVIOUS}`));
  assert.match(text, /The database snapshot is .*constellation-pre-update-2\.0\.0-/);
  assert.match(text, /To finish by hand/);
  const status = readUpdateStatus(h.dbPath);
  assert.equal(status.lastResult?.ok, false);
  assert.equal(status.running, null, 'what runs is not known');
  assert.match(status.lastResult!.message, /and that failed/);
});

test('a restart that stops the daemon and cannot start it again still rolls back and tries the start once more', async (t) => {
  const h = harness(t, { });
  let starts = 0;
  const code = await h.run({
    exec: async (cmd, args, opts) => {
      if (cmd === 'systemctl' && args[1] === 'start' && ++starts === 1) { return { code: 1, stdout: '', stderr: 'unit failed' }; }
      return h.deps.exec(cmd, args, opts);
    },
  });
  assert.equal(code, 1);
  assert.equal(h.version(), '2.0.0');
  assert.equal(h.distFile('dist'), 'old', 'the swap was undone');
  assert.equal(h.state.listening, true, 'the daemon is back');
  assert.equal(h.state.daemonVersion, '2.0.0');
  assert.match(h.err.join('\n'), /systemctl --user start polaris failed/);
});

// The whole update flow against a scripted runner: no git, npm, build, or restart is ever run.
// The fake answers each program from a small model of a checkout (which commit the tree is on,
// whether the daemon listens, what version it reports) and moves that model the way the real
// programs would move the real one, so the order of steps and every rollback can be checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { inspectDatabaseFile, openStore } from '../core/index.ts';
import { MIGRATIONS } from '../core/schema.ts';
import { listSnapshots } from '../daemon/backup.ts';
import { identityProof } from '../http/identity.ts';
import { api, fakeApp, withServer } from '../http/test-support.ts';
import { memorySecretStore } from '../ingest/secrets.ts';
import { createMcpServer } from '../mcp/server.ts';
import { assertNotUpdating, barrierPath, readBarrier, UpdateInProgressError, writeBarrier } from './barrier.ts';
import type { Exec, ExecResult } from './exec.ts';
import { NO_RESTART_METHOD, performUpdate, runTrustSigners, runUpdate, updateLogPath, type UpdateDeps, type UpdateTarget } from './run.ts';
import { pinnedSignersPath } from './signers.ts';
import { emptyUpdateStatus, readUpdateStatus, updateStatusPath, writeUpdateStatus } from './status.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PREVIOUS = 'a'.repeat(40);
const TARGET = 'b'.repeat(40);
const TOKEN = 'test-api-token';
const PORT = 8790;
const KEY_A = 'AAAAC3NzaC1lZDI1NTE5AAAAIAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const KEY_B = 'AAAAC3NzaC1lZDI1NTE5AAAAIBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SIGNERS_A = `# release keys\npolaris-release namespaces="git" ssh-ed25519 ${KEY_A}\n`;
const SIGNERS_B = `polaris-release namespaces="git" ssh-ed25519 ${KEY_B}\n`;
const SIGNERS_NONE = '# no keys yet\n';
const FINGERPRINT = 'SHA256:7XkuoKngBtHFlb11TNVHq4BN7kSlZDld0g0xBo6AAos';

/** A tag on the fake origin: whether `git verify-tag` passes against the pinned file, what the
 *  package.json at the tag says (default: the tag's own version), the annotation, and what
 *  signature block the raw tag object carries (default: one SSH signature). */
interface FakeTag { tag: string; verifies?: boolean; version?: string; notes?: string; signature?: 'ssh' | 'pgp' | 'x509' | 'none' | 'ssh-twice' }

const SIGNATURE_BLOCKS = {
  ssh: '-----BEGIN SSH SIGNATURE-----\nU1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAg\n-----END SSH SIGNATURE-----\n',
  pgp: '-----BEGIN PGP SIGNATURE-----\n\niQEzBAABCAAdFiEE\n-----END PGP SIGNATURE-----\n',
  x509: '-----BEGIN SIGNED MESSAGE-----\nMIIGdQYJKoZIhvcNAQcCoIIGZjCCBmICAQExDzANBglghkgBZQMEAgEFADALBgkq\n-----END SIGNED MESSAGE-----\n',
  none: '',
  'ssh-twice': '-----BEGIN SSH SIGNATURE-----\nU1NIU0lH\n-----END SSH SIGNATURE-----\n-----BEGIN SSH SIGNATURE-----\nU1NIU0lH\n-----END SSH SIGNATURE-----\n',
};

/** What `git cat-file tag` prints for a fake tag: the headers, the message, the signature block. */
function rawTag(tag: FakeTag): string {
  return `object ${TARGET}\ntype commit\ntag ${tag.tag}\ntagger test <test@example.com> 1760000000 +0000\n\n${tag.notes ?? `Release ${tag.tag}`}\n${SIGNATURE_BLOCKS[tag.signature ?? 'ssh']}`;
}

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
  /** The target: origin/main unless set. */
  mode?: 'release' | 'to';
  to?: string;
  tags?: FakeTag[];
  /** Whether the release tag at HEAD (`tag`) verifies. */
  startVerifies?: boolean;
  /** The committed release-signers text; null for no file. Default: one key. */
  committed?: string | null;
  /** The pinned data/release-signers text; absent unless set. */
  pinned?: string;
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
  const committed = s.committed === undefined ? SIGNERS_A : s.committed;
  if (committed !== null) writeFileSync(join(root, 'release-signers'), committed);
  const pinnedFile = pinnedSignersPath(dbPath);
  if (s.pinned !== undefined) writeFileSync(pinnedFile, s.pinned, { mode: 0o600 });
  const tags = s.tags ?? [];
  const tagVersion = (tag: string) => tags.find((x) => x.tag === tag)?.version ?? tag.replace(/^v/, '');

  const snapshots = () => listSnapshots(join(dataDir, 'backups')).length;
  const state = { head: 'previous' as 'previous' | 'target', listening: true, daemonVersion: running, snapshotsAtCheckout: -1, snapshotsAtStop: -1, snapshotsAtStart: -1, verifiedAgainst: [] as string[] };
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
          return ok(`${args[2] === 'HEAD^{commit}' ? sha() : TARGET}\n`);
        case 'tag':
          if (args[1] === '--points-at') return ok(s.tag ? `${s.tag}\n` : '');
          if (args[1] === '--list') return ok(tags.map((x) => x.tag).join('\n'));
          if (args[1] === '-l') return ok(`tag\n${tags.find((x) => x.tag === args[3])?.notes ?? ''}\n`);
          return fail(`unexpected ${line}`);
        case '-c': {
          // git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=<pinned> -c gpg.openpgp.program=<none> -c gpg.x509.program=<none> verify-tag <tag>
          const settings = args.filter((_, i) => i % 2 === 1 && args[i - 1] === '-c' && i < args.indexOf('verify-tag'));
          assert.deepEqual(args.slice(settings.length * 2), ['verify-tag', args[args.length - 1]], `${line} is -c settings, then verify-tag <tag>`);
          const signers = settings.find((x) => x.startsWith('gpg.ssh.allowedSignersFile='));
          assert.ok(signers, 'the signers file is named');
          assert.ok(settings.includes('gpg.format=ssh'));
          assert.ok(settings.some((x) => x.startsWith('gpg.openpgp.program=')) && settings.some((x) => x.startsWith('gpg.x509.program=')), 'OpenPGP and X.509 are pointed at nothing');
          state.verifiedAgainst.push(signers.slice('gpg.ssh.allowedSignersFile='.length));
          const tag = args[args.length - 1];
          const verifies = tag === s.tag && s.startVerifies !== undefined ? s.startVerifies : tags.find((x) => x.tag === tag)?.verifies ?? true;
          return verifies ? ok() : fail(`Good "git" signature with ED25519 key SHA256:other\nNo principal matched.`);
        }
        case 'cat-file': {
          assert.equal(args[1], 'tag');
          const found = tags.find((x) => x.tag === args[2]) ?? (args[2] === s.tag ? { tag: s.tag } : undefined);
          return found ? ok(rawTag(found)) : fail(`fatal: Not a valid object name ${args[2]}`);
        }
        case 'fetch': return ok();
        case 'rev-list': return ok(`${s.ahead ?? 0}\t${s.behind ?? 1}\n`);
        case 'log': return ok('bbbbbbb feat: the newer thing\n');
        case 'diff': return ok((s.changed ?? []).join('\n'));
        case 'show': return args[1] === 'origin/main:package.json' ? ok(JSON.stringify({ version: target })) : { code: 128, stdout: '', stderr: 'no such path' };
        case 'merge':
          state.snapshotsAtCheckout = snapshots();
          state.head = 'target'; writeVersion(target); return ok();
        case 'checkout': {
          const ref = args[args.length - 1];
          if (/^v\d/.test(ref)) { state.snapshotsAtCheckout = snapshots(); state.head = 'target'; writeVersion(tagVersion(ref)); return ok(); }
          if (ref === 'main' || ref === PREVIOUS) { state.head = 'previous'; writeVersion(running); return ok(); }
          return fail(`unexpected ${line}`);
        }
        case 'reset': state.head = 'previous'; writeVersion(running); return ok();
        default: return fail(`unexpected ${line}`);
      }
    }
    if (cmd === 'ssh-keygen') return ok(`256 ${FINGERPRINT} no comment (ED25519)\n`);
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
      if (args[1] === 'stop') { state.snapshotsAtStop = snapshots(); state.listening = false; return ok(); }
      if (args[1] === 'start') {
        state.snapshotsAtStart = snapshots();
        state.listening = true;
        if (state.head === 'target') {
          state.daemonVersion = s.fail === 'health' || s.fail === 'health-after-migration' ? 'broken' : version();
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
  const updateTarget: UpdateTarget = s.mode === 'release' ? { kind: 'release' } : s.mode === 'to' ? { kind: 'to', version: s.to! } : { kind: 'main' };
  const run = (overrides: Partial<UpdateDeps> = {}) => runUpdate({
    repoRoot: root, dbPath, dashboardDir: dist, port: PORT, target: updateTarget,
    checkOnly: s.checkOnly ?? false, yes: s.yes ?? true, restartSpec: 'systemd-user:polaris',
    stdout: (l) => out.push(l), stderr: (l) => err.push(l),
  }, { ...deps, ...overrides });
  const trust = (overrides: Partial<UpdateDeps> = {}) => runTrustSigners({ repoRoot: root, dbPath, yes: s.yes ?? false, stdout: (l) => out.push(l), stderr: (l) => err.push(l) }, { ...deps, ...overrides });
  const commandLines = () => calls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
  const version = () => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string;
  const pinned = () => (existsSync(pinnedFile) ? readFileSync(pinnedFile, 'utf8') : null);
  const distFile = (name: string) => (existsSync(join(root, name, 'index.html')) ? readFileSync(join(root, name, 'index.html'), 'utf8') : null);
  const tasks = () => { const st = openStore(dbPath); try { return st.searchAllTasks().map((x) => x.title); } finally { st.db.close(); } };
  /** A write the way the CLI makes one: the store opened directly, outside the update process. */
  const writeTask = (title: string) => { const st = openStore(dbPath); try { st.createTask({ title }); } finally { st.db.close(); } };
  return { root, dbPath, dataDir, dist, state, calls, out, err, deps, run, trust, commandLines, version, distFile, tasks, writeTask, pinnedFile, pinned, log: () => (existsSync(updateLogPath(dbPath)) ? readFileSync(updateLogPath(dbPath), 'utf8') : '') };
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

test('origin/main with new commits and the same version installs: a merge need not bump the version', async (t) => {
  const h = harness(t, { target: '2.0.0', behind: 3 });
  assert.equal(await h.run(), 0, h.err.join('\n'));
  assert.match(h.out.join('\n'), /origin\/main is 2\.0\.0 at bbbbbbb, 3 commits ahead/);
  assert.ok(h.commandLines().includes('git merge --ff-only origin/main'));
  assert.equal(h.state.daemonVersion, '2.0.0');
  assert.match(h.out.join('\n'), /Updated to 2\.0\.0/);
});

test('refuses origin/main when its version is older than the running one, or has no version', async (t) => {
  const older = harness(t, { target: '1.9.9' });
  assert.equal(await older.run(), 1);
  assert.match(older.err.join('\n'), /origin\/main is 1\.9\.9, which is older than the running 2\.0\.0/);
  const malformed = harness(t, { target: 'v2.1.0' });
  assert.equal(await malformed.run(), 1);
  assert.match(malformed.err.join('\n'), /no MAJOR\.MINOR\.PATCH version/);
  for (const h of [older, malformed]) {
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

test('--check fetches and reports what origin/main would change and installs nothing', async (t) => {
  const h = harness(t, { checkOnly: true, changed: ['command-center/src/core/schema.ts', 'package-lock.json'] });
  assert.equal(await h.run(), 0);
  const text = h.out.join('\n');
  assert.match(text, /origin\/main is 2\.1\.0/);
  assert.match(text, /feat: the newer thing/);
  assert.match(text, /The schema changes/);
  assert.match(text, /package-lock\.json/);
  assert.match(text, /2\.1\.0 is available from origin\/main/);
  assert.match(text, /No release is newer than the running 2\.0\.0/);
  assert.ok(h.commandLines().includes('git fetch --prune --tags origin'), 'one fetch, with the tags');
  assert.ok(!h.commandLines().some((l) => l.startsWith('git merge')));
  assert.deepEqual(npmAndRestartCalls(h.commandLines()), []);
  assert.equal(h.version(), '2.0.0');
  assert.equal(readUpdateStatus(h.dbPath).available, null);
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

test('the happy path: checkout, npm ci, tests, staged build, restart with the snapshot and the swap, health check, status', async (t) => {
  const h = harness(t, { changed: ['command-center/src/core/schema.ts'] });
  assert.equal(await h.run(), 0, h.err.join('\n'));
  assert.equal(h.state.snapshotsAtCheckout, 0, 'no snapshot before the checkout: the daemon was still taking writes');
  assert.equal(h.state.snapshotsAtStop, 0, 'none at the stop either');
  assert.equal(h.state.snapshotsAtStart, 1, 'the snapshot was taken with the daemon stopped, before the start');
  assert.equal(existsSync(barrierPath(h.dbPath)), false, 'the barrier is gone after the commit');
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

test('a systemd system unit is stopped and started through sudo, with the swap and the restore while nothing listens', async (t) => {
  const h = harness(t, { fail: 'health-after-migration', changed: ['command-center/src/core/schema.ts'] });
  const sudo = async (cmd: string, args: string[], o?: Parameters<Exec>[2]) => {
    if (cmd === 'sudo') {
      assert.equal(args[0], '-n', 'never a password prompt');
      if (args[1] === '-l') return { code: 0, stdout: '', stderr: '' };
      assert.equal(args[1], 'systemctl');
      // The real stop and start, through the user-unit model of the harness.
      return h.deps.exec('systemctl', ['--user', args[2], args[3]], o);
    }
    if (cmd === 'systemctl' && args[0] === 'show') return { code: 0, stdout: 'loaded\n', stderr: '' };
    return h.deps.exec(cmd, args, o);
  };
  const seen: string[] = [];
  const code = await runUpdate({
    repoRoot: h.root, dbPath: h.dbPath, dashboardDir: h.dist, port: PORT, checkOnly: false, yes: true, restartSpec: 'systemd:polaris',
    stdout: (l) => h.out.push(l), stderr: (l) => h.err.push(l),
  }, { ...h.deps, exec: sudo, portListening: async () => { seen.push(h.state.listening ? 'up' : 'down'); return h.state.listening; } });
  assert.equal(code, 1);
  const lines = h.commandLines().filter((l) => l.startsWith('systemctl --user') && !l.includes('show'));
  assert.deepEqual(lines, ['systemctl --user stop polaris', 'systemctl --user start polaris', 'systemctl --user stop polaris', 'systemctl --user start polaris'], 'stop, start; then the rollback: stop, start');
  assert.ok(!h.commandLines().some((l) => l.includes('restart')), 'restart is never run');
  assert.ok(seen.includes('down'), 'the port was seen free between the stop and the start');
  assert.match(h.log(), /Restored the database from/);
  assert.equal(inspectDatabaseFile(h.dbPath).schemaVersion, MIGRATIONS.length);
  assert.equal(h.version(), '2.0.0');
  assert.equal(h.distFile('dist'), 'old');
  assert.equal(h.state.daemonVersion, '2.0.0');
  assert.match(h.out.join('\n'), /Restart: the systemd unit polaris \(sudo -n systemctl stop polaris, then start\)/);
});

test('a failure after the target was chosen but before the checkout moved is recorded as a result', async (t) => {
  const h = harness(t, {});
  const code = await h.run({
    exec: async (cmd, args, o) => (cmd === 'git' && args[0] === 'merge' ? { code: 1, stdout: '', stderr: 'fatal: Not possible to fast-forward' } : h.deps.exec(cmd, args, o)),
  });
  assert.equal(code, 1);
  assert.match(h.err.join('\n'), /Failed before anything changed: git merge --ff-only origin\/main failed/);
  const status = readUpdateStatus(h.dbPath);
  assert.equal(status.lastResult?.ok, false);
  assert.match(status.lastResult!.message, /^Failed before anything changed: git merge/);
  assert.equal(status.running, '2.0.0');
  assert.deepEqual(npmAndRestartCalls(h.commandLines()), []);
});

test('a run by hand clears the scheduled updater\'s failure count and backoff', async (t) => {
  const h = harness(t, { yes: false, confirm: false });
  writeUpdateStatus(h.dbPath, { ...emptyUpdateStatus(), updaterInstalled: true, failures: 2, backoffUntil: '2026-10-09T04:00:00.000Z' });
  assert.equal(await h.run(), 0, 'declined at the question, which is after the count is cleared');
  assert.equal(readUpdateStatus(h.dbPath).failures, 0);
  assert.equal(readUpdateStatus(h.dbPath).backoffUntil, null);
  assert.equal(readUpdateStatus(h.dbPath).updaterInstalled, true, 'the heartbeat is not touched by a declined run');
  // --check is only a look: it clears nothing.
  const check = harness(t, { checkOnly: true });
  writeUpdateStatus(check.dbPath, { ...emptyUpdateStatus(), updaterInstalled: true, failures: 2, backoffUntil: '2026-10-09T04:00:00.000Z' });
  assert.equal(await check.run(), 0);
  assert.equal(readUpdateStatus(check.dbPath).failures, 2);
});

test('in auto mode the manual restart method is refused once the target is known, before the snapshot; a run by hand is not', async (t) => {
  const h = harness(t, { mode: 'to', to: '2.1.0', tags: [{ tag: 'v2.1.0' }], yes: false, confirm: false });
  const options = (auto: boolean) => ({
    repoRoot: h.root, dbPath: h.dbPath, dashboardDir: h.dist, port: PORT, target: { kind: 'to', version: '2.1.0' } as UpdateTarget,
    checkOnly: false, yes: false, auto, restartSpec: 'manual', stdout: (l: string) => h.out.push(l), stderr: (l: string) => h.err.push(l),
  });
  const refused = await performUpdate(options(true), h.deps);
  assert.deepEqual(refused, { code: 1, kind: 'refused', message: NO_RESTART_METHOD, version: '2.0.0', attempted: false });
  assert.match(h.err.join('\n'), /^Refused: no restart method: the updater needs the logon task or a systemd unit, or CC_UPDATE_RESTART/m);
  assert.ok(h.commandLines().includes('git fetch --prune --tags origin'), 'the tags were read, so the check is on record');
  assert.deepEqual(npmAndRestartCalls(h.commandLines()), []);
  assert.deepEqual(listSnapshots(join(h.dataDir, 'backups')), [], 'nothing changed: no snapshot');
  assert.equal(h.version(), '2.0.0');
  assert.equal(readUpdateStatus(h.dbPath).lastResult, null, 'a refusal is not a failed install');

  // By hand, the same install on a plain process gets as far as the question: the owner can restart the daemon.
  h.out.length = 0; h.err.length = 0;
  const byHand = await performUpdate(options(false), h.deps);
  assert.equal(byHand.kind, 'declined');
  assert.ok(!h.err.join('\n').includes('no restart method'));
  assert.match(h.out.join('\n'), /Restart: by hand/);
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

// -------------------------------------------------------------------------------------
// The snapshot and the write barrier (docs/update-proposal.md, section 1, steps 7 to 9). The
// snapshot is taken with the daemon stopped, so every write taken before the stop is in it, and
// the barrier (data/update-barrier.json) keeps any write from being taken after it.
// -------------------------------------------------------------------------------------

test('a task written while the tests run survives a migrated update whose health check fails', async (t) => {
  const h = harness(t, { fail: 'health-after-migration', changed: ['command-center/src/core/schema.ts'] });
  const code = await h.run({
    exec: async (cmd, args, o) => {
      // The old snapshot was taken before the checkout; this write lands after that point and
      // before the stop, the way a REST, MCP, or CLI write would while the tests run.
      if (cmd === 'npm' && args[0] === 'run') h.writeTask('during the update');
      return h.deps.exec(cmd, args, o);
    },
  });
  assert.equal(code, 1);
  assert.match(h.log(), /Restored the database from .*constellation-pre-update-2\.0\.0-/);
  assert.equal(inspectDatabaseFile(h.dbPath).schemaVersion, MIGRATIONS.length, 'the migration was undone');
  assert.deepEqual(h.tasks().sort(), ['before the update', 'during the update'], 'the write taken before the stop is in the snapshot the rollback restored');
  assert.equal(h.state.snapshotsAtStart, 1);
});

test('while the daemon is stopped the barrier stands: the CLI refuses to open the store, a REST write gets 503, a GET does not, an MCP write tool refuses; after the commit it is gone', async (t) => {
  const h = harness(t, {});
  const app = fakeApp();
  app.config.dbPath = h.dbPath;
  t.after(() => app.close());
  const mcp = createMcpServer(app);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const agent = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([mcp.connect(serverTransport), agent.connect(clientTransport)]);
  const tool = async (name: string, args: Record<string, unknown>) => (await agent.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  await withServer(app, {}, async (base) => {
    const seen: string[] = [];
    const code = await h.run({
      exec: async (cmd, args, o) => {
        const r = await h.deps.exec(cmd, args, o);
        if (cmd === 'systemctl' && args[1] === 'stop') {
          // The daemon is down and the snapshot is about to be taken. Every writer is turned away.
          assert.ok(existsSync(barrierPath(h.dbPath)), 'the barrier was written before the stop');
          const barrier = readBarrier(h.dbPath);
          assert.ok(barrier && barrier.pid === process.pid && barrier.version === '2.1.0', 'this process, this version');
          assert.throws(() => assertNotUpdating(h.dbPath), (e: unknown) => e instanceof UpdateInProgressError && /^Polaris is being updated \(started \S+\)\. Try again in a minute\.$/.test(e.message));
          const post = await api(base, 'POST', '/api/tasks', { title: 'during the stop' });
          assert.equal(post.status, 503);
          assert.equal(post.json.error.code, 'Updating');
          assert.match(post.json.error.message, /^Polaris is being updated \(started .*\)\. Try again in a minute\.$/);
          assert.equal((await api(base, 'PATCH', '/api/settings/agent', { name: 'x' })).status, 503);
          assert.equal((await api(base, 'GET', '/api/tasks')).status, 200, 'reads go on');
          assert.equal((await api(base, 'GET', '/api/health')).status, 200);
          assert.notEqual((await fetch(`${base}/api/identity?challenge=abc`)).status, 503, 'the identity probe is a GET and is answered');
          const refused = await tool('create_task', { title: 'during the stop' });
          assert.equal(refused.isError, true);
          assert.match(refused.content[0].text, /^Polaris is being updated \(started .*\)\. Try again in a minute\.$/);
          const read = await tool('search_tasks', { text: 'anything' });
          assert.ok(!read.isError, 'read tools keep working');
          seen.push('checked');
        }
        return r;
      },
    });
    assert.equal(code, 0, h.err.join('\n'));
    assert.deepEqual(seen, ['checked']);
    assert.equal(existsSync(barrierPath(h.dbPath)), false, 'gone after the commit');
    assert.equal((await api(base, 'POST', '/api/tasks', { title: 'after the update' })).status, 201);
    assert.ok(!(await tool('create_task', { title: 'after the update' })).isError);
    assert.deepEqual(app.store.searchAllTasks().map((x) => x.title).sort(), ['after the update', 'after the update'], 'nothing was taken during the stop');
  });
});

test('a stale barrier is ignored and removed: a dead pid, or over two hours old', async (t) => {
  const h = harness(t, {});
  const app = fakeApp();
  app.config.dbPath = h.dbPath;
  t.after(() => app.close());
  const file = barrierPath(h.dbPath);
  writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(), version: '2.1.0' }));
  await withServer(app, {}, async (base) => {
    assert.equal((await api(base, 'POST', '/api/tasks', { title: 'the update is long over' })).status, 201);
  });
  assert.equal(existsSync(file), false, 'the old barrier was removed by the reader');
  writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), version: '2.1.0' }));
  assert.equal(readBarrier(h.dbPath, { alive: () => false }), null, 'a pid that is not alive');
  assert.equal(existsSync(file), false);
  writeFileSync(file, 'not json');
  assert.doesNotThrow(() => assertNotUpdating(h.dbPath));
  assert.equal(existsSync(file), false, 'an unreadable barrier is removed too');
  // A fresh one, for contrast: this process, now.
  writeBarrier(h.dbPath, '2.1.0');
  assert.throws(() => assertNotUpdating(h.dbPath), UpdateInProgressError);
  assert.equal(readBarrier(h.dbPath)?.version, '2.1.0');
  rmSync(file);
});

test('the barrier is gone after a rollback, and after a rollback that failed', async (t) => {
  const rolled = harness(t, { fail: 'health' });
  const during: boolean[] = [];
  const code = await rolled.run({
    exec: async (cmd, args, o) => {
      if (cmd === 'systemctl' && args[1] === 'start') during.push(existsSync(barrierPath(rolled.dbPath)));
      return rolled.deps.exec(cmd, args, o);
    },
  });
  assert.equal(code, 1);
  assert.deepEqual(during, [true, true], 'up through the restart and through the rollback\'s restart');
  assert.equal(existsSync(barrierPath(rolled.dbPath)), false);

  const failed = harness(t, { fail: 'health' });
  assert.equal(await failed.run({
    exec: async (cmd, args, o) => (cmd === 'git' && args[0] === 'reset' ? { code: 1, stdout: '', stderr: 'disk full' } : failed.deps.exec(cmd, args, o)),
  }), 2);
  assert.equal(existsSync(barrierPath(failed.dbPath)), false, 'a failed rollback drops it too: the owner finishes by hand, and must be able to');
});

test('a snapshot that fails with the daemon stopped rolls back: the daemon is started again on the old code and nothing is swapped', async (t) => {
  const h = harness(t, { changed: ['command-center/src/core/schema.ts'] });
  // CC_BACKUP_DIR names a file, so the backup folder cannot be made and the snapshot throws
  // inside the stopped interval, after the stop and before the swap.
  const notADir = join(h.root, 'not-a-dir');
  writeFileSync(notADir, 'x');
  assert.equal(await h.run({ env: { CC_BACKUP_DIR: notADir } }), 1);
  const lines = h.commandLines();
  assert.equal(lines.filter((l) => l === 'systemctl --user stop polaris').length, 2, 'the stop for the update, then the rollback\'s stop of an already stopped daemon');
  assert.equal(lines.filter((l) => l === 'systemctl --user start polaris').length, 1, 'the update never got to its start; the rollback\'s start is the one');
  assert.ok(lines.indexOf(`git reset --hard ${PREVIOUS}`) > lines.indexOf('systemctl --user stop polaris'), 'the failure was after the stop');
  assert.equal(h.state.listening, true, 'the daemon is back');
  assert.equal(h.state.daemonVersion, '2.0.0');
  assert.equal(h.version(), '2.0.0');
  assert.equal(h.distFile('dist'), 'old', 'the swap never happened');
  assert.equal(existsSync(`${h.dist}.next`), false);
  assert.equal(existsSync(`${h.dist}.prev`), false);
  assert.equal(inspectDatabaseFile(h.dbPath).schemaVersion, MIGRATIONS.length);
  assert.deepEqual(h.tasks(), ['before the update']);
  assert.ok(!h.log().includes('Restored the database'), 'nothing migrated, so nothing to restore');
  assert.match(h.err.join('\n'), /FAILED: .*not-a-dir/);
  assert.match(h.out.join('\n'), /Rolled back\. The daemon is up on port 8790 running 2\.0\.0/);
  assert.equal(existsSync(barrierPath(h.dbPath)), false);
  const status = readUpdateStatus(h.dbPath);
  assert.equal(status.lastResult?.ok, false);
  assert.equal(status.running, '2.0.0');
});

// -------------------------------------------------------------------------------------
// Phase B: releases (docs/update-proposal.md, section 2). The fake origin carries tags; the fake
// `git verify-tag` answers from the scenario and records which signers file it was given, and
// the fake `git cat-file tag` prints the raw tag with the signature block the scenario names.
// -------------------------------------------------------------------------------------

test('a tag whose signature is not one SSH signature does not verify, whatever git verify-tag said', async (t) => {
  // The fake git verify-tag exits 0 for every one of these (as git does with the signer's
  // OpenPGP key in the local keyring); the raw tag is what decides, and it is read first.
  const pgp = harness(t, { mode: 'release', tags: [{ tag: 'v2.1.0', signature: 'pgp' }] });
  assert.equal(await pgp.run(), 1);
  assert.deepEqual(pgp.err, ['Skipped v2.1.0: the tag is signed with OpenPGP, not SSH; releases verify by SSH signature against the pinned signers only', 'Refused: no release newer than 2.0.0 verifies against the pinned signers (1 skipped). Nothing installed.']);
  assert.ok(pgp.commandLines().includes('git cat-file tag v2.1.0'), 'the raw tag was read');
  assert.deepEqual(pgp.state.verifiedAgainst, [], 'git verify-tag, which would have said yes, was not even asked');

  const cases: [NonNullable<FakeTag['signature']>, RegExp][] = [
    ['x509', /signed with X\.509, not SSH/],
    ['none', /no signature found/],
    ['ssh-twice', /carries 2 signature blocks \(SSH, SSH\); a release carries one SSH signature/],
  ];
  for (const [signature, reason] of cases) {
    const h = harness(t, { mode: 'to', to: '2.1.0', tags: [{ tag: 'v2.1.0', signature }] });
    assert.equal(await h.run(), 1, signature);
    assert.match(h.err.join('\n'), new RegExp(`v2\\.1\\.0 does not verify against the pinned signers: .*${reason.source}`), signature);
    assert.deepEqual(npmAndRestartCalls(h.commandLines()), [], signature);
    assert.equal(h.version(), '2.0.0', signature);
  }

  // The newest tag is OpenPGP-signed and the one below it SSH-signed: the SSH one is installed.
  const mixed = harness(t, { mode: 'release', tags: [{ tag: 'v2.2.0', signature: 'pgp' }, { tag: 'v2.1.0' }] });
  assert.equal(await mixed.run(), 0, mixed.err.join('\n'));
  assert.match(mixed.err.join('\n'), /Skipped v2\.2\.0: the tag is signed with OpenPGP/);
  assert.equal(mixed.version(), '2.1.0');
});

test('--release installs the newest verified release: pinned on first use, verified against the pinned copy, checked out detached', async (t) => {
  const h = harness(t, { mode: 'release', tags: [{ tag: 'v2.1.0', notes: 'Release 2.1.0\n\nNotes line two' }, { tag: 'v2.0.0' }, { tag: 'not-a-release' }], changed: ['command-center/src/core/schema.ts'] });
  assert.equal(h.pinned(), null, 'nothing pinned before the first run');
  assert.equal(await h.run(), 0, h.err.join('\n'));
  assert.equal(h.pinned(), SIGNERS_A, 'the committed file was pinned, comments and all');
  if (process.platform !== 'win32') assert.equal(statSync(h.pinnedFile).mode & 0o777, 0o600);
  assert.deepEqual(h.state.verifiedAgainst, [h.pinnedFile], 'one tag verified, against the pinned copy');
  const lines = h.commandLines();
  assert.ok(lines.includes('git fetch --prune --tags origin'));
  assert.ok(lines.includes('git checkout -q --detach v2.1.0'), 'a release is checked out detached');
  assert.ok(!lines.some((l) => l.startsWith('git merge')));
  assert.equal(h.state.snapshotsAtCheckout, 0, 'no snapshot before the checkout');
  assert.equal(h.state.snapshotsAtStart, 1, 'the snapshot was taken with the daemon stopped');
  assert.ok(lines.indexOf('git checkout -q --detach v2.1.0') < lines.indexOf('npm ci --ignore-scripts'));
  assert.equal(h.version(), '2.1.0');
  assert.equal(h.state.daemonVersion, '2.1.0');
  const text = h.out.join('\n');
  assert.match(text, /Pinned release-signers \(1 key\)/);
  assert.match(text, /v2\.1\.0 \(2\.1\.0\) at bbbbbbb verifies/);
  assert.match(text, /Release notes:\n  Release 2\.1\.0\n  \n  Notes line two/);
  assert.match(text, /The schema changes/);
  assert.match(text, /Updated to 2\.1\.0 \(v2\.1\.0\)/);
  const status = readUpdateStatus(h.dbPath);
  assert.equal(status.running, '2.1.0');
  assert.equal(status.available, null);
  assert.equal(status.lastResult?.ok, true);
});

test('--release with no release newer than the running version does nothing, with exit 0', async (t) => {
  const h = harness(t, { mode: 'release', tags: [{ tag: 'v2.0.0' }, { tag: 'v1.9.0' }] });
  assert.equal(await h.run(), 0, h.err.join('\n'));
  assert.match(h.out.join('\n'), /No release is newer than the running 2\.0\.0\. Nothing installed/);
  assert.deepEqual(h.state.verifiedAgainst, [], 'an older tag is never even verified');
  assert.deepEqual(npmAndRestartCalls(h.commandLines()), []);
  const none = harness(t, { mode: 'release', tags: [] });
  assert.equal(await none.run(), 0);
  assert.match(none.out.join('\n'), /0 release tags from origin/);
});

test('--release skips a tag that does not verify, reports it, and never installs it', async (t) => {
  const h = harness(t, { mode: 'release', tags: [{ tag: 'v2.3.0', verifies: false }, { tag: 'v2.2.0', verifies: false }, { tag: 'v2.1.0' }] });
  assert.equal(await h.run(), 0, h.err.join('\n'));
  assert.deepEqual(h.err, ['Skipped v2.3.0: No principal matched', 'Skipped v2.2.0: No principal matched']);
  assert.equal(h.state.verifiedAgainst.length, 3, 'newest first, stopping at the first that verifies');
  assert.equal(h.version(), '2.1.0');
  assert.ok(h.commandLines().includes('git checkout -q --detach v2.1.0'));
  assert.ok(!h.commandLines().some((l) => l.includes('v2.3.0') && l.startsWith('git checkout')));

  const allBad = harness(t, { mode: 'release', tags: [{ tag: 'v2.3.0', verifies: false }, { tag: 'v2.2.0', verifies: false }, { tag: 'v2.0.0', verifies: false }] });
  assert.equal(await allBad.run(), 1);
  assert.match(allBad.err.join('\n'), /no release newer than 2\.0\.0 verifies against the pinned signers \(2 skipped\)/);
  assert.deepEqual(npmAndRestartCalls(allBad.commandLines()), []);
  assert.equal(allBad.version(), '2.0.0');
  assert.deepEqual(listSnapshots(join(allBad.dataDir, 'backups')), []);
});

test('a pinned signers file with no keys means no release can verify', async (t) => {
  const h = harness(t, { mode: 'release', pinned: SIGNERS_NONE, tags: [{ tag: 'v2.1.0' }] });
  assert.equal(await h.run(), 1);
  assert.match(h.err.join('\n'), /no release can verify: the pinned signers file .* has no keys.*cc update --trust-signers/);
  assert.deepEqual(h.state.verifiedAgainst, [], 'no tag is verified against an empty file');
  assert.deepEqual(npmAndRestartCalls(h.commandLines()), []);
  assert.equal(h.pinned(), SIGNERS_NONE, 'the committed file (which has a key) did not replace the pinned one');
  // The committed file has no keys either, and nothing is pinned: pinning it is still "no keys".
  const fresh = harness(t, { mode: 'release', committed: SIGNERS_NONE, tags: [{ tag: 'v2.1.0' }] });
  assert.equal(await fresh.run(), 1);
  assert.match(fresh.err.join('\n'), /has no keys/);
  assert.equal(fresh.pinned(), SIGNERS_NONE);
  // No file anywhere.
  const nothing = harness(t, { mode: 'release', committed: null, tags: [{ tag: 'v2.1.0' }] });
  assert.equal(await nothing.run(), 1);
  assert.match(nothing.err.join('\n'), /there is no release-signers file in the checkout and none is pinned/);
  assert.equal(nothing.pinned(), null);
});

test('a committed signers file that differs from the pinned one is reported, and verification stays with the pinned copy', async (t) => {
  const h = harness(t, { mode: 'release', pinned: SIGNERS_A, committed: SIGNERS_B, tags: [{ tag: 'v2.1.0' }] });
  assert.equal(await h.run(), 0, h.err.join('\n'));
  assert.match(h.err.join('\n'), /The signers file changed; run cc update --trust-signers to review it/);
  assert.equal(h.pinned(), SIGNERS_A, 'the pinned copy is untouched');
  assert.deepEqual(h.state.verifiedAgainst, [h.pinnedFile]);
  assert.equal(h.version(), '2.1.0');
  // A comment-only difference is not a change.
  const comments = harness(t, { mode: 'release', pinned: SIGNERS_A, committed: `# reworded comment\npolaris-release namespaces="git" ssh-ed25519 ${KEY_A} laptop\n`, tags: [{ tag: 'v2.1.0' }] });
  assert.equal(await comments.run(), 0, comments.err.join('\n'));
  assert.ok(!comments.err.join('\n').includes('signers file changed'));
  // The checkout lost the file: still the pinned copy.
  const gone = harness(t, { mode: 'release', pinned: SIGNERS_A, committed: null, tags: [{ tag: 'v2.1.0' }] });
  assert.equal(await gone.run(), 0, gone.err.join('\n'));
  assert.match(gone.err.join('\n'), /The checkout has no release-signers file; verifying against the pinned copy/);
});

test('a pinned signers file other users can write is refused', { skip: process.platform === 'win32' ? 'POSIX mode bits' : false }, async (t) => {
  const h = harness(t, { mode: 'release', pinned: SIGNERS_A, tags: [{ tag: 'v2.1.0' }] });
  chmodSync(h.pinnedFile, 0o666);
  assert.equal(await h.run(), 1);
  assert.match(h.err.join('\n'), /can be written by other users.*chmod 600/);
  assert.deepEqual(h.state.verifiedAgainst, []);
  assert.deepEqual(npmAndRestartCalls(h.commandLines()), []);
});

test('--to installs the named release, even when newer ones exist, and refuses an older, missing, or unverified one', async (t) => {
  const named = harness(t, { mode: 'to', to: '2.1.0', tags: [{ tag: 'v2.2.0' }, { tag: 'v2.1.0' }] });
  assert.equal(await named.run(), 0, named.err.join('\n'));
  assert.ok(named.commandLines().includes('git checkout -q --detach v2.1.0'));
  assert.equal(named.version(), '2.1.0');
  assert.deepEqual(named.state.verifiedAgainst, [named.pinnedFile], 'only the named tag is verified');

  const older = harness(t, { mode: 'to', to: '1.9.0', tags: [{ tag: 'v2.1.0' }, { tag: 'v1.9.0' }] });
  assert.equal(await older.run(), 1);
  assert.match(older.err.join('\n'), /v1\.9\.0 is not newer than the running 2\.0\.0\. Moving back is a deliberate git checkout/);
  assert.deepEqual(older.state.verifiedAgainst, [], 'not even verified');
  const same = harness(t, { mode: 'to', to: '2.0.0', tags: [{ tag: 'v2.0.0' }] });
  assert.equal(await same.run(), 1);
  assert.match(same.err.join('\n'), /not newer/);

  const missing = harness(t, { mode: 'to', to: '2.5.0', tags: [{ tag: 'v2.1.0' }] });
  assert.equal(await missing.run(), 1);
  assert.match(missing.err.join('\n'), /there is no release tag v2\.5\.0 \(the newest is v2\.1\.0\)/);

  const unverified = harness(t, { mode: 'to', to: '2.1.0', tags: [{ tag: 'v2.1.0', verifies: false }] });
  assert.equal(await unverified.run(), 1);
  assert.match(unverified.err.join('\n'), /v2\.1\.0 does not verify against the pinned signers: No principal matched\. Nothing installed/);
  for (const h of [older, same, missing, unverified]) {
    assert.deepEqual(npmAndRestartCalls(h.commandLines()), []);
    assert.equal(h.version(), '2.0.0');
    assert.deepEqual(listSnapshots(join(h.dataDir, 'backups')), []);
  }
});

test('a release whose package.json is not the tag version is rolled back before npm ci runs', async (t) => {
  const h = harness(t, { mode: 'release', tags: [{ tag: 'v2.1.0', version: '2.0.5' }] });
  assert.equal(await h.run(), 1);
  assert.match(h.err.join('\n'), /the release v2\.1\.0 says version 2\.0\.5 in its package\.json, not 2\.1\.0/);
  const lines = h.commandLines();
  assert.ok(lines.includes('git checkout -q --detach v2.1.0'));
  assert.ok(lines.includes('git checkout -q --force main'), 'back on the branch it started from');
  assert.deepEqual(npmAndRestartCalls(lines), [], 'npm never ran on the mislabelled release, and the daemon was never touched');
  assert.equal(h.version(), '2.0.0');
  assert.equal(h.distFile('dist'), 'old');
  assert.match(h.out.join('\n'), /was not restarted and runs 2\.0\.0 as before/);
  const status = readUpdateStatus(h.dbPath);
  assert.equal(status.lastResult?.ok, false);
  assert.match(status.lastResult!.message, /Rolled back: the release v2\.1\.0 says version 2\.0\.5/);
  assert.equal(status.running, '2.0.0');
  assert.deepEqual(listSnapshots(join(h.dataDir, 'backups')), [], 'the daemon was never stopped, so nothing was snapshotted');
});

test('a release update that fails its health check rolls back to the branch and the old version', async (t) => {
  const h = harness(t, { mode: 'release', tags: [{ tag: 'v2.1.0' }], fail: 'health' });
  assert.equal(await h.run(), 1);
  assert.ok(h.commandLines().includes('git checkout -q --force main'));
  assert.equal(h.version(), '2.0.0');
  assert.equal(h.state.daemonVersion, '2.0.0');
  assert.equal(h.distFile('dist'), 'old');
  assert.match(h.out.join('\n'), /Rolled back\. The daemon is up on port 8790 running 2\.0\.0/);
});

test('--check reports the newest verified release, the skipped tags, and writes it to the status file', async (t) => {
  const h = harness(t, { checkOnly: true, tags: [{ tag: 'v2.3.0', verifies: false }, { tag: 'v2.2.0', notes: 'Two point two\u0001\n\nAdds a migration.' }, { tag: 'v2.1.0' }], changed: ['command-center/src/core/schema.ts'] });
  writeUpdateStatus(h.dbPath, { ...emptyUpdateStatus(), updaterInstalled: true, lastRunAt: '2026-10-06T03:59:00.000Z', running: '2.0.0' });
  assert.equal(await h.run(), 0, h.err.join('\n'));
  const text = h.out.join('\n');
  assert.match(text, /v2\.2\.0 \(2\.2\.0\) at bbbbbbb verifies/);
  assert.match(text, /Release notes:\n  Two point two\n  \n  Adds a migration\./);
  assert.match(text, /v2\.2\.0 is available\. Run cc update --release to install it/);
  assert.deepEqual(h.err, ['Skipped v2.3.0: No principal matched']);
  assert.deepEqual(h.state.verifiedAgainst, [h.pinnedFile, h.pinnedFile], 'v2.3.0 and v2.2.0; v2.1.0 is not looked at');
  assert.equal(h.pinned(), SIGNERS_A, '--check pins on first use too');
  assert.deepEqual(npmAndRestartCalls(h.commandLines()), []);
  assert.ok(!h.commandLines().some((l) => l.startsWith('git checkout') || l.startsWith('git merge')));
  assert.equal(h.version(), '2.0.0');
  const status = readUpdateStatus(h.dbPath);
  assert.deepEqual(status.available, { version: '2.2.0', notes: 'Two point two\n\nAdds a migration.', touchesSchema: true });
  assert.match(status.lastCheckAt ?? '', /^2026-10-06T04:00:\d\d\.000Z$/, 'the moment of the check');
  assert.equal(status.updaterInstalled, true, 'left as it was');
  assert.equal(status.lastRunAt, '2026-10-06T03:59:00.000Z');
  assert.equal(status.lastResult, null);
});

test('--check with nothing newer, or an empty pinned file, writes available: null and still exits 0', async (t) => {
  const nothing = harness(t, { checkOnly: true, tags: [{ tag: 'v2.0.0' }] });
  writeUpdateStatus(nothing.dbPath, { ...emptyUpdateStatus(), available: { version: '2.0.0', notes: '', touchesSchema: false } });
  assert.equal(await nothing.run(), 0);
  assert.equal(readUpdateStatus(nothing.dbPath).available, null, 'a stale entry is cleared');
  assert.ok(readUpdateStatus(nothing.dbPath).lastCheckAt);
  const empty = harness(t, { checkOnly: true, pinned: SIGNERS_NONE, tags: [{ tag: 'v2.1.0' }] });
  assert.equal(await empty.run(), 0);
  assert.match(empty.err.join('\n'), /Releases: no release can verify: the pinned signers file .* has no keys/);
  assert.equal(readUpdateStatus(empty.dbPath).available, null);
  assert.ok(readUpdateStatus(empty.dbPath).lastCheckAt);
});

test('from a release tag, --release moves to the next verified release and a rollback returns to that commit', async (t) => {
  const h = harness(t, { mode: 'release', branch: null, tag: 'v2.0.0', tags: [{ tag: 'v2.1.0' }, { tag: 'v2.0.0' }] });
  assert.equal(await h.run(), 0, h.err.join('\n'));
  assert.match(h.out.join('\n'), /Running 2\.0\.0 on the release tag v2\.0\.0/);
  assert.deepEqual(h.state.verifiedAgainst, [h.pinnedFile, h.pinnedFile], 'the tag at HEAD and the target');
  assert.ok(!h.commandLines().some((l) => l.startsWith('git rev-list')), 'no branch to compare against');
  assert.equal(h.version(), '2.1.0');

  const rolled = harness(t, { mode: 'release', branch: null, tag: 'v2.0.0', tags: [{ tag: 'v2.1.0' }, { tag: 'v2.0.0' }], fail: 'build' });
  assert.equal(await rolled.run(), 1);
  assert.ok(rolled.commandLines().includes(`git checkout -q --force --detach ${PREVIOUS}`));
  assert.equal(rolled.version(), '2.0.0');

  const unverifiedStart = harness(t, { mode: 'release', branch: null, tag: 'v2.0.0', startVerifies: false, tags: [{ tag: 'v2.1.0' }, { tag: 'v2.0.0' }] });
  assert.equal(await unverifiedStart.run(), 1);
  assert.match(unverifiedStart.err.join('\n'), /the checkout is on v2\.0\.0, which does not verify against the pinned signers/);
  assert.deepEqual(npmAndRestartCalls(unverifiedStart.commandLines()), []);

  const toMain = harness(t, { branch: null, tag: 'v2.0.0' });
  assert.equal(await toMain.run(), 1, 'plain cc update from a tag is still refused');
  assert.match(toMain.err.join('\n'), /cc update --release moves between releases/);
});

test('--trust-signers shows both files with fingerprints, asks, and replaces the pinned copy', async (t) => {
  const first = harness(t, { yes: false });
  let asked = 0;
  assert.equal(await first.trust({ confirm: async () => { asked++; return true; } }), 0, first.err.join('\n'));
  assert.equal(asked, 1);
  const text = first.out.join('\n');
  assert.match(text, /Pinned \(.*release-signers\): nothing pinned yet/);
  assert.match(text, new RegExp(`Committed \\(.*release-signers\\):\\n  polaris-release  ssh-ed25519  ${FINGERPRINT.replace(/\+/g, '\\+')}`));
  assert.match(text, /Pinned 1 key to .*release-signers\. Releases verify against that copy from now on/);
  assert.equal(first.pinned(), SIGNERS_A);
  if (process.platform !== 'win32') assert.equal(statSync(first.pinnedFile).mode & 0o777, 0o600);
  assert.ok(first.commandLines().every((l) => l.startsWith('ssh-keygen -lf')), 'ssh-keygen is the only program');

  const same = harness(t, { yes: false, pinned: SIGNERS_A });
  assert.equal(await same.trust({ confirm: async () => { throw new Error('must not ask'); } }), 0);
  assert.match(same.out.join('\n'), /already allows the same keys\. Nothing changed/);

  const declined = harness(t, { yes: false, pinned: SIGNERS_A, committed: SIGNERS_B });
  assert.equal(await declined.trust({ confirm: async () => false }), 0);
  assert.match(declined.out.join('\n'), /Not changed\. Pass --yes/);
  assert.equal(declined.pinned(), SIGNERS_A);
  assert.match(declined.out.join('\n'), /Pinned \(.*\):\n  polaris-release  ssh-ed25519  SHA256:/);

  const replaced = harness(t, { yes: true, pinned: SIGNERS_A, committed: SIGNERS_B });
  assert.equal(await replaced.trust({ confirm: async () => { throw new Error('--yes asks nothing'); } }), 0);
  assert.equal(replaced.pinned(), SIGNERS_B);

  const emptied = harness(t, { yes: true, pinned: SIGNERS_A, committed: SIGNERS_NONE });
  assert.equal(await emptied.trust(), 0);
  assert.match(emptied.err.join('\n'), /The committed file has no keys: once pinned, no release can verify/);
  assert.equal(emptied.pinned(), SIGNERS_NONE);

  const noFile = harness(t, { yes: true, committed: null });
  assert.equal(await noFile.trust(), 1);
  assert.match(noFile.err.join('\n'), /there is no release-signers file at/);

  const noKeygen = harness(t, { yes: true });
  assert.equal(await noKeygen.trust({ exec: async () => ({ code: -1, stdout: '', stderr: 'ENOENT' }) }), 0);
  assert.match(noKeygen.out.join('\n'), /\(ssh-keygen is not installed\)/);
  assert.equal(noKeygen.pinned(), SIGNERS_A);
});

test('--trust-signers refuses a malformed committed file and a pinned file other users can write', { skip: process.platform === 'win32' ? 'POSIX mode bits' : false }, async (t) => {
  const malformed = harness(t, { yes: true, pinned: SIGNERS_A, committed: 'this is not a key line\n' });
  assert.equal(await malformed.trust(), 1);
  assert.match(malformed.err.join('\n'), /line 1 of the signers file/);
  assert.equal(malformed.pinned(), SIGNERS_A);
  const loose = harness(t, { yes: true, pinned: SIGNERS_A, committed: SIGNERS_B });
  chmodSync(loose.pinnedFile, 0o666);
  assert.equal(await loose.trust(), 1);
  assert.match(loose.err.join('\n'), /can be written by other users/);
});

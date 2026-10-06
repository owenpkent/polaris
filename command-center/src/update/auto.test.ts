// The scheduled updater against a scripted runner and a fake daemon: no git, npm, build, or
// restart is ever run, and the daemon's routes (GET /api/update, pickup, finish, identity,
// health) are answered by a fake fetch that keeps one request row the way the store would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../core/index.ts';
import { listSnapshots } from '../daemon/backup.ts';
import { identityProof } from '../http/identity.ts';
import { memorySecretStore } from '../ingest/secrets.ts';
import { BACKOFF_MS, QUIET_WINDOW_MS, quietWindow, runAuto, type AutoOptions } from './auto.ts';
import type { Exec, ExecResult } from './exec.ts';
import { runUpdate, updateLogPath, type UpdateDeps } from './run.ts';
import { pinnedSignersPath } from './signers.ts';
import { emptyUpdateStatus, readUpdateStatus, UPDATER_STOPPED_PREFIX, updaterStopped, writeUpdateStatus, type UpdateStatus } from './status.ts';

const PREVIOUS = 'a'.repeat(40);
const TARGET = 'b'.repeat(40);
const TOKEN = 'test-api-token';
const PORT = 8790;
const SIGNERS = 'polaris-release namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n';
/** Inside the default quiet window (04:00 UTC, one hour). */
const IN_WINDOW = '2026-10-06T04:30:00.000Z';
const OUTSIDE = '2026-10-06T12:00:00.000Z';

interface FakeTag { tag: string; verifies?: boolean }
interface FakeRequest { id: string; version: string; state: string; result?: string | null }

interface Scenario {
  running?: string;
  /** Commits origin/main is ahead by (never installed by --auto). Default 0. */
  behind?: number;
  tags?: FakeTag[];
  request?: FakeRequest | null;
  fail?: 'build' | 'health';
  /** The daemon's answer to the finish route throws, as a daemon still coming up would. */
  finishUnreachable?: boolean;
  /** The daemon is not listening at all. */
  daemonDown?: boolean;
  /** The daemon answers GET /api/update with this status instead of 200. */
  daemonAnswers?: number;
  status?: Partial<UpdateStatus>;
  updateAt?: string;
  timezone?: string;
}

interface Call { cmd: string; args: string[] }

function harness(t: { after(fn: () => void): void }, s: Scenario, at = OUTSIDE) {
  const root = mkdtempSync(join(tmpdir(), 'cc-update-auto-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const running = s.running ?? '2.0.0';
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
  writeFileSync(join(root, 'release-signers'), SIGNERS);
  if (s.status) writeUpdateStatus(dbPath, { ...emptyUpdateStatus(), ...s.status });
  const tags = s.tags ?? [];

  const state = {
    head: 'previous' as 'previous' | 'target',
    listening: !s.daemonDown,
    daemonVersion: running,
    request: s.request === undefined ? null : s.request,
    verified: [] as string[],
    http: [] as string[],
    finishBodies: [] as { ok: boolean; message: string }[],
  };
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
  const fail = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr });
  const version = () => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string;

  const exec: Exec = async (cmd, args) => {
    calls.push({ cmd, args });
    const line = `${cmd} ${args.join(' ')}`;
    if (cmd === 'git') {
      switch (args[0]) {
        case 'status': return ok('');
        case 'rev-parse':
          if (args[1] === '--abbrev-ref') return ok('main\n');
          return ok(`${args[2] === 'HEAD^{commit}' ? (state.head === 'target' ? TARGET : PREVIOUS) : TARGET}\n`);
        case 'tag':
          if (args[1] === '--points-at') return ok('');
          if (args[1] === '--list') return ok(tags.map((x) => x.tag).join('\n'));
          if (args[1] === '-l') return ok('tag\nNotes for the release\n');
          return fail(`unexpected ${line}`);
        case '-c': {
          const tag = args[5];
          state.verified.push(tag);
          return (tags.find((x) => x.tag === tag)?.verifies ?? true) ? ok() : fail('Good "git" signature with ED25519 key SHA256:other\nNo principal matched.');
        }
        case 'fetch': return ok();
        case 'rev-list': return ok(`0\t${s.behind ?? 0}\n`);
        case 'log': return ok('bbbbbbb feat: the newer thing\n');
        case 'diff': return ok('');
        case 'show': return ok(JSON.stringify({ version: '2.1.0' }));
        case 'merge': state.head = 'target'; writeVersion('2.1.0'); return ok();
        case 'checkout': {
          const ref = args[args.length - 1];
          if (/^v\d/.test(ref)) { state.head = 'target'; writeVersion(ref.slice(1)); return ok(); }
          if (ref === 'main') { state.head = 'previous'; writeVersion(running); return ok(); }
          return fail(`unexpected ${line}`);
        }
        case 'reset': state.head = 'previous'; writeVersion(running); return ok();
        default: return fail(`unexpected ${line}`);
      }
    }
    if (cmd === 'npm') return ok();
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
        state.daemonVersion = state.head === 'target' ? (s.fail === 'health' ? 'broken' : version()) : running;
        return ok();
      }
    }
    return fail(`unexpected ${line}`);
  };

  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    state.http.push(`${method} ${url.pathname}`);
    if (!state.listening) throw new Error('ECONNREFUSED');
    if (url.pathname === '/api/identity') return Response.json({ proof: identityProof(TOKEN, PORT, url.searchParams.get('challenge') ?? '') });
    const auth = new Headers(init?.headers).get('authorization');
    if (auth !== `Bearer ${TOKEN}`) return Response.json({ error: { code: 'Unauthorized', message: 'bad token' } }, { status: 401 });
    if (url.pathname === '/api/health') return Response.json({ ok: true, version: state.daemonVersion });
    if (url.pathname === '/api/update' && method === 'GET') {
      if (s.daemonAnswers) return Response.json({ error: { code: 'Boom', message: 'the daemon is unwell' } }, { status: s.daemonAnswers });
      return Response.json({ running, updaterInstalled: true, available: null, request: state.request, lastResult: null, command: 'x' });
    }
    const m = /^\/api\/update\/requests\/([^/]+)\/(pickup|finish)$/.exec(url.pathname);
    if (m && method === 'POST') {
      const [, id, verb] = m;
      const row = state.request;
      if (!row || row.id !== id) return Response.json({ error: { code: 'NotFound', message: 'no such request' } }, { status: 404 });
      if (verb === 'pickup') {
        if (row.state !== 'pending') return Response.json({ error: { code: 'Conflict', message: `cannot pick up a request that is ${row.state}` } }, { status: 409 });
        row.state = 'picked_up';
        return Response.json({ request: row });
      }
      if (s.finishUnreachable) throw new Error('ECONNREFUSED');
      const body = JSON.parse(String(init?.body)) as { ok: boolean; message: string };
      state.finishBodies.push(body);
      if (row.state !== 'picked_up') return Response.json({ error: { code: 'Conflict', message: `cannot finish a request that is ${row.state}` } }, { status: 409 });
      row.state = body.ok ? 'done' : 'failed';
      row.result = body.message;
      return Response.json({ request: row });
    }
    return new Response('', { status: 404 });
  };

  let clock = Date.parse(at);
  const deps: UpdateDeps = {
    exec,
    fetch: fetchFn,
    now: () => new Date((clock += 1000)),
    sleep: async () => {},
    portListening: async () => state.listening,
    platform: 'linux',
    env: {},
    secrets: memorySecretStore(),
    confirm: async () => { throw new Error('--auto must never ask'); },
  };
  const opts: AutoOptions = {
    repoRoot: root, dbPath, dashboardDir: dist, port: PORT, timezone: s.timezone ?? 'UTC', updateAt: s.updateAt, restartSpec: 'systemd-user:polaris',
    stdout: (l) => out.push(l), stderr: (l) => err.push(l),
  };
  const run = (overrides: Partial<UpdateDeps> = {}) => runAuto(opts, { ...deps, ...overrides });
  const byHand = () => runUpdate({ repoRoot: root, dbPath, dashboardDir: dist, port: PORT, target: { kind: 'release' }, checkOnly: false, yes: true, restartSpec: 'systemd-user:polaris', stdout: (l) => out.push(l), stderr: (l) => err.push(l) }, deps);
  const commandLines = () => calls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
  const gitAndMore = () => commandLines().filter((l) => /^(git (fetch|merge|checkout|reset)|npm|npx|systemctl --user (stop|start))/.test(l));
  return {
    root, dbPath, dataDir, dist, state, calls, out, err, deps, opts, run, byHand, commandLines, gitAndMore, version,
    status: () => readUpdateStatus(dbPath),
    setClock: (iso: string) => { clock = Date.parse(iso); },
    reset: () => { calls.length = 0; state.http.length = 0; out.length = 0; err.length = 0; },
    pinnedFile: pinnedSignersPath(dbPath),
    log: () => (existsSync(updateLogPath(dbPath)) ? readFileSync(updateLogPath(dbPath), 'utf8') : ''),
  };
}

test('quietWindow: one hour from CC_UPDATE_AT in the given zone', () => {
  assert.equal(QUIET_WINDOW_MS, 60 * 60_000);
  assert.deepEqual(quietWindow('04:00', 'UTC', new Date('2026-10-06T04:00:00Z')), { open: true, start: new Date('2026-10-06T04:00:00Z') });
  assert.equal(quietWindow('04:00', 'UTC', new Date('2026-10-06T04:59:59Z')).open, true);
  assert.equal(quietWindow('04:00', 'UTC', new Date('2026-10-06T05:00:00Z')).open, false);
  assert.equal(quietWindow('04:00', 'UTC', new Date('2026-10-06T03:59:00Z')).open, false);
  assert.deepEqual(quietWindow('04:00', 'UTC', new Date('2026-10-06T03:59:00Z')).start, new Date('2026-10-05T04:00:00Z'));
  // 22:00 in Chicago (CDT, UTC-5) is 03:00Z.
  assert.equal(quietWindow('22:00', 'America/Chicago', new Date('2026-10-06T03:30:00Z')).open, true);
  assert.equal(quietWindow('22:00', 'America/Chicago', new Date('2026-10-06T04:30:00Z')).open, false);
  assert.throws(() => quietWindow('4am', 'UTC', new Date()), /HH:MM/);
});

test('every run writes the heartbeat first, and a backed-off or stopped updater goes no further', async (t) => {
  const paused = harness(t, { status: { updaterInstalled: true, failures: 1, backoffUntil: '2026-10-07T12:00:00.000Z' }, tags: [{ tag: 'v2.1.0' }] });
  assert.equal(await paused.run(), 0);
  assert.equal(paused.status().updaterInstalled, true);
  assert.match(paused.status().lastRunAt ?? '', /^2026-10-06T12:00:/);
  assert.equal(paused.status().backoffUntil, '2026-10-07T12:00:00.000Z', 'left as it was');
  assert.deepEqual(paused.calls, [], 'no program ran');
  assert.deepEqual(paused.state.http, [], 'the daemon was not even asked');
  assert.deepEqual([paused.out, paused.err], [[], []], 'quiet: the file says why');

  const stopped = harness(t, { status: { updaterInstalled: true, failures: 3, backoffUntil: null, lastResult: { ok: false, message: `${UPDATER_STOPPED_PREFIX}: 3 updates in a row failed`, at: OUTSIDE, version: '2.0.0' } }, tags: [{ tag: 'v2.1.0' }] });
  assert.equal(await stopped.run(), 0);
  assert.deepEqual(stopped.calls, []);
  assert.deepEqual(stopped.state.http, []);
  assert.equal(updaterStopped(stopped.status()), true);

  // A backoff that has passed is over.
  const over = harness(t, { status: { updaterInstalled: true, failures: 1, backoffUntil: '2026-10-06T11:00:00.000Z' }, tags: [{ tag: 'v2.1.0' }] });
  assert.equal(await over.run(), 0);
  assert.deepEqual(over.state.http, ['GET /api/update']);
  assert.ok(over.commandLines().includes('git fetch --prune --tags origin'), 'the daily check ran');
});

test('a pending request is picked up, re-verified, installed through the --to path, and finished as done', async (t) => {
  const h = harness(t, { request: { id: 'up_0000000001', version: '2.1.0', state: 'pending' }, tags: [{ tag: 'v2.2.0' }, { tag: 'v2.1.0' }] });
  assert.equal(await h.run(), 0, h.err.join('\n'));
  assert.deepEqual(h.state.http.slice(0, 2), ['GET /api/update', 'POST /api/update/requests/up_0000000001/pickup']);
  assert.equal(h.state.http.at(-1), 'POST /api/update/requests/up_0000000001/finish');
  assert.deepEqual(h.state.finishBodies, [{ ok: true, message: 'Updated to v2.1.0' }]);
  assert.equal(h.state.request?.state, 'done');
  assert.deepEqual(h.state.verified, ['v2.1.0'], 'the requested tag, not the newest, verified against the pinned signers');
  assert.equal(readFileSync(h.pinnedFile, 'utf8'), SIGNERS, 'pinned on first use');
  const lines = h.commandLines();
  assert.ok(lines.includes('git checkout -q --detach v2.1.0'));
  assert.ok(!lines.some((l) => l.startsWith('git merge')), 'main is never installed');
  assert.ok(lines.indexOf('npx vite build --outDir ' + h.dist + '.next --emptyOutDir') < lines.indexOf('systemctl --user stop polaris'));
  assert.equal(h.version(), '2.1.0');
  assert.equal(h.state.daemonVersion, '2.1.0');
  assert.equal(listSnapshots(join(h.dataDir, 'backups')).length, 1, 'the snapshot was taken');
  const status = h.status();
  assert.equal(status.updaterInstalled, true, 'the heartbeat survives the install');
  assert.deepEqual(status.request, { id: 'up_0000000001', state: 'done', message: 'Updated to v2.1.0', finishedAt: status.request?.finishedAt });
  assert.match(status.request?.finishedAt ?? '', /^2026-10-06T12:00:/);
  assert.equal(status.running, '2.1.0');
  assert.equal(status.lastResult?.ok, true);
  assert.equal(status.failures, 0);
  assert.equal(status.backoffUntil, null);
  assert.equal(status.problem ?? null, null);
  assert.match(h.log(), /cc update --auto: picked up the request up_0000000001 for v2\.1\.0/);
  assert.ok(!h.log().includes(TOKEN) && !h.out.join('\n').includes(TOKEN) && !h.err.join('\n').includes(TOKEN), 'the api token is never printed');
});

test('while the install runs the status file says Updating, which the daemon reconciles from if the finish call never lands', async (t) => {
  const h = harness(t, { request: { id: 'up_0000000002', version: '2.1.0', state: 'pending' }, tags: [{ tag: 'v2.1.0' }], finishUnreachable: true });
  const seen: string[] = [];
  const code = await h.run({ exec: async (cmd, args, o) => { if (cmd === 'npm' && args[0] === 'ci') seen.push(h.status().request?.message ?? 'none'); return h.deps.exec(cmd, args, o); } });
  assert.equal(code, 0, h.err.join('\n'));
  assert.deepEqual([...new Set(seen)], ['Updating'], 'the panel reads Updating during the install');
  assert.equal(h.state.http.at(-1), 'POST /api/update/requests/up_0000000002/finish', 'finish was tried');
  assert.deepEqual(h.state.finishBodies, [], 'and never arrived');
  assert.equal(h.state.request?.state, 'picked_up', 'the row did not move in the daemon');
  assert.deepEqual(h.status().request, { id: 'up_0000000002', state: 'done', message: 'Updated to v2.1.0', finishedAt: h.status().request?.finishedAt }, 'the file carries the outcome');
  assert.match(h.err.join('\n'), /the status file carries the outcome of request up_0000000002/);
  assert.equal(h.version(), '2.1.0');
});

test('a request that is not newer, or whose tag does not verify, is finished as failed with the reason and installs nothing', async (t) => {
  const stale = harness(t, { request: { id: 'up_0000000003', version: '2.0.0', state: 'pending' }, tags: [{ tag: 'v2.0.0' }] });
  assert.equal(await stale.run(), 1);
  assert.equal(stale.state.finishBodies.length, 1);
  assert.equal(stale.state.finishBodies[0].ok, false);
  assert.match(stale.state.finishBodies[0].message, /v2\.0\.0 is not newer than the running 2\.0\.0/);
  assert.equal(stale.state.request?.state, 'failed');
  assert.deepEqual(stale.state.verified, [], 'not even verified');
  assert.deepEqual(stale.gitAndMore(), ['git fetch --prune --tags origin'], 'fetched, nothing more');

  const forged = harness(t, { request: { id: 'up_0000000004', version: '2.1.0', state: 'pending' }, tags: [{ tag: 'v2.1.0', verifies: false }] });
  assert.equal(await forged.run(), 1);
  assert.equal(forged.state.finishBodies[0].ok, false);
  assert.match(forged.state.finishBodies[0].message, /v2\.1\.0 does not verify against the pinned signers: No principal matched/);
  assert.deepEqual(forged.gitAndMore(), ['git fetch --prune --tags origin']);
  assert.equal(forged.version(), '2.0.0');
  assert.deepEqual(listSnapshots(join(forged.dataDir, 'backups')), [], 'no snapshot for a refusal');
  for (const h of [stale, forged]) {
    assert.equal(h.status().request?.state, 'failed');
    assert.equal(h.status().request?.message, h.state.finishBodies[0].message);
    assert.equal(h.status().failures, undefined, 'a refusal is not a failed install: no backoff');
    assert.equal(h.status().backoffUntil, null);
    assert.equal(h.status().lastResult, null);
  }
});

test('a request that was gone before the pickup (409) is left alone and the run carries on to the daily check', async (t) => {
  const h = harness(t, { request: { id: 'up_0000000005', version: '2.1.0', state: 'pending' }, tags: [{ tag: 'v2.1.0' }] });
  // The owner cancelled it between the read and the pickup.
  const code = await h.run({ fetch: async (input, init) => { if (String(input).endsWith('/pickup')) h.state.request!.state = 'cancelled'; return h.deps.fetch(input, init); } });
  assert.equal(code, 0, h.err.join('\n'));
  assert.deepEqual(h.state.finishBodies, []);
  assert.match(h.err.join('\n'), /the request up_0000000005 was gone before it could be picked up \(POST .* answered 409 \(cannot pick up a request that is cancelled\)\)/);
  assert.equal(h.status().request, null, 'nothing recorded for a request that was never taken');
  assert.ok(h.commandLines().includes('git fetch --prune --tags origin'), 'the daily check (outside the window, a refresh) still ran');
  assert.equal(h.version(), '2.0.0');
});

test('inside the quiet window the first run fetches the tags, writes the check, and installs the newest verified newer release', async (t) => {
  const h = harness(t, { tags: [{ tag: 'v2.2.0', verifies: false }, { tag: 'v2.1.0' }, { tag: 'v2.0.0' }] }, IN_WINDOW);
  assert.equal(await h.run(), 0, h.err.join('\n'));
  assert.deepEqual(h.state.http.filter((l) => l.startsWith('GET /api/update')), ['GET /api/update']);
  assert.deepEqual(h.state.verified, ['v2.2.0', 'v2.1.0'], 'newest first, the forged one skipped');
  assert.ok(h.commandLines().includes('git checkout -q --detach v2.1.0'));
  assert.equal(h.version(), '2.1.0');
  assert.equal(h.state.daemonVersion, '2.1.0');
  const status = h.status();
  assert.match(status.lastCheckAt ?? '', /^2026-10-06T04:30:/, 'the check is recorded');
  assert.equal(status.available, null, 'what was available is now installed');
  assert.equal(status.running, '2.1.0');
  assert.equal(status.lastResult?.ok, true);
  assert.equal(status.request, null);
  assert.match(h.log(), /the quiet window \(04:00 UTC, one hour\) is open/);

  // The window follows CC_UPDATE_AT in the daemon's zone: 22:00 Chicago is 03:00Z.
  const evening = harness(t, { tags: [{ tag: 'v2.1.0' }], updateAt: '22:00', timezone: 'America/Chicago' }, '2026-10-06T03:20:00.000Z');
  assert.equal(await evening.run(), 0, evening.err.join('\n'));
  assert.equal(evening.version(), '2.1.0');
  const morning = harness(t, { tags: [{ tag: 'v2.1.0' }], updateAt: '22:00', timezone: 'America/Chicago' }, IN_WINDOW);
  assert.equal(await morning.run(), 0, morning.err.join('\n'));
  assert.equal(morning.version(), '2.0.0', '04:30Z is outside a 22:00 Chicago window: refreshed, not installed');
  assert.equal(morning.status().available?.version, '2.1.0');
});

test('inside the window with nothing newer, the check is still written and nothing is installed', async (t) => {
  const h = harness(t, { tags: [{ tag: 'v2.0.0' }] }, IN_WINDOW);
  assert.equal(await h.run(), 0, h.err.join('\n'));
  assert.deepEqual(h.gitAndMore(), ['git fetch --prune --tags origin']);
  assert.match(h.status().lastCheckAt ?? '', /^2026-10-06T04:30:/);
  assert.equal(h.status().available, null);
  assert.equal(h.status().lastResult, null);
  assert.equal(h.status().failures, undefined);
});

test('outside the window a stale check only refreshes what is available, and nothing is installed', async (t) => {
  const h = harness(t, { tags: [{ tag: 'v2.1.0' }], status: { updaterInstalled: true, lastCheckAt: '2026-10-04T04:10:00.000Z' } }, OUTSIDE);
  assert.equal(await h.run(), 0, h.err.join('\n'));
  assert.deepEqual(h.gitAndMore(), ['git fetch --prune --tags origin']);
  assert.deepEqual(h.state.verified, ['v2.1.0']);
  assert.equal(h.version(), '2.0.0');
  assert.equal(h.state.daemonVersion, '2.0.0');
  const status = h.status();
  assert.deepEqual(status.available, { version: '2.1.0', notes: 'Notes for the release', touchesSchema: false });
  assert.match(status.lastCheckAt ?? '', /^2026-10-06T12:00:/);
  assert.equal(status.lastResult, null);
  assert.deepEqual(listSnapshots(join(h.dataDir, 'backups')), []);
  assert.match(h.log(), /the last check was at 2026-10-04T04:10:00\.000Z: refreshing what is available\. Outside the quiet window nothing is installed/);
  assert.ok(!h.log().includes('origin/main'), 'the updater does not look at main, even to report it');
});

test('the check happens once a day: a recent check means no fetch, inside the window or outside it', async (t) => {
  const inside = harness(t, { tags: [{ tag: 'v2.1.0' }], status: { updaterInstalled: true, lastCheckAt: '2026-10-06T04:05:00.000Z' } }, IN_WINDOW);
  assert.equal(await inside.run(), 0);
  assert.deepEqual(inside.calls, [], 'checked already in this window');
  assert.deepEqual(inside.state.http, ['GET /api/update']);
  const outside = harness(t, { tags: [{ tag: 'v2.1.0' }], status: { updaterInstalled: true, lastCheckAt: '2026-10-06T04:05:00.000Z' } }, OUTSIDE);
  assert.equal(await outside.run(), 0);
  assert.deepEqual(outside.calls, [], 'eight hours old: not yet');
  // A check in yesterday's window is before today's window opened, so today's window is due, even
  // though it is not yet a full day old: the rule is "once per window", which never drifts.
  const due = harness(t, { tags: [{ tag: 'v2.1.0' }], status: { updaterInstalled: true, lastCheckAt: '2026-10-05T04:40:00.000Z' } }, '2026-10-06T04:05:00.000Z');
  assert.equal(await due.run(), 0, due.err.join('\n'));
  assert.ok(due.commandLines().includes('git checkout -q --detach v2.1.0'));
  // Outside the window, a day and a bit since a refresh is due again.
  const stale = harness(t, { tags: [{ tag: 'v2.1.0' }], status: { updaterInstalled: true, lastCheckAt: '2026-10-05T11:00:00.000Z' } }, OUTSIDE);
  assert.equal(await stale.run(), 0);
  assert.deepEqual(stale.gitAndMore(), ['git fetch --prune --tags origin']);
});

test('the backoff ladder: a day, three days, then the updater stops and waits, and a run by hand clears the count', async (t) => {
  const h = harness(t, { tags: [{ tag: 'v2.1.0' }], fail: 'build' }, IN_WINDOW);
  assert.equal(await h.run(), 1);
  let status = h.status();
  assert.equal(status.failures, 1);
  assert.match(status.backoffUntil ?? '', /^2026-10-07T04:30:/, 'one day');
  assert.ok(Date.parse(status.backoffUntil!) - Date.parse(IN_WINDOW) >= BACKOFF_MS[0]);
  assert.equal(status.lastResult?.ok, false);
  assert.match(status.lastResult?.message ?? '', /^Rolled back: vite build failed/);
  assert.equal(h.version(), '2.0.0');
  assert.equal(updaterStopped(status), false);
  assert.match(h.err.join('\n'), /failure 1 in a row: no automatic install before 2026-10-07T04:30/);

  // Five minutes later: paused.
  h.reset();
  h.setClock('2026-10-06T04:35:00.000Z');
  assert.equal(await h.run(), 0);
  assert.deepEqual(h.calls, []);

  // The next window, after the day: the second failure backs off three days.
  h.reset();
  h.setClock('2026-10-07T04:40:00.000Z');
  assert.equal(await h.run(), 1);
  status = h.status();
  assert.equal(status.failures, 2);
  assert.match(status.backoffUntil ?? '', /^2026-10-10T04:40:/, 'three days');

  // Three days on: the third failure stops the updater.
  h.reset();
  h.setClock('2026-10-10T04:45:00.000Z');
  assert.equal(await h.run(), 1);
  status = h.status();
  assert.equal(status.failures, 3);
  assert.equal(status.backoffUntil, null);
  assert.equal(updaterStopped(status), true);
  assert.equal(status.lastResult?.message, `${UPDATER_STOPPED_PREFIX}: 3 updates in a row failed, the last one: Rolled back: vite build failed (exit 1); the full output is in ${updateLogPath(h.dbPath)}. Run cc update --release by hand, which clears the count.`);
  assert.equal(status.updaterInstalled, true);

  // From now on every run is a heartbeat and nothing else.
  h.reset();
  h.setClock('2026-10-11T04:30:00.000Z');
  assert.equal(await h.run(), 0);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.state.http, []);
  assert.match(h.status().lastRunAt ?? '', /^2026-10-11T04:30/);

  // The owner runs cc update --release by hand: the count is cleared whatever the outcome.
  h.reset();
  assert.equal(await h.byHand(), 1, 'the build still fails');
  status = h.status();
  assert.equal(status.failures, 0);
  assert.equal(status.backoffUntil, null);
  assert.equal(updaterStopped(status), false);
  assert.equal(status.updaterInstalled, false, 'a run by hand says so');

  // And the updater tries again in the next window.
  h.reset();
  h.setClock('2026-10-12T04:30:00.000Z');
  assert.equal(await h.run(), 1);
  assert.equal(h.status().failures, 1);
  assert.equal(h.status().updaterInstalled, true);
});

test('a rollback after a failed health check counts as one failure and leaves the old version running', async (t) => {
  const h = harness(t, { request: { id: 'up_0000000006', version: '2.1.0', state: 'pending' }, tags: [{ tag: 'v2.1.0' }], fail: 'health' });
  assert.equal(await h.run(), 1);
  assert.equal(h.version(), '2.0.0');
  assert.equal(h.state.daemonVersion, '2.0.0');
  assert.equal(h.state.finishBodies[0].ok, false);
  assert.match(h.state.finishBodies[0].message, /^Rolled back: the health check failed: the daemon reports version broken, expected 2\.1\.0/);
  assert.equal(h.state.request?.state, 'failed');
  assert.equal(h.status().failures, 1);
  assert.match(h.status().backoffUntil ?? '', /^2026-10-07T12:0/);
});

test('--auto never installs main: commits on origin/main with no release tag install nothing', async (t) => {
  const h = harness(t, { behind: 5, tags: [] }, IN_WINDOW);
  assert.equal(await h.run(), 0, h.err.join('\n'));
  assert.deepEqual(h.gitAndMore(), ['git fetch --prune --tags origin']);
  assert.ok(!h.commandLines().some((l) => l.startsWith('git merge') || l.includes('origin/main:package.json')), 'main is neither read nor merged');
  assert.equal(h.version(), '2.0.0');
  assert.equal(h.status().available, null);
  const text = readFileSync(new URL('./auto.ts', import.meta.url), 'utf8');
  assert.ok(!text.includes("kind: 'main'"), 'auto.ts never names the main target');
});

test('a daemon that is not running, or answers wrongly, ends the run with the problem in the status file and nothing installed', async (t) => {
  const down = harness(t, { daemonDown: true, request: { id: 'up_0000000007', version: '2.1.0', state: 'pending' }, tags: [{ tag: 'v2.1.0' }] }, IN_WINDOW);
  assert.equal(await down.run(), 0);
  assert.deepEqual(down.calls, [], 'no program ran');
  assert.deepEqual(down.state.http, ['GET /api/update']);
  let status = down.status();
  assert.equal(status.updaterInstalled, true);
  assert.match(status.lastRunAt ?? '', /^2026-10-06T04:30/);
  assert.equal(status.problem, 'the daemon is not answering on port 8790 (ECONNREFUSED)');
  assert.equal(status.lastResult, null);
  assert.equal(status.lastCheckAt, null, 'no check either: nothing to restart into');
  assert.deepEqual(down.err, ['cc update --auto: the daemon is not answering on port 8790 (ECONNREFUSED). Nothing installed: there is no daemon to restart into.']);
  // Said once, then carried by the file.
  down.reset();
  assert.equal(await down.run(), 0);
  assert.deepEqual(down.err, []);
  // Back up: the problem clears and the run goes on.
  down.reset();
  down.state.listening = true;
  assert.equal(await down.run(), 0, down.err.join('\n'));
  status = down.status();
  assert.equal(status.problem, null);
  assert.equal(down.version(), '2.1.0', 'the request was taken this time');

  const unwell = harness(t, { daemonAnswers: 500, tags: [{ tag: 'v2.1.0' }] }, IN_WINDOW);
  assert.equal(await unwell.run(), 0);
  assert.deepEqual(unwell.calls, []);
  assert.equal(unwell.status().problem, 'GET /api/update answered 500 (the daemon is unwell)');
});

test('a bad CC_UPDATE_AT is reported and nothing runs', async (t) => {
  const h = harness(t, { tags: [{ tag: 'v2.1.0' }], updateAt: '4am' });
  assert.equal(await h.run(), 1);
  assert.match(h.err.join('\n'), /CC_UPDATE_AT is "4am"\. Use HH:MM/);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.state.http, []);
  assert.equal(existsSync(join(h.dataDir, 'update-status.json')), false, 'not even the heartbeat');
});

test('auto.ts sends nothing but the api token to the loopback daemon, and reads no secret store', () => {
  const text = readFileSync(new URL('./auto.ts', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!text.includes('secrets'), 'no secret store');
  assert.ok(!/github/i.test(text), 'nothing about GitHub');
  assert.match(text, /http:\/\/127\.0\.0\.1:\$\{opts\.port\}/, 'loopback only');
  assert.ok(!text.includes('import('), 'everything is a static import: the process keeps running the old code after the checkout moves');
});

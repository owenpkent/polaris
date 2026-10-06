import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { App } from '../app.ts';
import { emptyUpdateStatus, UPDATER_STOPPED_PREFIX, updateStatusPath, writeUpdateStatus, type UpdateStatus } from '../update/status.ts';
import { TEST_TOKENS, api, fakeApp, withServer } from './test-support.ts';
import { UPDATE_COMMAND, isNewerRelease } from './update-routes.ts';
import { VERSION } from './version.ts';

// The status file lives next to the database. The fake app's database is in memory, so its
// config is pointed at a scratch folder, where the tests write the file the updater would.
function scratchApp(t: { after(fn: () => void): void }): { app: App; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cc-update-routes-'));
  const app = fakeApp();
  const dbPath = join(dir, 'constellation.db');
  app.config.dbPath = dbPath;
  t.after(() => { app.close(); rmSync(dir, { recursive: true, force: true }); });
  return { app, dbPath };
}

/** The next patch release after what runs, which is what the updater would report as available. */
function bump(version: string, by: 'patch' | 'minor' = 'patch'): string {
  const [major, minor, patch] = version.split('.').map(Number);
  return by === 'patch' ? `${major}.${minor}.${patch + 1}` : `${major}.${minor + 1}.0`;
}

const NEWER = bump(VERSION);
const NOW = new Date().toISOString();

function installedStatus(extra: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    ...emptyUpdateStatus(),
    updaterInstalled: true,
    lastRunAt: NOW,
    running: VERSION,
    available: { version: NEWER, notes: 'Fixes the digest footer.', touchesSchema: false },
    ...extra,
  };
}

test('isNewerRelease: strictly newer by the MAJOR.MINOR.PATCH rule, and a malformed version never is', () => {
  assert.equal(isNewerRelease('2.1.0', '2.0.0'), true);
  assert.equal(isNewerRelease('2.0.1', '2.0.0'), true);
  assert.equal(isNewerRelease('3.0.0', '2.9.9'), true);
  assert.equal(isNewerRelease('2.10.0', '2.9.0'), true, 'numeric, not lexical');
  assert.equal(isNewerRelease('2.0.0', '2.0.0'), false);
  assert.equal(isNewerRelease('1.9.9', '2.0.0'), false);
  assert.equal(isNewerRelease('v2.1.0', '2.0.0'), false);
  assert.equal(isNewerRelease('2.1.0-rc1', '2.0.0'), false);
  assert.equal(isNewerRelease('2.1.0', 'main'), false);
});

test('GET /api/update: no status file means no updater, nothing available, and the command to copy', async (t) => {
  const { app } = scratchApp(t);
  await withServer(app, {}, async (base) => {
    const { status, json } = await api(base, 'GET', '/api/update');
    assert.equal(status, 200);
    assert.deepEqual(json, {
      running: VERSION, updaterInstalled: false, available: null, request: null, lastResult: null, command: UPDATE_COMMAND,
    });
    assert.equal(json.running, (await api(base, 'GET', '/api/health')).json.version, 'the same version /api/health reports');
  });
});

test('GET /api/update: reads the status file the updater wrote, and the heartbeat decides updaterInstalled', async (t) => {
  const { app, dbPath } = scratchApp(t);
  writeUpdateStatus(dbPath, installedStatus({ lastResult: { ok: false, message: 'Rolled back: the build failed', at: NOW, version: VERSION } }));
  await withServer(app, {}, async (base) => {
    let { json } = await api(base, 'GET', '/api/update');
    assert.equal(json.updaterInstalled, true);
    assert.deepEqual(json.available, { version: NEWER, notes: 'Fixes the digest footer.', touchesSchema: false });
    assert.equal(json.lastResult.message, 'Rolled back: the build failed');
    assert.equal(json.command, UPDATE_COMMAND);

    // A stale heartbeat: the updater is not installed, or has stopped.
    writeUpdateStatus(dbPath, installedStatus({ lastRunAt: new Date(Date.now() - 16 * 60_000).toISOString() }));
    ({ json } = await api(base, 'GET', '/api/update'));
    assert.equal(json.updaterInstalled, false);
    assert.equal(json.available.version, NEWER, 'the release still shows; the panel offers the command instead of a button');

    // A manual run leaves updaterInstalled false in the file, whatever the heartbeat.
    writeUpdateStatus(dbPath, installedStatus({ updaterInstalled: false }));
    ({ json } = await api(base, 'GET', '/api/update'));
    assert.equal(json.updaterInstalled, false);
  });
});

test('GET /api/update: an available version that is not newer than the running one never lights the icon', async (t) => {
  const { app, dbPath } = scratchApp(t);
  await withServer(app, {}, async (base) => {
    for (const version of [VERSION, '0.0.1', `v${NEWER}`, 'main']) {
      writeUpdateStatus(dbPath, installedStatus({ available: { version, notes: '', touchesSchema: false } }));
      const { json } = await api(base, 'GET', '/api/update');
      assert.equal(json.available, null, version);
    }
  });
});

test('POST /api/update/requests: the owner requests the available release and sees it pending on the next read', async (t) => {
  const { app, dbPath } = scratchApp(t);
  writeUpdateStatus(dbPath, installedStatus());
  await withServer(app, {}, async (base) => {
    const { status, json } = await api(base, 'POST', '/api/update/requests', { version: NEWER });
    assert.equal(status, 201);
    assert.equal(json.request.version, NEWER);
    assert.equal(json.request.state, 'pending');
    assert.equal(json.request.requestedBy, 'human');
    const read = await api(base, 'GET', '/api/update');
    assert.equal(read.json.request.id, json.request.id);
    assert.equal(read.json.request.state, 'pending');
    assert.equal(app.store.lastEventId(), 0, 'no event is recorded for an update request');
  });
});

test('POST /api/update/requests: refused without a version, with a malformed one, one not newer, or one the updater did not report', async (t) => {
  const { app, dbPath } = scratchApp(t);
  writeUpdateStatus(dbPath, installedStatus());
  await withServer(app, {}, async (base) => {
    assert.equal((await api(base, 'POST', '/api/update/requests', {})).status, 400);
    assert.equal((await api(base, 'POST', '/api/update/requests')).status, 400);
    for (const version of [`v${NEWER}`, 'main', '2.1', `${NEWER}-rc1`]) {
      const res = await api(base, 'POST', '/api/update/requests', { version });
      assert.equal(res.status, 400, version);
    }
    // Well formed, but not strictly newer than what runs.
    for (const version of [VERSION, '0.0.1']) {
      const res = await api(base, 'POST', '/api/update/requests', { version });
      assert.equal(res.status, 400, version);
      assert.match(res.json.error.message, /not newer/);
    }
    // Newer, but not what the updater reported: the panel can only ask for what it was shown.
    const other = await api(base, 'POST', '/api/update/requests', { version: bump(VERSION, 'minor') });
    assert.equal(other.status, 400);
    assert.match(other.json.error.message, /not the release the updater reported/);
    // Nothing extra travels with a request: no path, no URL, no branch.
    assert.equal((await api(base, 'POST', '/api/update/requests', { version: NEWER, ref: 'main' })).status, 400);
    assert.equal(app.store.currentUpdateRequest(), null);
  });
});

test('POST /api/update/requests: 409 while one is pending or picked up, and free again once it is finished', async (t) => {
  const { app, dbPath } = scratchApp(t);
  writeUpdateStatus(dbPath, installedStatus());
  await withServer(app, {}, async (base) => {
    const first = (await api(base, 'POST', '/api/update/requests', { version: NEWER })).json.request;
    let again = await api(base, 'POST', '/api/update/requests', { version: NEWER });
    assert.equal(again.status, 409);
    assert.equal(again.json.error.code, 'Conflict');
    assert.equal((await api(base, 'POST', `/api/update/requests/${first.id}/pickup`)).status, 200);
    again = await api(base, 'POST', '/api/update/requests', { version: NEWER });
    assert.equal(again.status, 409);
    assert.equal((await api(base, 'POST', `/api/update/requests/${first.id}/finish`, { ok: false, message: 'Rolled back: the build failed' })).status, 200);
    again = await api(base, 'POST', '/api/update/requests', { version: NEWER });
    assert.equal(again.status, 201);
    assert.notEqual(again.json.request.id, first.id);
  });
});

test('cancel: the owner takes a pending request back, and only a pending one', async (t) => {
  const { app, dbPath } = scratchApp(t);
  writeUpdateStatus(dbPath, installedStatus());
  await withServer(app, {}, async (base) => {
    const request = (await api(base, 'POST', '/api/update/requests', { version: NEWER })).json.request;
    const cancelled = await api(base, 'POST', `/api/update/requests/${request.id}/cancel`);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.json.request.state, 'cancelled');
    assert.equal((await api(base, 'POST', `/api/update/requests/${request.id}/cancel`)).status, 409);
    assert.equal((await api(base, 'POST', `/api/update/requests/${request.id}/pickup`)).status, 409);
    assert.equal((await api(base, 'POST', '/api/update/requests/up_missing000/cancel')).status, 404);

    const picked = (await api(base, 'POST', '/api/update/requests', { version: NEWER })).json.request;
    await api(base, 'POST', `/api/update/requests/${picked.id}/pickup`);
    assert.equal((await api(base, 'POST', `/api/update/requests/${picked.id}/cancel`)).status, 409, 'the updater has it');
  });
});

test('pickup and finish: the updater moves a pending row once, then reports the outcome once', async (t) => {
  const { app, dbPath } = scratchApp(t);
  writeUpdateStatus(dbPath, installedStatus());
  await withServer(app, {}, async (base) => {
    const request = (await api(base, 'POST', '/api/update/requests', { version: NEWER })).json.request;
    assert.equal((await api(base, 'POST', `/api/update/requests/${request.id}/finish`, { ok: true, message: 'early' })).status, 409, 'not picked up yet');

    const picked = await api(base, 'POST', `/api/update/requests/${request.id}/pickup`);
    assert.equal(picked.status, 200);
    assert.equal(picked.json.request.state, 'picked_up');
    assert.ok(picked.json.request.pickedUpAt);
    assert.equal((await api(base, 'POST', `/api/update/requests/${request.id}/pickup`)).status, 409, 'a second pickup');
    assert.equal((await api(base, 'GET', '/api/update')).json.request.state, 'picked_up');

    assert.equal((await api(base, 'POST', `/api/update/requests/${request.id}/finish`, { ok: true })).status, 400, 'a result needs a message');
    assert.equal((await api(base, 'POST', `/api/update/requests/${request.id}/finish`, { ok: 'yes', message: 'x' })).status, 400);
    const done = await api(base, 'POST', `/api/update/requests/${request.id}/finish`, { ok: true, message: `Updated to v${NEWER}` });
    assert.equal(done.status, 200);
    assert.equal(done.json.request.state, 'done');
    assert.equal(done.json.request.result, `Updated to v${NEWER}`);
    assert.equal((await api(base, 'POST', `/api/update/requests/${request.id}/finish`, { ok: false, message: 'again' })).status, 409);
    assert.equal((await api(base, 'POST', '/api/update/requests/up_missing000/pickup')).status, 404);
    assert.equal((await api(base, 'POST', '/api/update/requests/up_missing000/finish', { ok: true, message: 'x' })).status, 404);
  });
});

test('a pending request older than an hour is expired on the next read, and a late pickup finds it gone', async (t) => {
  const { app, dbPath } = scratchApp(t);
  writeUpdateStatus(dbPath, installedStatus());
  await withServer(app, {}, async (base) => {
    const request = (await api(base, 'POST', '/api/update/requests', { version: NEWER })).json.request;
    // Backdate the row: the fake clock cannot be moved from here, and the rule is on requested_at.
    const old = new Date(Date.parse(request.requestedAt) - 61 * 60_000).toISOString();
    app.store.db.run('UPDATE update_requests SET requested_at = ? WHERE id = ?', [old, request.id]);
    const read = await api(base, 'GET', '/api/update');
    assert.equal(read.json.request.id, request.id);
    assert.equal(read.json.request.state, 'expired');
    assert.equal((await api(base, 'POST', `/api/update/requests/${request.id}/pickup`)).status, 409);
    // The owner can ask again.
    assert.equal((await api(base, 'POST', '/api/update/requests', { version: NEWER })).status, 201);
  });
});

test('a picked-up request whose outcome only reached the status file is reconciled on the next read', async (t) => {
  const { app, dbPath } = scratchApp(t);
  writeUpdateStatus(dbPath, installedStatus());
  await withServer(app, {}, async (base) => {
    const request = (await api(base, 'POST', '/api/update/requests', { version: NEWER })).json.request;
    await api(base, 'POST', `/api/update/requests/${request.id}/pickup`);
    // The updater restarted the daemon and could not call finish: it wrote the file instead.
    writeUpdateStatus(dbPath, installedStatus({
      request: { id: request.id, state: 'done', message: `Updated to v${NEWER}`, finishedAt: NOW },
      lastResult: { ok: true, message: `Updated to v${NEWER}`, at: NOW, version: NEWER },
    }));
    const read = await api(base, 'GET', '/api/update');
    assert.equal(read.json.request.state, 'done');
    assert.equal(read.json.request.result, `Updated to v${NEWER}`);
    assert.equal(app.store.getUpdateRequest(request.id)?.state, 'done');

    // A file entry for another id, or one still in progress, changes nothing.
    const second = (await api(base, 'POST', '/api/update/requests', { version: NEWER })).json.request;
    await api(base, 'POST', `/api/update/requests/${second.id}/pickup`);
    writeUpdateStatus(dbPath, installedStatus({ request: { id: request.id, state: 'failed', message: 'old news', finishedAt: NOW } }));
    assert.equal((await api(base, 'GET', '/api/update')).json.request.state, 'picked_up');
    writeUpdateStatus(dbPath, installedStatus({ request: { id: second.id, state: 'picked_up', message: 'Updating', finishedAt: null } }));
    assert.equal((await api(base, 'GET', '/api/update')).json.request.state, 'picked_up');
    writeUpdateStatus(dbPath, installedStatus({ request: { id: second.id, state: 'failed', message: 'Rolled back: the build failed', finishedAt: NOW } }));
    const failed = (await api(base, 'GET', '/api/update')).json.request;
    assert.equal(failed.state, 'failed');
    assert.equal(failed.result, 'Rolled back: the build failed');
  });
});

test('GET /api/sync carries a failed update, and a stopped updater, as warnings read from the status file', async (t) => {
  const { app, dbPath } = scratchApp(t);
  const jobs = { backup: { lastRunAt: NOW, lastError: null, running: false } };
  await withServer(app, { getJobStatus: () => jobs }, async (base) => {
    assert.deepEqual((await api(base, 'GET', '/api/sync')).json.warnings, [], 'no status file');
    writeUpdateStatus(dbPath, installedStatus({ lastResult: { ok: true, message: 'Updated to 2.1.0', at: NOW, version: VERSION } }));
    assert.deepEqual((await api(base, 'GET', '/api/sync')).json.warnings, []);
    writeUpdateStatus(dbPath, installedStatus({ lastResult: { ok: false, message: 'Rolled back: the build failed', at: NOW, version: VERSION }, failures: 1, backoffUntil: NOW }));
    assert.deepEqual((await api(base, 'GET', '/api/sync')).json.warnings, [{ job: 'update', message: 'The last update failed: Rolled back: the build failed' }]);
    const stopped = `${UPDATER_STOPPED_PREFIX}: 3 updates in a row failed, the last one: Rolled back: the build failed. Run cc update --release by hand, which clears the count.`;
    writeUpdateStatus(dbPath, installedStatus({ lastResult: { ok: false, message: stopped, at: NOW, version: VERSION }, failures: 3, backoffUntil: null }));
    assert.deepEqual((await api(base, 'GET', '/api/sync')).json.warnings, [{ job: 'update', message: stopped }]);
    // The daemon reads the file; it never writes it.
    assert.equal(JSON.parse(readFileSync(updateStatusPath(dbPath), 'utf8')).failures, 3);
  });
});

test('every update route is /api: the mcp and read-only tokens get 401, and so does no token', async (t) => {
  const { app, dbPath } = scratchApp(t);
  writeUpdateStatus(dbPath, installedStatus());
  await withServer(app, {}, async (base) => {
    const routes: [string, string, unknown?][] = [
      ['GET', '/api/update'],
      ['POST', '/api/update/requests', { version: NEWER }],
      ['POST', '/api/update/requests/up_0000000000/cancel'],
      ['POST', '/api/update/requests/up_0000000000/pickup'],
      ['POST', '/api/update/requests/up_0000000000/finish', { ok: true, message: 'x' }],
    ];
    for (const token of [TEST_TOKENS.mcp, TEST_TOKENS.mcpReadonly, undefined]) {
      for (const [method, path, body] of routes) {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        });
        assert.equal(res.status, 401, `${method} ${path} with ${token ?? 'no token'}`);
      }
    }
    assert.equal(app.store.currentUpdateRequest(), null);
  });
});

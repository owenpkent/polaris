import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { Config } from '../config.ts';
import { resolveDashboardDir } from './commands.ts';
import { api, fakeApp, withServer } from './test-support.ts';

let dashboardDir: string;

before(async () => {
  dashboardDir = await mkdtemp(join(tmpdir(), 'cc-static-'));
  await writeFile(join(dashboardDir, 'index.html'), '<!doctype html><title>cc</title>');
  await mkdir(join(dashboardDir, 'assets'), { recursive: true });
  await writeFile(join(dashboardDir, 'assets', 'app-abc123.js'), 'console.log(1)');
  await writeFile(join(dashboardDir, 'assets', 'style.css'), 'body {}');
  await writeFile(join(dashboardDir, '.secret'), 'nope');
  await mkdir(join(dashboardDir, 'sub'), { recursive: true });
  await writeFile(join(dashboardDir, 'sub', 'index.html'), '<!doctype html><title>sub</title>');
});

after(async () => {
  await rm(dashboardDir, { recursive: true, force: true, maxRetries: 3 });
});

// fetch() normalizes ".." segments in a URL before the request ever leaves the client, so it
// cannot exercise the traversal cases below. This sends the exact raw request-target instead.
function rawRequest(base: string, method: string, rawPath: string): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  const url = new URL(base);
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest({ hostname: url.hostname, port: url.port, method, path: rawPath }, (res) => {
      res.resume();
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET / serves the dashboard shell', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, { dashboardDir }, async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    assert.ok(res.headers.get('etag'));
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    // The shell must never be framed: with a saved connection, an embedded copy would act on
    // clicks the user cannot see. The header travels with the cached copy in the service worker.
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'none'");
    assert.equal(await res.text(), '<!doctype html><title>cc</title>');
  });
});

test('HEAD / returns the same Content-Length with an empty body', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, { dashboardDir }, async (base) => {
    const getRes = await fetch(`${base}/`);
    const length = getRes.headers.get('content-length');
    await getRes.text();

    const headRes = await fetch(`${base}/`, { method: 'HEAD' });
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers.get('content-length'), length);
    assert.equal(await headRes.text(), '');
  });
});

test('GET /assets/app-abc123.js is immutable-cached JS', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, { dashboardDir }, async (base) => {
    const res = await fetch(`${base}/assets/app-abc123.js`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  });
});

test('a matching If-None-Match gets 304 with an empty body', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, { dashboardDir }, async (base) => {
    const first = await fetch(`${base}/`);
    const etag = first.headers.get('etag')!;
    await first.text();

    const second = await fetch(`${base}/`, { headers: { 'If-None-Match': etag } });
    assert.equal(second.status, 304);
    assert.equal(await second.text(), '');
  });
});

test('GET /missing.txt is the server JSON 404', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, { dashboardDir }, async (base) => {
    const res = await fetch(`${base}/missing.txt`);
    assert.equal(res.status, 404);
    const json = await res.json() as { error: { code: string } };
    assert.equal(json.error.code, 'NotFound');
  });
});

test('GET /sub and GET /sub/ are both 404 (no subfolder index)', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, { dashboardDir }, async (base) => {
    assert.equal((await fetch(`${base}/sub`)).status, 404);
    assert.equal((await fetch(`${base}/sub/`)).status, 404);
  });
});

test('GET /.secret (dotfile) is 404', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, { dashboardDir }, async (base) => {
    assert.equal((await fetch(`${base}/.secret`)).status, 404);
  });
});

test('raw traversal and malformed paths all resolve to 404', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, { dashboardDir }, async (base) => {
    const paths = [
      '/../package.json',
      '/assets/%2e%2e/%2e%2e/package.json',
      '/assets/..%5c..%5cpackage.json',
      '/index.html%00.txt',
      '/%zz',
    ];
    for (const p of paths) {
      const { status } = await rawRequest(base, 'GET', p);
      assert.equal(status, 404, `expected 404 for ${p}`);
    }
  });
});

test('POST / is 405 with an Allow header', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, { dashboardDir }, async (base) => {
    const res = await fetch(`${base}/`, { method: 'POST' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET, HEAD');
  });
});

test('static serving never shadows the API', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, { dashboardDir }, async (base) => {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 401);

    const nope = await api(base, 'GET', '/api/nope');
    assert.equal(nope.status, 404);
    assert.equal(nope.json.error.code, 'NotFound');
  });
});

test('with no dashboardDir, GET / is the JSON 404 (unchanged behavior)', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 404);
    const json = await res.json() as { error: { code: string } };
    assert.equal(json.error.code, 'NotFound');
  });
});

test('resolveDashboardDir returns the dir when index.html exists', () => {
  const config: Config = { repoRoot: '', dbPath: '', timezone: 'UTC', dashboardDir };
  const lines: string[] = [];
  assert.equal(resolveDashboardDir(config, (l) => lines.push(l)), dashboardDir);
  assert.equal(lines.length, 0);
});

test('resolveDashboardDir returns undefined and logs one line when index.html is missing', () => {
  const missingDir = join(dashboardDir, 'does-not-exist');
  const config: Config = { repoRoot: '', dbPath: '', timezone: 'UTC', dashboardDir: missingDir };
  const lines: string[] = [];
  assert.equal(resolveDashboardDir(config, (l) => lines.push(l)), undefined);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /not found; run 'npm run build'/);
});

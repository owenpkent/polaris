// Exploit attempts kept as tests. They were first run by hand on 2026-11-14 against a scratch
// server, for the Dependabot alerts on hono and @hono/node-server (a backslash in the path read as
// a separator, checks skipped for odd content types and paths, a reset during an upgrade), and
// nothing got through. They stay so that a change to the request handling, the router, or a
// dependency that parses requests has to keep that true.
//
// Every request goes out on a raw socket, so the request target and the headers reach the server
// exactly as written: fetch and curl tidy a path before sending it.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { App } from '../app.ts';
import { TAILNET_HOST, TEST_TOKENS, fakeApp, withServer } from './test-support.ts';

interface RawResponse { status: number; head: string; body: string }

/** One request, written byte for byte. `headers` is a list so a header can be sent twice. */
function raw(base: string, method: string, target: string, headers: [string, string][] = [], body?: string): Promise<RawResponse> {
  const { port, host } = new URL(base);
  return new Promise((resolve) => {
    const sock = net.connect(Number(port), '127.0.0.1');
    let data = '';
    const lines = [`${method} ${target} HTTP/1.1`, 'Connection: close', ...headers.map(([k, v]) => `${k}: ${v}`)];
    if (!headers.some(([k]) => k.toLowerCase() === 'host')) lines.push(`Host: ${host}`);
    if (body !== undefined) lines.push('Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`);
    sock.setTimeout(5000, () => sock.destroy());
    sock.on('connect', () => sock.write(`${lines.join('\r\n')}\r\n\r\n${body ?? ''}`));
    sock.on('data', (d) => {
      data += d;
      // An MCP answer is an event stream the server leaves open: one whole event is the answer.
      const at = data.indexOf('\r\n\r\n');
      if (at > 0 && /content-type: text\/event-stream/i.test(data.slice(0, at)) && /\n\n|\r\n\r\n/.test(data.slice(at + 4))) sock.destroy();
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      const [head, ...rest] = data.split('\r\n\r\n');
      resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1] ?? 0), head, body: rest.join('\r\n\r\n') });
    });
  });
}

const bearer = (token: string): [string, string] => ['Authorization', `Bearer ${token}`];
const MCP_ACCEPT: [string, string] = ['Accept', 'application/json, text/event-stream'];
const createTaskCall = (title: string): string => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_task', arguments: { title } } });
const taskCount = (app: App): number => app.store.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks', [])?.n ?? -1;
const refused = (r: RawResponse): boolean => r.status >= 400 && r.status < 500;

// Spellings of a path that a parser could read as /api/tasks while a check reads something else.
const API_SPELLINGS = [
  '/api/tasks', '\\api\\tasks', '/api\\tasks', '/\\api/tasks', '//api/tasks', '/\\/api/tasks', '/x/..\\api\\tasks', '/x\\..\\api\\tasks',
  '/assets\\..\\api\\tasks', '/assets/../api/tasks', '/%5capi%5ctasks', '/api%5ctasks', '/api%2ftasks', '/%2e%2e/api/tasks', '/api/./tasks',
  '/api/health/..\\tasks', '/api/identity\\..\\tasks', '/api/identity/../tasks', '/api/identity/%2e%2e/tasks', '/webhooks/github\\..\\..\\api\\tasks',
  '/API/tasks', '/api/tasks;x', '/api/tasks%00', '/api/tasks%0a', '/api%0a/tasks', '/api/tasks%0d%0a', '/api/tasks%E2%80%A8', '/api\t/tasks',
  'http://127.0.0.1/api/tasks', 'http://evil.example\\@127.0.0.1/api/tasks', '/api/tasks?x=\\..\\', '/api\\sync', '/api\\events', '/api\\backup\\settings', '/api\\update',
];
const MCP_SPELLINGS = [
  '/mcp', '\\mcp', '/mcp\\', '/mcp/', '//mcp', '/x\\..\\mcp', '/x/../mcp', '/%5cmcp', '/mcp%0a', '/mcp%E2%80%A8', '/MCP',
  '/mcp/readonly', '/mcp\\readonly', '/mcp/readonly\\..', '/api/identity\\..\\..\\mcp',
];

test('no spelling of an /api or /mcp path is answered without a token', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  app.store.createTask({ title: 'private' }, 'human');
  await withServer(app, {}, async (base) => {
    for (const target of API_SPELLINGS) {
      const r = await raw(base, 'GET', target);
      assert.ok(refused(r), `GET ${JSON.stringify(target)} answered ${r.status}`);
      assert.ok(!r.body.includes('private'), `GET ${JSON.stringify(target)} leaked a task`);
    }
    for (const target of MCP_SPELLINGS) {
      const r = await raw(base, 'POST', target, [MCP_ACCEPT], createTaskCall(`no token via ${target}`));
      assert.ok(refused(r), `POST ${JSON.stringify(target)} answered ${r.status}`);
    }
    assert.equal(taskCount(app), 1);
  });
});

test('a token opens its own door only, however the path is spelled', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    // The probe itself works: the write token on /mcp creates a task.
    const allowed = await raw(base, 'POST', '/mcp', [bearer(TEST_TOKENS.mcp), MCP_ACCEPT], createTaskCall('allowed'));
    assert.equal(allowed.status, 200);
    assert.equal(taskCount(app), 1);

    // The read-only token never writes: its own endpoint has no such tool, and no spelling of its
    // path lands on the write endpoint.
    for (const target of ['/mcp/readonly', '/mcp', '/mcp/readonly\\..', '/mcp/readonly/..', '/mcp/readonly/%2e%2e', '/mcp/readonly\\..\\', '/mcp/readonly/../../mcp',
      '/mcp\\readonly\\..\\..\\mcp', '/mcp/readonly\\..\\..\\mcp', '/mcp/readonly?x=/mcp', '/mcp/readonly#/mcp', '/mcp/readonly/..;/']) {
      await raw(base, 'POST', target, [bearer(TEST_TOKENS.mcpReadonly), MCP_ACCEPT], createTaskCall(`read-only via ${target}`));
      assert.equal(taskCount(app), 1, `the read-only token wrote through ${JSON.stringify(target)}`);
    }

    // Neither MCP token opens /api, and the api token opens neither MCP endpoint.
    for (const token of [TEST_TOKENS.mcp, TEST_TOKENS.mcpReadonly]) {
      for (const target of ['/api/tasks', '/mcp\\..\\api\\tasks', '/mcp/../api/tasks', '/mcp/readonly\\..\\..\\api\\tasks', '/api\\tasks']) {
        const r = await raw(base, 'GET', target, [bearer(token)]);
        assert.equal(r.status, 401, `an MCP token got ${r.status} on ${JSON.stringify(target)}`);
      }
    }
    for (const target of ['/mcp', '/mcp/readonly', '/api/../mcp', '/api\\..\\mcp']) {
      const r = await raw(base, 'POST', target, [bearer(TEST_TOKENS.api), MCP_ACCEPT], createTaskCall('api token on mcp'));
      assert.equal(r.status, 401, `the api token got ${r.status} on ${JSON.stringify(target)}`);
    }
    assert.equal(taskCount(app), 1);
  });
});

// The shapes two of the hono advisories were about (a hyperlink-audit ping that a CSRF check let
// through, a multipart form whose extra parameters skipped validation). Polaris runs neither
// check, so what matters is that neither shape is taken as a write.
test('a ping or a form post is never taken as a task, with or without the token', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const post = (headers: [string, string][], body: string) => {
      const { port } = new URL(base);
      return new Promise<number>((resolve) => {
        const sock = net.connect(Number(port), '127.0.0.1');
        let data = '';
        sock.on('connect', () => sock.write(['POST /api/tasks HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Connection: close', ...headers.map(([k, v]) => `${k}: ${v}`), `Content-Length: ${Buffer.byteLength(body)}`, '', body].join('\r\n')));
        sock.on('data', (d) => { data += d; });
        sock.on('error', () => {});
        sock.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1] ?? 0)));
      });
    };
    const form = '--x\r\nContent-Disposition: form-data; name="title"\r\n\r\nfrom a form\r\n--x--\r\n';
    assert.equal(await post([['Content-Type', 'text/ping'], ['Origin', 'https://evil.example'], ['Ping-To', 'http://127.0.0.1/']], 'PING'), 401);
    assert.equal(await post([['Content-Type', 'multipart/form-data; charset=utf-8; boundary=x; x=y']], form), 401);
    assert.equal(await post([bearer(TEST_TOKENS.api), ['Content-Type', 'text/ping']], 'PING'), 400);
    assert.equal(await post([bearer(TEST_TOKENS.api), ['Content-Type', 'multipart/form-data; boundary=x; x=y']], form), 400);
    assert.equal(taskCount(app), 0);
  });
});

test('upgrades and half-sent calls cut off by a reset leave the server answering', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const { port } = new URL(base);
    const cutOff = (request: string, afterMs: number) => new Promise<void>((resolve) => {
      const sock = net.connect(Number(port), '127.0.0.1');
      const timer = setTimeout(resolve, 1500);
      sock.on('error', () => {});
      sock.on('close', () => { clearTimeout(timer); resolve(); });
      sock.on('connect', () => { sock.write(request); setTimeout(() => sock.resetAndDestroy(), afterMs); });
    });
    const upgrade = (target: string, token?: string) => [`GET ${target} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', ...(token ? [`Authorization: Bearer ${token}`] : []), '', ''].join('\r\n');
    const halfCall = `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${TEST_TOKENS.mcp}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: 5000\r\n\r\n{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{`;
    const call = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tasks', arguments: {} } });
    const fullCall = `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${TEST_TOKENS.mcp}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: ${Buffer.byteLength(call)}\r\n\r\n${call}`;
    for (const target of ['/mcp', '/mcp/readonly', '/api/events', '/']) {
      for (const token of [undefined, TEST_TOKENS.api, TEST_TOKENS.mcp]) {
        await Promise.all([cutOff(upgrade(target, token), 0), cutOff(upgrade(target, token), 3), cutOff(upgrade(target, token).slice(0, -2), 1)]);
      }
    }
    for (let i = 0; i < 6; i++) await Promise.all([cutOff(halfCall, i % 3), cutOff(fullCall, i % 4)]);

    const health = await raw(base, 'GET', '/api/health', [bearer(TEST_TOKENS.api)]);
    assert.equal(health.status, 200);
    const stillServes = await raw(base, 'POST', '/mcp', [bearer(TEST_TOKENS.mcp), MCP_ACCEPT], call);
    assert.equal(stillServes.status, 200);
  });
});

// ---- Tailscale identity switched on (tailscale.ts). A loopback peer that sends the owner's login
// to this machine's tailnet name is the owner on /api by design: that is what `tailscale serve`
// forwards. Everything else below is what must still be refused.

const LOGIN = 'owner@example.com';
const login = (value = LOGIN): [string, string] => ['Tailscale-User-Login', value];
const OWN_ORIGIN = `https://${TAILNET_HOST}`;
/** A request as the proxy forwards it: addressed to the tailnet name, whatever else it carries. */
const viaProxy = (base: string, method: string, target: string, headers: [string, string][] = [], body?: string): Promise<RawResponse> =>
  raw(base, method, target, [['Host', TAILNET_HOST], ...headers], body);
const identityOn = { tailscaleLogin: LOGIN, corsOrigins: ['https://localhost'], identityWriteOrigins: ['https://localhost'] };

test('identity: only the one configured login, in the one header, is the owner', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, identityOn, async (base) => {
    assert.equal((await viaProxy(base, 'GET', '/api/tasks', [login()])).status, 200);
    for (const value of ['attacker@example.com', 'owner@example.com.evil.example', 'owner@example.co', 'xowner@example.com', 'owner@example.com x', 'owner@example.com;attacker@example.com',
      'owner@example.com, attacker@example.com', 'attacker@example.com, owner@example.com', '"owner@example.com"', 'owner%40example.com', 'owner@exaⅿple.com', '*', '']) {
      const r = await viaProxy(base, 'GET', '/api/tasks', [login(value)]);
      assert.ok(refused(r), `login ${JSON.stringify(value)} answered ${r.status}`);
    }
    assert.ok(refused(await viaProxy(base, 'GET', '/api/tasks', [login('attacker@example.com'), login()])), 'two login headers were taken as one');
    assert.ok(refused(await viaProxy(base, 'GET', '/api/tasks', [login(), login()])), 'a repeated login header was taken as one');
    for (const name of ['Tailscale_User_Login', 'X-Tailscale-User-Login', 'Tailscale-User-Name', 'X-Forwarded-User']) {
      assert.ok(refused(await viaProxy(base, 'GET', '/api/tasks', [[name, LOGIN]])), `header ${name} was taken as the login`);
    }
  });
});

test('identity never opens MCP, under any spelling of the path', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, identityOn, async (base) => {
    for (const target of ['/mcp', '/mcp/readonly', '/api/../mcp', '/api\\..\\mcp', '/api/identity/../../mcp']) {
      const r = await viaProxy(base, 'POST', target, [login(), MCP_ACCEPT, ['Origin', OWN_ORIGIN], ['Sec-Fetch-Site', 'same-origin']], createTaskCall('identity on mcp'));
      assert.equal(r.status, 401, `identity got ${r.status} on ${JSON.stringify(target)}`);
    }
    assert.equal(taskCount(app), 0);
  });
});

test('identity: a write is taken from the dashboard\'s own origin or a listed one, and from no other page', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, identityOn, async (base) => {
    const host = TAILNET_HOST;
    const write = (headers: [string, string][]) => viaProxy(base, 'POST', '/api/tasks', [login(), ...headers], JSON.stringify({ title: 'a write' }));
    assert.equal((await write([['Origin', OWN_ORIGIN]])).status, 201);
    assert.equal((await write([['Origin', 'https://localhost']])).status, 201);
    const elsewhere: [string, string][][] = [
      [],
      [['Origin', 'https://evil.example']],
      [['Origin', 'null']],
      [['Origin', `http://${host}.evil.example`]],
      [['Origin', `http://${host}@evil.example`]],
      [['Origin', `https://${host}:1`]],
      [['Origin', 'https://evil.example'], ['Sec-Fetch-Site', 'cross-site']],
      [['Origin', OWN_ORIGIN], ['Sec-Fetch-Site', 'cross-site']],
      [['Origin', 'https://evil.example'], ['Sec-Fetch-Site', 'same-site']],
      [['Sec-Fetch-Site', 'none']],
      [['Origin', 'http://localhost:5173']],
      [['Origin', 'https://localhost/']],
      [['Origin', 'http://localhost']],
      [['Origin', 'HTTPS://LOCALHOST']],
      [['Origin', 'https://localhost:443']],
      [['Referer', `${OWN_ORIGIN}/`]],
    ];
    for (const headers of elsewhere) {
      const r = await write(headers);
      assert.equal(r.status, 403, `a write with ${JSON.stringify(headers)} answered ${r.status}`);
    }
    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      const r = await viaProxy(base, method, '/api/tasks/t_none', [login(), ['Origin', 'https://evil.example']], method === 'DELETE' ? undefined : '{}');
      assert.equal(r.status, 403, `${method} from another site answered ${r.status}`);
    }
    assert.equal(taskCount(app), 2);
  });
});

test('identity: another site can neither send the login header itself nor read a stamped answer', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, identityOn, async (base) => {
    const preflight = (origin: string) => viaProxy(base, 'OPTIONS', '/api/tasks', [['Origin', origin], ['Access-Control-Request-Method', 'GET'], ['Access-Control-Request-Headers', 'tailscale-user-login']]);
    for (const origin of ['https://evil.example', 'null', 'http://localhost:5173']) {
      const r = await preflight(origin);
      assert.equal(r.status, 403, `a preflight from ${origin} answered ${r.status}`);
      assert.ok(!/access-control-allow-origin/i.test(r.head), `a preflight from ${origin} was granted`);
    }
    // The listed origin (the Android app) may call, but is not allowed to send the login header:
    // only the proxy on this machine adds it.
    const listed = await preflight('https://localhost');
    assert.equal(listed.status, 204);
    assert.ok(!/access-control-allow-headers:.*(tailscale-user-login|\*)/i.test(listed.head), 'the listed origin may send the login header');
    // A read the proxy stamped for a page on another site is answered, but with no CORS grant, so
    // the browser keeps the answer from that page.
    const read = await viaProxy(base, 'GET', '/api/tasks', [login(), ['Origin', 'https://evil.example']]);
    assert.ok(!/access-control-allow-origin/i.test(read.head), 'a stamped read was granted to another site');
  });
});

// The one attempt that got through on 2026-11-14, before identity looked at the Host. A website open
// in a browser on the daemon's own machine re-points its own name at 127.0.0.1 (DNS rebinding). Its
// page is then same-origin to the daemon, so it may add the login header itself and read the answer,
// and its requests arrive from loopback. The Host is the name the page was loaded under.
test('identity: the login of the owner sent to a name outside the tailnet is not the owner', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  app.store.createTask({ title: 'private' }, 'human');
  await withServer(app, identityOn, async (base) => {
    const { host: loopback, port } = new URL(base);
    for (const host of [`attacker.example:${port}`, 'attacker.example', loopback, `localhost:${port}`, `polaris.ts.net.attacker.example:${port}`, 'ts.net', `${TAILNET_HOST}.`]) {
      const page: [string, string][] = [['Host', host], login(), ['Origin', `http://${host}`], ['Sec-Fetch-Site', 'same-origin']];
      const read = await raw(base, 'GET', '/api/tasks', page);
      assert.equal(read.status, 401, `a read addressed to ${host} answered ${read.status}`);
      assert.ok(!read.body.includes('private'), `a read addressed to ${host} leaked a task`);
      const write = await raw(base, 'POST', '/api/tasks', page, JSON.stringify({ title: 'planted' }));
      assert.equal(write.status, 401, `a write addressed to ${host} answered ${write.status}`);
    }
    assert.equal(taskCount(app), 1);
    // Addressed to the tailnet name, the same login is the owner.
    assert.equal((await viaProxy(base, 'GET', '/api/tasks', [login()])).status, 200);
  });
});

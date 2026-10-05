import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { identityProof } from './identity.ts';
import { TEST_TOKENS, api, authHeaders, fakeApp, withServer } from './test-support.ts';

/** HMAC-SHA256 over "constellation-identity\n8788\n<challenge>" keyed with the test api token. */
const IDENTITY_VECTOR = 'c5645df43c6953e54e585515e6a4e5df0eb628a16ba1d28ec57314c0cf266db6';

test('requires a bearer token on /api routes', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 401);
    const json = await res.json() as { error: { code: string } };
    assert.equal(json.error.code, 'Unauthorized');
  });
});

test('rejects a wrong bearer token', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const res = await fetch(`${base}/api/health`, { headers: { Authorization: 'Bearer nope' } });
    assert.equal(res.status, 401);
  });
});

test('accepts the configured token', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const { status, json } = await api(base, 'GET', '/api/health');
    assert.equal(status, 200);
    assert.equal(json.ok, true);
  });
});

test('bearer auth is also required on /mcp', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const mcpRes = await fetch(`${base}/mcp`, { method: 'GET', headers: { Accept: 'text/event-stream' } });
    assert.equal(mcpRes.status, 401);
  });
});

test('CORS: an allowed origin gets the header, a disallowed one does not', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, { corsOrigins: ['http://localhost:5173'] }, async (base) => {
    const ok = await fetch(`${base}/api/health`, { headers: { ...authHeaders(), Origin: 'http://localhost:5173' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173');

    const bad = await fetch(`${base}/api/health`, { headers: { ...authHeaders(), Origin: 'http://evil.example' } });
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
    // CORS is a browser-side concern: the server still answers the (bearer-authorized) request.
    assert.equal(bad.status, 200);
  });
});

test('CORS preflight: allowed origin gets 204 with headers, disallowed origin is rejected', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, { corsOrigins: ['http://localhost:5173'] }, async (base) => {
    const ok = await fetch(`${base}/api/tasks`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.ok(ok.headers.get('access-control-allow-methods')?.includes('POST'));

    const bad = await fetch(`${base}/api/tasks`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(bad.status, 403);
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
  });
});

test('a body over 1 MB is rejected with 413 before it is fully buffered', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const big = 'a'.repeat(1024 * 1024 + 10);
    const { status, json } = await api(base, 'POST', '/api/tasks', { title: big });
    assert.equal(status, 413);
    assert.equal(json.error.code, 'PayloadTooLarge');
  });
});

test('a non-JSON content type on a body is rejected with 400', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const res = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'text/plain' },
      body: 'title=hi',
    });
    assert.equal(res.status, 400);
  });
});

test('unknown route is 404, wrong method on a known route is 405 with an Allow header', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const notFound = await api(base, 'GET', '/api/does-not-exist');
    assert.equal(notFound.status, 404);
    assert.equal(notFound.json.error.code, 'NotFound');

    const res = await fetch(`${base}/api/tasks`, { method: 'DELETE', headers: authHeaders() });
    assert.equal(res.status, 405);
    assert.ok(res.headers.get('allow'));
  });
});

test('validation errors map to 400 ValidationError, not-found errors to 404 NotFoundError', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const bad = await api(base, 'POST', '/api/tasks', {});
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'ValidationError');
    assert.equal(typeof bad.json.error.message, 'string');

    const missing = await api(base, 'GET', '/api/tasks/does-not-exist');
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, 'NotFoundError');
  });
});

test('error responses never include a stack trace', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const { json } = await api(base, 'GET', '/api/tasks/does-not-exist');
    assert.equal(Object.keys(json.error).sort().join(','), 'code,message');
    assert.ok(!('stack' in json.error));
  });
});

// ------------------------------------------------------------ request target

/** Sends the exact bytes and returns the status line: fetch() would never let a malformed target out. */
function rawBytes(base: string, request: string): Promise<string> {
  const url = new URL(base);
  return new Promise((resolvePromise, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) }, () => socket.write(request));
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => { received += chunk; });
    socket.on('end', () => resolvePromise(received.split('\r\n')[0] ?? ''));
    socket.on('error', reject);
  });
}

test('a malformed request target is a 400, not the end of the process, and the server goes on serving', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    // `//[/` used to be parsed as an authority with an invalid host. It threw out of the request
    // listener, before any token check, and took the daemon down with ERR_INVALID_URL. It is now
    // a path (404). An absolute-form target that cannot be a URL at all is refused with a 400.
    const audit = await rawBytes(base, 'GET //[/ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    assert.match(audit, /^HTTP\/1\.1 404 /);
    const absolute = await rawBytes(base, 'GET http://[/ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    assert.match(absolute, /^HTTP\/1\.1 400 /);
    const { status, json } = await api(base, 'GET', '/api/health');
    assert.equal(status, 200);
    assert.equal(json.ok, true);
  });
});

test('a target with two leading slashes is a path on this server, not another host', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const statusLine = await rawBytes(base, 'GET //evil.example/api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    // No token, and the path does not start with /api/, so it falls through to the 404.
    assert.match(statusLine, /^HTTP\/1\.1 404 /);
  });
});

// ------------------------------------------------------------ framing

test('every response forbids framing, so an embedded dashboard cannot be clicked through', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const responses = [
      await fetch(`${base}/api/health`, { headers: authHeaders() }),
      await fetch(`${base}/api/health`),
      await fetch(`${base}/nowhere`),
      await fetch(`${base}/mcp`, { method: 'GET', headers: { Accept: 'text/event-stream' } }),
    ];
    for (const res of responses) {
      assert.equal(res.headers.get('x-frame-options'), 'DENY', `${res.url} ${res.status}`);
      assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'none'", `${res.url} ${res.status}`);
    }
  });
});

// ------------------------------------------------------------ identity

test('GET /api/identity proves the server holds the api token without being sent it, and reveals nothing else', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const port = Number(new URL(base).port);
    const challenge = randomBytes(32).toString('hex');
    const res = await fetch(`${base}/api/identity?challenge=${challenge}`);
    assert.equal(res.status, 200);
    const json = await res.json() as { proof: string };
    assert.deepEqual(Object.keys(json), ['proof']);
    assert.equal(json.proof, identityProof(TEST_TOKENS.api, port, challenge));
    assert.notEqual(json.proof, identityProof('another-token', port, challenge));
    assert.notEqual(json.proof, identityProof(TEST_TOKENS.api, port + 1, challenge), 'the proof is bound to the port the request reached');
    assert.ok(!json.proof.includes(TEST_TOKENS.api));

    for (const bad of ['', 'short', 'not-hex-'.repeat(8), 'A'.repeat(64), 'f'.repeat(130)]) {
      assert.equal((await fetch(`${base}/api/identity?challenge=${bad}`)).status, 400, `challenge ${JSON.stringify(bad)}`);
    }
    // Only GET is open: the route table has no other method, and POST still needs the token.
    assert.equal((await fetch(`${base}/api/identity?challenge=${challenge}`, { method: 'POST' })).status, 401);
  });
});

test('the identity proof matches the vector the desktop shell tests against', () => {
  // Shared with desktop/src-tauri/src/main.rs (identity_proof_matches_the_daemon). Changing the
  // message format means updating both.
  assert.equal(
    identityProof('test-api-token-0000000000000000', 8788, '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'),
    IDENTITY_VECTOR,
  );
});

test('Tailscale identity: the configured login through the proxy stands in for the api token on /api, and nowhere else', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const login = 'owner@example.com';
  await withServer(app, { tailscaleLogin: login }, async (base) => {
    // What `tailscale serve` on this machine adds to a request from one of the owner's devices.
    // The test server listens on 127.0.0.1, so the peer is loopback, as the proxy's is.
    const viaProxy = { 'Tailscale-User-Login': login };
    const ok = await fetch(`${base}/api/health`, { headers: viaProxy });
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json() as { auth: unknown }).auth, { via: 'tailscale', login });
    // The token path is unchanged, and health says which one it was.
    assert.deepEqual((await api(base, 'GET', '/api/health')).json.auth, { via: 'token' });
    // The header is an alternative to the token, not an extra check: a bad token beside it is fine.
    assert.equal((await fetch(`${base}/api/health`, { headers: { ...viaProxy, Authorization: 'Bearer nope' } })).status, 200);
    // Without the header, or with another tailnet user's login, nothing changed.
    assert.equal((await fetch(`${base}/api/health`)).status, 401);
    assert.equal((await fetch(`${base}/api/health`, { headers: { 'Tailscale-User-Login': 'guest@example.com' } })).status, 401);
    // It is the owner: a mutation goes through, and is recorded as the human, as the token's are.
    const before = app.store.lastEventId();
    const made = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { ...viaProxy, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'From the phone' }) });
    assert.equal(made.status, 201);
    for (const e of app.store.eventsSince(before)) assert.equal(e.actor, 'human');
    // Never MCP: agents keep their tokens.
    for (const path of ['/mcp', '/mcp/readonly']) {
      const res = await fetch(`${base}${path}`, { method: 'GET', headers: { ...viaProxy, Accept: 'text/event-stream' } });
      assert.equal(res.status, 401, path);
    }
  });
});

test('Tailscale identity is off until a login is configured', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const res = await fetch(`${base}/api/health`, { headers: { 'Tailscale-User-Login': 'owner@example.com' } });
    assert.equal(res.status, 401);
    assert.deepEqual((await api(base, 'GET', '/api/health')).json.auth, { via: 'token' });
  });
});

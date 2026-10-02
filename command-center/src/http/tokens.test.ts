// Each of /api, /mcp, and /mcp/readonly is gated by its own bearer token (ApiTokens in types.ts).
// These tests cover every cross-token combination: a token must work on its own route and be
// rejected everywhere else, so holding one token never grants access another token guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_TOKENS, fakeApp, withServer } from './test-support.ts';

// Accept: application/json (no text/event-stream) so a GET that does pass auth on /mcp or
// /mcp/readonly gets a quick 406 from the MCP layer instead of opening a long-lived SSE stream.
async function hit(base: string, path: string, token: string): Promise<number> {
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  return res.status;
}

test('each token is accepted on its own route', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    assert.equal(await hit(base, '/api/health', TEST_TOKENS.api), 200);
    // Not 401: the token was accepted, and the request went on to fail on the SDK's own Accept check.
    assert.notEqual(await hit(base, '/mcp', TEST_TOKENS.mcp), 401);
    assert.notEqual(await hit(base, '/mcp/readonly', TEST_TOKENS.mcpReadonly), 401);
  });
});

test('the api token does not work on /mcp or /mcp/readonly', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    assert.equal(await hit(base, '/mcp', TEST_TOKENS.api), 401);
    assert.equal(await hit(base, '/mcp/readonly', TEST_TOKENS.api), 401);
  });
});

test('the mcp token does not work on /api or /mcp/readonly', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    assert.equal(await hit(base, '/api/health', TEST_TOKENS.mcp), 401);
    assert.equal(await hit(base, '/mcp/readonly', TEST_TOKENS.mcp), 401);
  });
});

test('the mcp-readonly token does not work on /api or /mcp', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    assert.equal(await hit(base, '/api/health', TEST_TOKENS.mcpReadonly), 401);
    assert.equal(await hit(base, '/mcp', TEST_TOKENS.mcpReadonly), 401);
  });
});

test('an agent holding only the mcp token cannot enable a rule through REST', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const rule = app.store.saveRule({
    name: 'stays disabled',
    enabled: false,
    definition: { trigger: { type: 'schedule', condition: 'overdue' }, conditions: [], actions: [{ type: 'notify', message: 'hi' }] },
  });
  await withServer(app, {}, async (base) => {
    const res = await fetch(`${base}/api/rules/${rule.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${TEST_TOKENS.mcp}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(res.status, 401);
    assert.equal(app.store.getRule(rule.id)?.enabled, false);
  });
});

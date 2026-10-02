import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { fakeApp, withServer } from './test-support.ts';

const SECRET = 'wh-test-secret';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

test('the webhook route is 404 when no webhookSecret is configured', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const res = await fetch(`${base}/webhooks/github`, {
      method: 'POST',
      headers: { 'x-github-event': 'ping' },
      body: '{}',
    });
    assert.equal(res.status, 404);
  });
});

test('the webhook route rejects a bad signature with 401, without needing a bearer token', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, { webhookSecret: SECRET }, async (base) => {
    const body = JSON.stringify({ zen: 'hello' });
    const res = await fetch(`${base}/webhooks/github`, {
      method: 'POST',
      headers: { 'x-github-event': 'ping', 'x-hub-signature-256': 'sha256=not-right' },
      body,
    });
    assert.equal(res.status, 401);
  });
});

test('a correctly signed ping is accepted with no Authorization header at all', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, { webhookSecret: SECRET }, async (base) => {
    const body = JSON.stringify({ zen: 'hello' });
    const res = await fetch(`${base}/webhooks/github`, {
      method: 'POST',
      headers: { 'x-github-event': 'ping', 'x-hub-signature-256': sign(body) },
      body,
    });
    assert.equal(res.status, 200);
  });
});

test('a GET on the webhook path is 405 when the secret is configured', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, { webhookSecret: SECRET }, async (base) => {
    const res = await fetch(`${base}/webhooks/github`, { method: 'GET' });
    assert.equal(res.status, 405);
  });
});

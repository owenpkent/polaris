import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { openApp, type App } from '../../app.ts';
import { fakeGithubFetch, type FixtureRoute } from './fixtures.ts';
import { setRepoSettings } from './repoSettings.ts';
import { createWebhookHandler, verifySignature } from './webhook.ts';

const SECRET = 'test-secret';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

async function withServer(
  app: App, fetchImpl: typeof fetch, fn: (url: string) => Promise<void>, extra: { maxBodyBytes?: number } = {},
): Promise<void> {
  const handler = createWebhookHandler(app, { secret: SECRET, fetchImpl, token: 'gh-token', ...extra });
  const server: Server = createServer(handler);
  await new Promise<void>((resolvePromise) => server.listen(0, resolvePromise));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }
}

test('verifySignature accepts a matching HMAC and rejects everything else', () => {
  const body = Buffer.from('{"hello":"world"}');
  assert.equal(verifySignature(SECRET, body, sign(body.toString())), true);
  assert.equal(verifySignature(SECRET, body, 'sha256=deadbeef'), false);
  assert.equal(verifySignature(SECRET, body, undefined), false);
  assert.equal(verifySignature('wrong-secret', body, sign(body.toString())), false);
});

test('a request with a missing or invalid signature gets 401', async () => {
  const app = openApp({ dbPath: ':memory:' });
  try {
    await withServer(app, fakeGithubFetch([]).fetchImpl, async (url) => {
      const body = JSON.stringify({ zen: 'hi' });
      const res = await fetch(url, { method: 'POST', headers: { 'x-github-event': 'ping' }, body });
      assert.equal(res.status, 401);

      const res2 = await fetch(url, { method: 'POST', headers: { 'x-github-event': 'ping', 'x-hub-signature-256': 'sha256=bad' }, body });
      assert.equal(res2.status, 401);
    });
  } finally {
    app.close();
  }
});

test('ping responds 200 without any GitHub API calls', async () => {
  const app = openApp({ dbPath: ':memory:' });
  try {
    const { fetchImpl, calls } = fakeGithubFetch([]);
    await withServer(app, fetchImpl, async (url) => {
      const body = JSON.stringify({ zen: 'hi' });
      const res = await fetch(url, { method: 'POST', headers: { 'x-github-event': 'ping', 'x-hub-signature-256': sign(body) }, body });
      assert.equal(res.status, 200);
    });
    assert.equal(calls.length, 0);
  } finally {
    app.close();
  }
});

test('an issues event re-fetches and upserts exactly that issue', async () => {
  const app = openApp({ dbPath: ':memory:' });
  try {
    app.store.upsertProject({ slug: 'octavium', name: 'Octavium', github: 'https://github.com/owenpkent/Octavium' });
    const routes: FixtureRoute[] = [
      { pathname: '/user', json: { login: 'owenpkent' } },
      {
        pathname: '/repos/owenpkent/Octavium/issues/5',
        json: {
          number: 5, title: 'Webhook issue', body: 'body text', state: 'open',
          html_url: 'https://github.com/owenpkent/Octavium/issues/5',
          labels: [], assignees: [{ login: 'owenpkent' }], user: { login: 'owenpkent' },
        },
      },
    ];
    const { fetchImpl } = fakeGithubFetch(routes);
    await withServer(app, fetchImpl, async (url) => {
      const payload = { action: 'opened', issue: { number: 5 }, repository: { owner: { login: 'owenpkent' }, name: 'Octavium' } };
      const body = JSON.stringify(payload);
      const res = await fetch(url, { method: 'POST', headers: { 'x-github-event': 'issues', 'x-hub-signature-256': sign(body) }, body });
      assert.equal(res.status, 202);
    });
    // processing continues after the response is sent; give the event loop a tick.
    await new Promise((r) => setTimeout(r, 50));
    const task = app.store.getTaskBySource('github', 'owenpkent/Octavium#5');
    assert.equal(task?.title, 'Webhook issue');
  } finally {
    app.close();
  }
});

test('an unhandled event type is accepted (202) but ignored', async () => {
  const app = openApp({ dbPath: ':memory:' });
  try {
    const { fetchImpl, calls } = fakeGithubFetch([]);
    await withServer(app, fetchImpl, async (url) => {
      const body = JSON.stringify({ zen: 'hi' });
      const res = await fetch(url, { method: 'POST', headers: { 'x-github-event': 'star', 'x-hub-signature-256': sign(body) }, body });
      assert.equal(res.status, 202);
    });
    assert.equal(calls.length, 0);
  } finally {
    app.close();
  }
});

test('a body over the size cap is rejected with 413 before any signature or GitHub work, and the response still reaches the client', async () => {
  const app = openApp({ dbPath: ':memory:' });
  try {
    const { fetchImpl, calls } = fakeGithubFetch([]);
    const bigBody = 'x'.repeat(2000); // well over the 1000-byte cap used for this test
    await withServer(
      app,
      fetchImpl,
      async (url) => {
        const res = await fetch(url, {
          method: 'POST',
          // A correctly computed signature for the oversized body: if the cap were not
          // enforced before HMAC work, this would pass verification and be processed.
          headers: { 'x-github-event': 'issues', 'x-hub-signature-256': sign(bigBody) },
          body: bigBody,
        });
        assert.equal(res.status, 413);
        assert.equal(await res.text(), 'payload too large');
      },
      { maxBodyBytes: 1000 },
    );
    assert.equal(calls.length, 0, 'no GitHub API calls: the oversized body never reached signature verification or processing');
  } finally {
    app.close();
  }
});

test('a body at or under the size cap is unaffected', async () => {
  const app = openApp({ dbPath: ':memory:' });
  try {
    const { fetchImpl } = fakeGithubFetch([]);
    await withServer(
      app,
      fetchImpl,
      async (url) => {
        const body = JSON.stringify({ zen: 'hi' });
        const res = await fetch(url, { method: 'POST', headers: { 'x-github-event': 'ping', 'x-hub-signature-256': sign(body) }, body });
        assert.equal(res.status, 200);
      },
      { maxBodyBytes: 1000 },
    );
  } finally {
    app.close();
  }
});

test('a repo with syncIssues off produces no task from a webhook either', async () => {
  // Every stage of the poller honours this switch. The webhook is just a faster poller, so a
  // repo the owner turned off must not produce tasks through it -- and the poller's sweep skips
  // that repo, so anything created here could never be cleaned up.
  const app = openApp({ dbPath: ':memory:' });
  try {
    app.store.upsertProject({ slug: 'octavium', name: 'Octavium', github: 'https://github.com/owenpkent/Octavium' });
    setRepoSettings(app.store, 'owenpkent/Octavium', { syncIssues: false });

    // No fixture for the issue: a correct implementation never asks for it.
    const { fetchImpl, calls } = fakeGithubFetch([{ pathname: '/user', json: { login: 'owenpkent' } }]);
    await withServer(app, fetchImpl, async (url) => {
      const payload = { action: 'opened', issue: { number: 42 }, repository: { owner: { login: 'owenpkent' }, name: 'Octavium' } };
      const body = JSON.stringify(payload);
      const res = await fetch(url, { method: 'POST', headers: { 'x-github-event': 'issues', 'x-hub-signature-256': sign(body) }, body });
      assert.equal(res.status, 202, 'the delivery is still accepted, it just does nothing');
    });
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(app.store.getTaskBySource('github', 'owenpkent/Octavium#42'), undefined);
    assert.ok(!calls.some((c) => String(c).includes('/issues/42')), 'and the issue is never fetched');
  } finally {
    app.close();
  }
});

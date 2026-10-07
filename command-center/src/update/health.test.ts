import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityProof } from '../http/identity.ts';
import { checkHealthOnce, waitForHealthy } from './health.ts';

const TOKEN = 'the-api-token';
const PORT = 8788;

interface Fake {
  proofFor?: (challenge: string) => string;
  version?: string;
  ok?: boolean;
  identityStatus?: number;
  down?: boolean;
}

function fakeFetch(f: Fake, seen: { url: string; auth: string | null }[] = []): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    seen.push({ url: url.pathname + url.search, auth: new Headers(init?.headers).get('authorization') });
    if (f.down) throw new Error('connect ECONNREFUSED');
    if (url.pathname === '/api/identity') {
      if (f.identityStatus) return new Response('', { status: f.identityStatus });
      const challenge = url.searchParams.get('challenge') ?? '';
      return Response.json({ proof: (f.proofFor ?? ((c) => identityProof(TOKEN, PORT, c)))(challenge) });
    }
    if (url.pathname === '/api/health') {
      if (new Headers(init?.headers).get('authorization') !== `Bearer ${TOKEN}`) return new Response('', { status: 401 });
      return Response.json({ ok: f.ok ?? true, version: f.version ?? '2.1.0' });
    }
    return new Response('', { status: 404 });
  };
}

test('identity first, without the token, then health with it, and both must agree', async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const result = await checkHealthOnce({ port: PORT, apiToken: TOKEN, expectedVersion: '2.1.0' }, fakeFetch({}, seen));
  assert.deepEqual(result, { ok: true });
  assert.equal(seen.length, 2);
  assert.match(seen[0].url, /^\/api\/identity\?challenge=[0-9a-f]{64}$/);
  assert.equal(seen[0].auth, null, 'the token is not sent before the proof');
  assert.equal(seen[1].url, '/api/health');
  assert.equal(seen[1].auth, `Bearer ${TOKEN}`);
});

test('a process that does not hold the token never sees it', async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const result = await checkHealthOnce({ port: PORT, apiToken: TOKEN, expectedVersion: '2.1.0' }, fakeFetch({ proofFor: (c) => identityProof('another token', PORT, c) }, seen));
  assert.deepEqual(result, { ok: false, reason: `the process on port ${PORT} does not hold this install's api token` });
  assert.equal(seen.length, 1, 'no second request');
  assert.ok(seen.every((s) => s.auth === null));
});

test('a proof for another port is refused', async () => {
  const result = await checkHealthOnce({ port: PORT, apiToken: TOKEN, expectedVersion: '2.1.0' }, fakeFetch({ proofFor: (c) => identityProof(TOKEN, PORT + 1, c) }));
  assert.equal(result.ok, false);
});

test('the wrong version, a health that is not ok, and a daemon that is down each say why', async () => {
  assert.deepEqual(await checkHealthOnce({ port: PORT, apiToken: TOKEN, expectedVersion: '2.1.0' }, fakeFetch({ version: '2.0.0' })), { ok: false, reason: 'the daemon reports version 2.0.0, expected 2.1.0' });
  assert.deepEqual(await checkHealthOnce({ port: PORT, apiToken: TOKEN, expectedVersion: '2.1.0' }, fakeFetch({ ok: false })), { ok: false, reason: 'GET /api/health did not say ok' });
  assert.deepEqual(await checkHealthOnce({ port: PORT, apiToken: TOKEN, expectedVersion: '2.1.0' }, fakeFetch({ identityStatus: 404 })), { ok: false, reason: 'GET /api/identity answered 404' });
  const down = await checkHealthOnce({ port: PORT, apiToken: TOKEN, expectedVersion: '2.1.0' }, fakeFetch({ down: true }));
  assert.equal(down.ok, false);
  assert.match((down as { reason: string }).reason, /no answer on port 8788/);
});

test('waitForHealthy keeps trying until the daemon is up, and gives the last reason when time runs out', async () => {
  let clock = 0;
  const fake: Fake = { down: true };
  let attempts = 0;
  const fetchFn: typeof fetch = (input, init) => { if (String(input).includes('/api/identity') && ++attempts === 3) fake.down = false; return fakeFetch(fake)(input, init); };
  const deps = { fetch: fetchFn, sleep: async () => { clock += 500; }, now: () => clock };
  assert.deepEqual(await waitForHealthy({ port: PORT, apiToken: TOKEN, expectedVersion: '2.1.0' }, 10_000, deps), { ok: true });
  assert.equal(attempts, 3);

  clock = 0;
  const never = await waitForHealthy({ port: PORT, apiToken: TOKEN, expectedVersion: '2.1.0' }, 2000, { ...deps, fetch: fakeFetch({ version: '2.0.0' }) });
  assert.deepEqual(never, { ok: false, reason: 'the daemon reports version 2.0.0, expected 2.1.0' });
});

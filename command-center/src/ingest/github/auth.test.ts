import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memorySecretStore, type SecretStore } from '../secrets.ts';
import { clearUserToken, loadAppSecrets, saveAppFromConversion, saveUserToken } from './app.ts';
import { GithubAuthError, GithubNotSignedInError, describeGithubAuth, resolveGithubAuth } from './auth.ts';
import type { ManifestConversionResponse } from './oauth.ts';

const CONVERSION: ManifestConversionResponse = {
  id: 1, slug: 'cc', name: 'Polaris Command Center', html_url: 'https://github.com/apps/cc',
  client_id: 'client-id', client_secret: 'client-secret',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function signedInStore(now: number, accessExpiresAt: string | null, refreshExpiresAt: string | null) {
  const secrets = memorySecretStore();
  await saveAppFromConversion(secrets, CONVERSION);
  await saveUserToken(secrets, {
    accessToken: 'access-current', refreshToken: 'refresh-current', accessExpiresAt, refreshExpiresAt, login: 'owenpkent',
  });
  return { secrets, now };
}

// ------------------------------------------------------------------- modes

test('mode "app": app configured and signed in with a fresh access token returns it without any network call', async () => {
  const now = Date.parse('2026-09-13T12:00:00.000Z');
  const { secrets } = await signedInStore(now, new Date(now + 3600_000).toISOString(), new Date(now + 1e10).toISOString());
  const fetchImpl = (async () => { throw new Error('must not be called'); }) as typeof fetch;
  const token = await resolveGithubAuth({ secrets, fetchImpl, now: () => now });
  assert.equal(token, 'access-current');
});

test('mode "none": with no app configured there is nothing to fall back to, whatever GITHUB_TOKEN says', async () => {
  const secrets = memorySecretStore();
  const before = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'a-read-write-token-that-must-be-ignored';
  try {
    await assert.rejects(
      resolveGithubAuth({ secrets }),
      (e: unknown) => e instanceof GithubNotSignedInError && e instanceof GithubAuthError && /Not signed in to GitHub/.test((e as Error).message),
    );
    assert.deepEqual(await describeGithubAuth({ secrets }), { mode: 'none' });
  } finally {
    if (before === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = before;
  }
});

test('an app configured but never signed in (no stored access token) is not signed in either', async () => {
  const secrets = memorySecretStore();
  await saveAppFromConversion(secrets, CONVERSION); // app saved, but no saveUserToken call
  await assert.rejects(resolveGithubAuth({ secrets }), GithubNotSignedInError);
  assert.deepEqual(await describeGithubAuth({ secrets }), { mode: 'none' });
});

// --------------------------------------------------------------- refresh

test('an access token expiring within 5 minutes is refreshed, and the rotated refresh token is saved', async () => {
  const now = Date.parse('2026-09-13T12:00:00.000Z');
  const { secrets } = await signedInStore(now, new Date(now + 4 * 60_000).toISOString(), new Date(now + 1e10).toISOString());
  let posted: URLSearchParams | undefined;
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    posted = new URLSearchParams(String(init?.body));
    return jsonResponse({ access_token: 'access-new', refresh_token: 'refresh-rotated', expires_in: 28800, refresh_token_expires_in: 15897600 });
  }) as typeof fetch;

  const token = await resolveGithubAuth({ secrets, fetchImpl, now: () => now });
  assert.equal(token, 'access-new');
  assert.equal(posted?.get('grant_type'), 'refresh_token');
  assert.equal(posted?.get('refresh_token'), 'refresh-current');

  // Rotation persisted: a second resolve call (well within the new token's life) needs no network.
  const noNetwork = (async () => { throw new Error('must not be called again'); }) as typeof fetch;
  const token2 = await resolveGithubAuth({ secrets, fetchImpl: noNetwork, now: () => now + 1000 });
  assert.equal(token2, 'access-new');
});

test('an access token well within its life is used as-is, with no network call', async () => {
  const now = Date.parse('2026-09-13T12:00:00.000Z');
  const { secrets } = await signedInStore(now, new Date(now + 3600_000).toISOString(), new Date(now + 1e10).toISOString());
  const fetchImpl = (async () => { throw new Error('must not be called'); }) as typeof fetch;
  const token = await resolveGithubAuth({ secrets, fetchImpl, now: () => now });
  assert.equal(token, 'access-current');
});

test('an accessExpiresAt of null (non-expiring token) is never refreshed', async () => {
  const now = Date.parse('2026-09-13T12:00:00.000Z');
  const { secrets } = await signedInStore(now, null, null);
  const fetchImpl = (async () => { throw new Error('must not be called'); }) as typeof fetch;
  const token = await resolveGithubAuth({ secrets, fetchImpl, now: () => now });
  assert.equal(token, 'access-current');
});

test('concurrent resolveGithubAuth calls needing a refresh collapse into a single token exchange', async () => {
  const now = Date.parse('2026-09-13T12:00:00.000Z');
  const { secrets } = await signedInStore(now, new Date(now + 60_000).toISOString(), new Date(now + 1e10).toISOString());
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return jsonResponse({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 28800 });
  }) as typeof fetch;

  const [a, b] = await Promise.all([
    resolveGithubAuth({ secrets, fetchImpl, now: () => now }),
    resolveGithubAuth({ secrets, fetchImpl, now: () => now }),
  ]);
  assert.equal(calls, 1);
  assert.equal(a, 'access-new');
  assert.equal(b, 'access-new');
});

test('a read that finishes after another caller has refreshed uses the new token and does not spend the old refresh token again', async () => {
  const now = Date.parse('2026-09-13T12:00:00.000Z');
  const { secrets: inner } = await signedInStore(now, new Date(now + 60_000).toISOString(), new Date(now + 1e10).toISOString());
  // The second read takes what is stored, then waits until the first caller's refresh has settled,
  // as a DPAPI read that is still waiting on PowerShell does.
  let reads = 0;
  let release = () => {};
  const held = new Promise<void>((r) => { release = r; });
  const secrets: SecretStore = {
    ...inner,
    async get(key) {
      const index = reads++;
      const value = await inner.get(key);
      if (index === 1) await held;
      return value;
    },
  };
  // GitHub refuses a refresh token the second time it is used.
  const exchanged: string[] = [];
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    const used = new URLSearchParams(String(init?.body)).get('refresh_token') ?? '';
    const reused = exchanged.includes(used);
    exchanged.push(used);
    return jsonResponse(reused ? { error: 'bad_refresh_token' } : { access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 28800 });
  }) as typeof fetch;

  const first = resolveGithubAuth({ secrets, fetchImpl, now: () => now });
  const second = resolveGithubAuth({ secrets, fetchImpl, now: () => now });
  assert.equal(await first, 'access-new');
  release();
  assert.equal(await second, 'access-new');
  assert.deepEqual(exchanged, ['refresh-current'], 'one exchange');
  assert.equal((await loadAppSecrets(inner))?.refreshToken, 'refresh-new', 'still signed in with the new pair');
});

// ------------------------------------------------------------- expiry / errors

test('a refresh token already past its own expiry clears the user token and throws GithubAuthError, without any network call', async () => {
  const now = Date.parse('2026-09-13T12:00:00.000Z');
  const { secrets } = await signedInStore(now, new Date(now + 60_000).toISOString(), new Date(now - 1000).toISOString());
  const fetchImpl = (async () => { throw new Error('must not be called'); }) as typeof fetch;

  await assert.rejects(
    resolveGithubAuth({ secrets, fetchImpl, now: () => now }),
    (e: unknown) => e instanceof GithubAuthError && /GitHub sign-in expired\. Sign in again from the GitHub page in the dashboard\./.test((e as Error).message),
  );

  const status = await describeGithubAuth({ secrets, fetchImpl, now: () => now });
  assert.notEqual(status.mode, 'app');
});

test('GitHub rejecting the refresh with bad_refresh_token clears the user token and throws the exact expected message', async () => {
  const now = Date.parse('2026-09-13T12:00:00.000Z');
  const { secrets } = await signedInStore(now, new Date(now + 60_000).toISOString(), new Date(now + 1e10).toISOString());
  const fetchImpl = (async () => jsonResponse({ error: 'bad_refresh_token', error_description: 'The refresh token expired' })) as typeof fetch;

  await assert.rejects(
    resolveGithubAuth({ secrets, fetchImpl, now: () => now }),
    (e: unknown) => e instanceof GithubAuthError && (e as Error).message === 'GitHub sign-in expired. Sign in again from the GitHub page in the dashboard.',
  );

  // The user token is now cleared, so there is no sign-in left.
  const status = await describeGithubAuth({ secrets });
  assert.equal(status.mode, 'none');
});

test('GitHub refusing the old refresh token keeps a newer pair saved while the exchange was out', async () => {
  const now = Date.parse('2026-09-13T12:00:00.000Z');
  const { secrets } = await signedInStore(now, new Date(now + 60_000).toISOString(), new Date(now + 1e10).toISOString());
  // A newer pair is saved while this exchange is out (a sign-in, which the refresh lock does not
  // cover, or a process without the lock), and GitHub refuses this one.
  let exchanges = 0;
  const fetchImpl = (async () => {
    exchanges++;
    await saveUserToken(secrets, {
      accessToken: 'access-other', refreshToken: 'refresh-other', accessExpiresAt: new Date(now + 8 * 3600_000).toISOString(),
      refreshExpiresAt: new Date(now + 1e10).toISOString(), login: 'owenpkent',
    });
    return jsonResponse({ error: 'bad_refresh_token' });
  }) as typeof fetch;

  assert.equal(await resolveGithubAuth({ secrets, fetchImpl, now: () => now }), 'access-other');
  assert.equal(exchanges, 1);
  const stored = await loadAppSecrets(secrets);
  assert.equal(stored?.refreshToken, 'refresh-other', 'the other process\'s sign-in is kept');
  assert.equal((await describeGithubAuth({ secrets, now: () => now })).mode, 'app');
});

test('when the newer pair is itself due for refresh, the refusal clears nothing and the next attempt uses it', async () => {
  const now = Date.parse('2026-09-13T12:00:00.000Z');
  const { secrets } = await signedInStore(now, new Date(now + 60_000).toISOString(), new Date(now + 1e10).toISOString());
  const fetchImpl = (async () => {
    await saveUserToken(secrets, {
      accessToken: 'access-other', refreshToken: 'refresh-other', accessExpiresAt: new Date(now + 60_000).toISOString(),
      refreshExpiresAt: new Date(now + 1e10).toISOString(), login: 'owenpkent',
    });
    return jsonResponse({ error: 'bad_refresh_token' });
  }) as typeof fetch;

  await assert.rejects(
    resolveGithubAuth({ secrets, fetchImpl, now: () => now }),
    (e: unknown) => !(e instanceof GithubAuthError) && /changed during this refresh/.test((e as Error).message),
  );
  assert.equal((await loadAppSecrets(secrets))?.refreshToken, 'refresh-other', 'nothing was cleared');
});

test('a refresh failure for an unrelated reason (not bad_refresh_token) throws a plain Error, and the user token is left intact', async () => {
  const now = Date.parse('2026-09-13T12:00:00.000Z');
  const { secrets } = await signedInStore(now, new Date(now + 60_000).toISOString(), new Date(now + 1e10).toISOString());
  const fetchImpl = (async () => jsonResponse({ error: 'server_error' })) as typeof fetch;

  await assert.rejects(resolveGithubAuth({ secrets, fetchImpl, now: () => now }), (e: unknown) => !(e instanceof GithubAuthError));

  const status = await describeGithubAuth({ secrets, fetchImpl, now: () => now });
  assert.equal(status.mode, 'app'); // token untouched, still usable (just stale until the next attempt)
});

test('a refresh that finishes after a sign-out does not restore the session: the token is dropped and the caller is not signed in', async () => {
  const now = Date.parse('2026-09-13T12:00:00.000Z');
  const { secrets } = await signedInStore(now, new Date(now + 60_000).toISOString(), new Date(now + 1e10).toISOString());

  // GitHub's answer is held until the test releases it, with the sign-out in between.
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const fetchImpl = (async () => {
    await held;
    return jsonResponse({ access_token: 'access-after-logout', refresh_token: 'refresh-after-logout', expires_in: 28800 });
  }) as typeof fetch;

  const pending = resolveGithubAuth({ secrets, fetchImpl, now: () => now });
  await new Promise((r) => setTimeout(r, 5));
  await clearUserToken(secrets);
  assert.deepEqual(await describeGithubAuth({ secrets, now: () => now }), { mode: 'none' });
  release();

  await assert.rejects(pending, (e: unknown) => e instanceof GithubNotSignedInError);
  assert.deepEqual(await describeGithubAuth({ secrets, now: () => now }), { mode: 'none' }, 'still signed out after the refresh landed');
  const stored = await loadAppSecrets(secrets);
  assert.equal(stored?.accessToken, undefined);
  assert.equal(stored?.refreshToken, undefined);
  assert.ok(stored?.clientSecret, 'the app registration is kept');
});

// ------------------------------------------------------------- racing writers

// A store whose next update can be held open by the test, as a DPAPI update waits on its lock or
// on PowerShell.
function holdableStore(inner: SecretStore) {
  let hold: { gate: Promise<void>; entered: () => void } | undefined;
  const store: SecretStore = {
    ...inner,
    async update(key, fn) {
      const next = hold;
      hold = undefined;
      if (next) {
        next.entered();
        await next.gate;
      }
      return inner.update(key, fn);
    },
  };
  const holdNextUpdate = () => {
    let release = () => {};
    let entered = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const inside = new Promise<void>((r) => { entered = r; });
    hold = { gate, entered };
    return { inside, release };
  };
  return { store, holdNextUpdate };
}

test('a caller that arrives while a refused refresh is still clearing joins it, so the refused token is spent once', async () => {
  const now = Date.parse('2026-09-13T12:00:00.000Z');
  const { secrets: inner } = await signedInStore(now, new Date(now + 60_000).toISOString(), new Date(now + 1e10).toISOString());
  const { store: secrets, holdNextUpdate } = holdableStore(inner);
  let exchanges = 0;
  const fetchImpl = (async () => {
    exchanges++;
    return jsonResponse({ error: 'bad_refresh_token' });
  }) as typeof fetch;

  const clearing = holdNextUpdate();
  const first = resolveGithubAuth({ secrets, fetchImpl, now: () => now });
  await clearing.inside;
  const second = resolveGithubAuth({ secrets, fetchImpl, now: () => now });
  const settled = Promise.allSettled([first, second]);
  await new Promise((r) => setTimeout(r, 20));
  clearing.release();

  for (const result of await settled) assert.ok(result.status === 'rejected' && result.reason instanceof GithubAuthError);
  assert.equal(exchanges, 1);
});

// Two processes, the daemon and a CLI command, are two copies of this module with their own single
// flight and one store between them. GitHub refuses a refresh token the second time it is used.
for (const [index, moment] of ['GitHub has not answered the first yet', 'the first has its answer but has not saved it'].entries()) {
  test(`a refresh in another process waits while ${moment}, and the refresh token is spent once`, async () => {
    const now = Date.parse('2026-09-13T12:00:00.000Z');
    const { secrets: inner } = await signedInStore(now, new Date(now + 60_000).toISOString(), new Date(now + 1e10).toISOString());
    const { store: secrets, holdNextUpdate } = holdableStore(inner);
    const otherProcess = (await import(`${'./auth.ts'}?process-${index}`)) as typeof import('./auth.ts');

    const spent: string[] = [];
    let answer = () => {};
    const answered = new Promise<void>((r) => { answer = r; });
    let asked = () => {};
    const isAsked = new Promise<void>((r) => { asked = r; });
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      const used = new URLSearchParams(String(init?.body)).get('refresh_token') ?? '';
      const reused = spent.includes(used);
      spent.push(used);
      if (reused) return jsonResponse({ error: 'bad_refresh_token' });
      asked();
      if (index === 0) await answered;
      return jsonResponse({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 28800 });
    }) as typeof fetch;

    const saving = index === 1 ? holdNextUpdate() : undefined;
    const first = resolveGithubAuth({ secrets, fetchImpl, now: () => now });
    await (saving ? saving.inside : isAsked);
    const second = otherProcess.resolveGithubAuth({ secrets, fetchImpl, now: () => now });
    const settled = Promise.allSettled([first, second]);
    await new Promise((r) => setTimeout(r, 20));
    answer();
    saving?.release();

    assert.deepEqual(spent, ['refresh-current'], 'one exchange');
    assert.deepEqual((await settled).map((r) => r.status === 'fulfilled' ? r.value : String(r.reason)), ['access-new', 'access-new']);
    assert.equal((await loadAppSecrets(inner))?.refreshToken, 'refresh-new');
  });
}

test('an old sign-in with no refresh token is not cleared over a newer one saved meanwhile that has none either', async () => {
  const now = Date.parse('2026-09-13T12:00:00.000Z');
  const inner = memorySecretStore();
  await saveAppFromConversion(inner, CONVERSION);
  await saveUserToken(inner, { accessToken: 'access-old', accessExpiresAt: new Date(now + 60_000).toISOString(), refreshExpiresAt: null, login: 'owenpkent' });
  const { store: secrets, holdNextUpdate } = holdableStore(inner);
  const fetchImpl = (async () => { throw new Error('must not be called'); }) as typeof fetch;

  const clearing = holdNextUpdate();
  const pending = resolveGithubAuth({ secrets, fetchImpl, now: () => now });
  await clearing.inside;
  // Meanwhile the owner signs out and in again, and the new token never expires.
  await clearUserToken(inner);
  await saveUserToken(inner, { accessToken: 'access-new', accessExpiresAt: null, refreshExpiresAt: null, login: 'owenpkent' });
  clearing.release();

  assert.equal(await pending, 'access-new');
  assert.equal((await loadAppSecrets(inner))?.accessToken, 'access-new', 'the new sign-in is kept');
});

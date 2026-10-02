import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, loadAppSecrets } from '../ingest/github/app.ts';
import { OAuthStateStore } from '../ingest/github/oauthState.ts';
import { getRepoSettings, setRepoSettings } from '../ingest/github/repoSettings.ts';
import { memorySecretStore, type SecretStore } from '../ingest/secrets.ts';
import { api, authHeaders, fakeApp, withServer } from './test-support.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Routes fetches by pathname to a fixture map; each entry is either a fixed response or a function of (url, init). */
function routedFetch(routes: Record<string, (url: URL, init: RequestInit | undefined) => Response>): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const handler = routes[url.pathname];
    if (!handler) return jsonResponse({ message: `no fixture for ${url.pathname}` }, 404);
    return handler(url, init);
  }) as typeof fetch;
}

// --------------------------------------------------------------------- manifest

test('POST /api/github/app/manifest returns an action URL carrying a fresh state and a manifest matching ADR-006', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, { githubSecrets: memorySecretStore() }, async (base) => {
    const { status, json } = await api(base, 'POST', '/api/github/app/manifest', {});
    assert.equal(status, 200);
    const actionUrl = new URL(json.action);
    assert.equal(actionUrl.origin + actionUrl.pathname, 'https://github.com/settings/apps/new');
    assert.ok(actionUrl.searchParams.get('state'));
    const manifest = JSON.parse(json.manifest);
    assert.equal(manifest.name, 'Polaris Command Center');
    assert.equal(manifest.public, true);
    assert.match(manifest.redirect_url, /^http:\/\/127\.0\.0\.1:\d+\/api\/github\/app\/callback$/);
    assert.deepEqual(manifest.callback_urls, ['http://127.0.0.1/api/github/callback']);
  });
});

test('POST /api/github/app/manifest 409s when an app is already configured', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const secrets = memorySecretStore();
  await withServer(app, { githubSecrets: secrets }, async (base) => {
    const first = await api(base, 'POST', '/api/github/app/manifest', {});
    assert.equal(first.status, 200);
    // Simulate a completed registration directly (the callback path is tested separately below).
    const { saveAppFromConversion } = await import('../ingest/github/app.ts');
    await saveAppFromConversion(secrets, {
      id: 1, slug: 'cc', name: 'Polaris Command Center', html_url: 'https://github.com/apps/cc',
      client_id: 'cid', client_secret: 'csecret',
    });
    const second = await api(base, 'POST', '/api/github/app/manifest', {});
    assert.equal(second.status, 409);
    assert.equal(second.json.error.code, 'github_app_exists');
  });
});

test('POST /api/github/app/manifest requires a bearer token like every other /api route', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, { githubSecrets: memorySecretStore() }, async (base) => {
    const res = await fetch(`${base}/api/github/app/manifest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 401);
  });
});

// ------------------------------------------------------------ app callback

test('GET /api/github/app/callback: valid state exchanges the code, saves the app, and 302s to the install URL -- reachable with no bearer token', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const secrets = memorySecretStore();
  const fetchImpl = routedFetch({
    '/app-manifests/one-time-code/conversions': () => jsonResponse({
      id: 99, slug: 'cc-app', name: 'Polaris Command Center', html_url: 'https://github.com/apps/cc-app',
      client_id: 'cid-99', client_secret: 'csecret-99', pem: 'SHOULD-NEVER-BE-STORED', webhook_secret: 'SHOULD-NEVER-BE-STORED',
    }),
  });
  await withServer(app, { githubSecrets: secrets, githubFetchImpl: fetchImpl }, async (base) => {
    const manifestResp = await api(base, 'POST', '/api/github/app/manifest', {});
    const state = new URL(manifestResp.json.action).searchParams.get('state')!;

    const res = await fetch(`${base}/api/github/app/callback?code=one-time-code&state=${state}`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://github.com/apps/cc-app/installations/new');

    const saved = await loadApp(secrets);
    assert.equal(saved?.slug, 'cc-app');
    assert.equal(saved?.clientId, 'cid-99');
    const savedSecrets = await loadAppSecrets(secrets);
    assert.equal(savedSecrets?.clientSecret, 'csecret-99');
    assert.doesNotMatch(JSON.stringify(savedSecrets), /SHOULD-NEVER-BE-STORED/);
  });
});

test('GET /api/github/app/callback: a reused state 400s with an expired-link page on the second attempt', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const secrets = memorySecretStore();
  const fetchImpl = routedFetch({
    '/app-manifests/code-1/conversions': () => jsonResponse({ id: 1, slug: 's', name: 'n', html_url: 'https://github.com/apps/s', client_id: 'cid', client_secret: 'sec' }),
  });
  await withServer(app, { githubSecrets: secrets, githubFetchImpl: fetchImpl }, async (base) => {
    const manifestResp = await api(base, 'POST', '/api/github/app/manifest', {});
    const state = new URL(manifestResp.json.action).searchParams.get('state')!;

    const first = await fetch(`${base}/api/github/app/callback?code=code-1&state=${state}`, { redirect: 'manual' });
    assert.equal(first.status, 302);

    const second = await fetch(`${base}/api/github/app/callback?code=code-1&state=${state}`, { redirect: 'manual' });
    assert.equal(second.status, 400);
    const body = await second.text();
    assert.match(body, /expired/i);
  });
});

test('GET /api/github/app/callback: an expired (past TTL) state 400s with the expired-link page', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  let now = 1_000_000;
  const stateStore = new OAuthStateStore(() => now);
  await withServer(app, { githubSecrets: memorySecretStore(), githubStateStore: stateStore }, async (base) => {
    const manifestResp = await api(base, 'POST', '/api/github/app/manifest', {});
    const state = new URL(manifestResp.json.action).searchParams.get('state')!;

    now += 10 * 60_000 + 1; // past the 10-minute TTL
    const res = await fetch(`${base}/api/github/app/callback?code=whatever&state=${state}`, { redirect: 'manual' });
    assert.equal(res.status, 400);
    const body = await res.text();
    assert.match(body, /expired/i);
  });
});

test('GET /api/github/app/callback: a missing/garbage state 400s without touching the network', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const fetchImpl = (async () => { throw new Error('must not be called'); }) as typeof fetch;
  await withServer(app, { githubSecrets: memorySecretStore(), githubFetchImpl: fetchImpl }, async (base) => {
    const res = await fetch(`${base}/api/github/app/callback?code=x&state=never-issued`, { redirect: 'manual' });
    assert.equal(res.status, 400);
  });
});

// ------------------------------------------------------------------- login

async function configuredApp(secrets: SecretStore): Promise<void> {
  const { saveAppFromConversion } = await import('../ingest/github/app.ts');
  await saveAppFromConversion(secrets, {
    id: 1, slug: 'cc', name: 'Polaris Command Center', html_url: 'https://github.com/apps/cc',
    client_id: 'login-client-id', client_secret: 'login-client-secret',
  });
}

test('POST /api/github/login 409s when no app is configured yet', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, { githubSecrets: memorySecretStore() }, async (base) => {
    const { status, json } = await api(base, 'POST', '/api/github/login', {});
    assert.equal(status, 409);
    assert.equal(json.error.code, 'github_app_missing');
  });
});

test('POST /api/github/login returns an authorize URL with client_id, redirect_uri, state, and S256 PKCE', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const secrets = memorySecretStore();
  await configuredApp(secrets);
  await withServer(app, { githubSecrets: secrets }, async (base) => {
    const { status, json } = await api(base, 'POST', '/api/github/login', {});
    assert.equal(status, 200);
    const url = new URL(json.url);
    assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize');
    assert.equal(url.searchParams.get('client_id'), 'login-client-id');
    assert.match(url.searchParams.get('redirect_uri')!, /^http:\/\/127\.0\.0\.1:\d+\/api\/github\/callback$/);
    assert.ok(url.searchParams.get('state'));
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(url.searchParams.get('code_challenge'));
  });
});

test('GET /api/github/callback: valid state exchanges the code, fetches the login, and saves the user token -- reachable with no bearer token', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const secrets = memorySecretStore();
  await configuredApp(secrets);
  const fetchImpl = routedFetch({
    '/login/oauth/access_token': () => jsonResponse({ access_token: 'access-tok', refresh_token: 'refresh-tok', expires_in: 28800, refresh_token_expires_in: 15897600 }),
    '/user': () => jsonResponse({ login: 'owenpkent' }),
  });
  await withServer(app, { githubSecrets: secrets, githubFetchImpl: fetchImpl }, async (base) => {
    const loginResp = await api(base, 'POST', '/api/github/login', {});
    const state = new URL(loginResp.json.url).searchParams.get('state')!;

    const res = await fetch(`${base}/api/github/callback?code=user-code&state=${state}`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /GitHub connected as owenpkent/);

    const saved = await loadAppSecrets(secrets);
    assert.equal(saved?.accessToken, 'access-tok');
    assert.equal(saved?.refreshToken, 'refresh-tok');
    assert.equal(saved?.login, 'owenpkent');
  });
});

test('GET /api/github/callback: a reused state is rejected on the second attempt', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const secrets = memorySecretStore();
  await configuredApp(secrets);
  const fetchImpl = routedFetch({
    '/login/oauth/access_token': () => jsonResponse({ access_token: 'a', refresh_token: 'r', expires_in: 28800 }),
    '/user': () => jsonResponse({ login: 'owenpkent' }),
  });
  await withServer(app, { githubSecrets: secrets, githubFetchImpl: fetchImpl }, async (base) => {
    const loginResp = await api(base, 'POST', '/api/github/login', {});
    const state = new URL(loginResp.json.url).searchParams.get('state')!;
    const first = await fetch(`${base}/api/github/callback?code=c&state=${state}`);
    assert.equal(first.status, 200);
    const second = await fetch(`${base}/api/github/callback?code=c&state=${state}`);
    assert.equal(second.status, 400);
  });
});

// ------------------------------------------------------------------ status

test('GET /api/github/status: no app configured', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, { githubSecrets: memorySecretStore() }, async (base) => {
    const { status, json } = await api(base, 'GET', '/api/github/status');
    assert.equal(status, 200);
    assert.equal(json.app, null);
    assert.equal(json.signedIn, false);
    // Without an app configured, the exact fallback ('env'/'gh'/'none') depends on the host's own
    // GITHUB_TOKEN/gh state, which this test does not control; only "not signed in via the app" matters here.
    assert.notEqual(json.mode, 'app');
    assert.deepEqual(json.installations, []);
  });
});

test('GET /api/github/status: signed in reports the app, user, and live installations', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const secrets = memorySecretStore();
  await configuredApp(secrets);
  const { saveUserToken } = await import('../ingest/github/app.ts');
  await saveUserToken(secrets, { accessToken: 'a', refreshToken: 'r', accessExpiresAt: null, refreshExpiresAt: null, login: 'owenpkent' });
  const fetchImpl = routedFetch({
    '/user/installations': () => jsonResponse({ installations: [{ id: 7, account: { login: 'owenpkent', type: 'User' }, repository_selection: 'selected', html_url: 'https://github.com/settings/installations/7' }] }),
  });
  await withServer(app, { githubSecrets: secrets, githubFetchImpl: fetchImpl }, async (base) => {
    const { status, json } = await api(base, 'GET', '/api/github/status');
    assert.equal(status, 200);
    assert.equal(json.mode, 'app');
    assert.equal(json.signedIn, true);
    assert.equal(json.app.slug, 'cc');
    assert.equal(json.app.installUrl, 'https://github.com/apps/cc/installations/new');
    assert.equal(json.user.login, 'owenpkent');
    assert.equal(json.installations.length, 1);
    assert.equal(json.installations[0].manageUrl, 'https://github.com/settings/installations/7');
  });
});

test('GET /api/github/status: an installations fetch failure still returns 200 with an empty list and an error message', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const secrets = memorySecretStore();
  await configuredApp(secrets);
  const { saveUserToken } = await import('../ingest/github/app.ts');
  await saveUserToken(secrets, { accessToken: 'a', refreshToken: 'r', accessExpiresAt: null, refreshExpiresAt: null, login: 'owenpkent' });
  const fetchImpl = routedFetch({ '/user/installations': () => jsonResponse({ message: 'boom' }, 500) });
  await withServer(app, { githubSecrets: secrets, githubFetchImpl: fetchImpl }, async (base) => {
    const { status, json } = await api(base, 'GET', '/api/github/status');
    assert.equal(status, 200);
    assert.deepEqual(json.installations, []);
    assert.match(json.error, /500/);
  });
});

// -------------------------------------------------------------------- repos

test('GET /api/github/repos 409s when not signed in through the app', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, { githubSecrets: memorySecretStore(), githubFetchImpl: (async () => { throw new Error('no network'); }) as typeof fetch }, async (base) => {
    const { status, json } = await api(base, 'GET', '/api/github/repos');
    assert.equal(status, 409);
    assert.equal(json.error.code, 'github_not_connected');
  });
});

test('GET /api/github/repos lists repos across installations with project matches and settings, sorted by full name', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  app.store.upsertProject({ slug: 'octavium', name: 'Octavium', github: 'https://github.com/owenpkent/Octavium' });
  const secrets = memorySecretStore();
  await configuredApp(secrets);
  const { saveUserToken } = await import('../ingest/github/app.ts');
  await saveUserToken(secrets, { accessToken: 'a', refreshToken: 'r', accessExpiresAt: null, refreshExpiresAt: null, login: 'owenpkent' });
  setRepoSettings(app.store, 'owenpkent/Zed', { syncIssues: false });
  const fetchImpl = routedFetch({
    '/user/installations': () => jsonResponse({ installations: [{ id: 1, account: { login: 'owenpkent', type: 'User' }, repository_selection: 'all', html_url: 'https://x' }] }),
    '/user/installations/1/repositories': () => jsonResponse({ repositories: [
      { full_name: 'owenpkent/Zed', private: false },
      { full_name: 'owenpkent/Octavium', private: true },
    ] }),
  });
  await withServer(app, { githubSecrets: secrets, githubFetchImpl: fetchImpl }, async (base) => {
    const { status, json } = await api(base, 'GET', '/api/github/repos');
    assert.equal(status, 200);
    assert.equal(json.repos.length, 2);
    assert.equal(json.repos[0].fullName, 'owenpkent/Octavium'); // sorted before Zed
    assert.equal(json.repos[0].tracked, true);
    assert.deepEqual(json.repos[0].project, { slug: 'octavium', name: 'Octavium' });
    assert.equal(json.repos[0].syncIssues, true);
    assert.equal(json.repos[1].fullName, 'owenpkent/Zed');
    assert.equal(json.repos[1].tracked, false);
    assert.equal(json.repos[1].project, null);
    assert.equal(json.repos[1].syncIssues, false);
  });
});

test('PATCH /api/github/repos/:owner/:repo updates the switches and rejects unknown fields', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, { githubSecrets: memorySecretStore() }, async (base) => {
    const { status, json } = await api(base, 'PATCH', '/api/github/repos/owenpkent/Octavium', { syncIssues: false });
    assert.equal(status, 200);
    assert.deepEqual(json.repo, { fullName: 'owenpkent/Octavium', tracked: false, project: null, syncIssues: false, readChecklists: true });
    assert.deepEqual(getRepoSettings(app.store, 'owenpkent/Octavium'), { syncIssues: false, readChecklists: true });

    const bad = await api(base, 'PATCH', '/api/github/repos/owenpkent/Octavium', { nope: true });
    assert.equal(bad.status, 400);
  });
});

test('PATCH /api/github/repos/:owner/:repo {tracked: true} creates the project and the response carries it', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, { githubSecrets: memorySecretStore() }, async (base) => {
    const { status, json } = await api(base, 'PATCH', '/api/github/repos/owenpkent/Octavium', { tracked: true });
    assert.equal(status, 200);
    assert.equal(json.repo.tracked, true);
    assert.deepEqual(json.repo.project, { slug: 'octavium', name: 'Octavium' });
    assert.ok(app.store.findProject('octavium'));
    assert.equal(app.store.findProject('octavium')?.github, 'https://github.com/owenpkent/Octavium');
  });
});

test('PATCH /api/github/repos/:owner/:repo {tracked: false} archives the project and the response shows no project', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, { githubSecrets: memorySecretStore() }, async (base) => {
    await api(base, 'PATCH', '/api/github/repos/owenpkent/Octavium', { tracked: true });
    const { status, json } = await api(base, 'PATCH', '/api/github/repos/owenpkent/Octavium', { tracked: false });
    assert.equal(status, 200);
    assert.equal(json.repo.tracked, false);
    assert.equal(json.repo.project, null);
    assert.equal(app.store.findProject('octavium')?.archived, true);
  });
});

test('PATCH /api/github/repos/:owner/:repo with only syncIssues still works and creates no project', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, { githubSecrets: memorySecretStore() }, async (base) => {
    const { status, json } = await api(base, 'PATCH', '/api/github/repos/owenpkent/Octavium', { syncIssues: false });
    assert.equal(status, 200);
    assert.equal(json.repo.tracked, false);
    assert.equal(json.repo.project, null);
    assert.equal(app.store.findProject('octavium'), undefined);
  });
});

test('PATCH /api/github/repos/:owner/:repo: events from the patch are recorded with actor human', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, { githubSecrets: memorySecretStore() }, async (base) => {
    const before = app.store.lastEventId();
    await api(base, 'PATCH', '/api/github/repos/owenpkent/Octavium', { tracked: true });
    const events = app.store.eventsSince(before).filter((e) => e.kind === 'project.upserted');
    assert.equal(events.length, 1);
    assert.equal(events[0].actor, 'human');
  });
});

// ------------------------------------------------------------ logout/forget

test('POST /api/github/logout clears the user token but keeps the app', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const secrets = memorySecretStore();
  await configuredApp(secrets);
  const { saveUserToken } = await import('../ingest/github/app.ts');
  await saveUserToken(secrets, { accessToken: 'a', refreshToken: 'r', accessExpiresAt: null, refreshExpiresAt: null, login: 'owenpkent' });
  await withServer(app, { githubSecrets: secrets }, async (base) => {
    const { status, json } = await api(base, 'POST', '/api/github/logout', {});
    assert.equal(status, 200);
    assert.deepEqual(json, { ok: true });
    const saved = await loadAppSecrets(secrets);
    assert.equal(saved?.accessToken, undefined);
    assert.ok(await loadApp(secrets));
  });
});

test('POST /api/github/app/forget clears both the app and the user token', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const secrets = memorySecretStore();
  await configuredApp(secrets);
  await withServer(app, { githubSecrets: secrets }, async (base) => {
    const { status, json } = await api(base, 'POST', '/api/github/app/forget', {});
    assert.equal(status, 200);
    assert.deepEqual(json, { ok: true });
    assert.equal(await loadApp(secrets), undefined);
  });
});

// ---------------------------------------------------- cross-database sharing

test('the GitHub App connection is shared across two different databases via the same secret store (e.g. a scratch CC_DB and the real daemon db)', async (t) => {
  const scratchApp = fakeApp();
  const realApp = fakeApp();
  t.after(() => { scratchApp.close(); realApp.close(); });
  const secrets = memorySecretStore();
  const noInstallations = (async () => jsonResponse({ installations: [] })) as typeof fetch;

  // The owner signs in once, while the dashboard happens to be pointed at a scratch database.
  await configuredApp(secrets);
  const { saveUserToken } = await import('../ingest/github/app.ts');
  await saveUserToken(secrets, { accessToken: 'a', refreshToken: 'r', accessExpiresAt: null, refreshExpiresAt: null, login: 'owenpkent' });
  await withServer(scratchApp, { githubSecrets: secrets, githubFetchImpl: noInstallations }, async (base) => {
    const { json } = await api(base, 'GET', '/api/github/status');
    assert.equal(json.signedIn, true);
  });

  // A completely different Store/database (the real daemon db) sees the very same connection --
  // and, critically, does not offer to register a second, clashing app.
  await withServer(realApp, { githubSecrets: secrets, githubFetchImpl: noInstallations }, async (base) => {
    const status = await api(base, 'GET', '/api/github/status');
    assert.equal(status.json.signedIn, true);
    assert.equal(status.json.app.slug, 'cc');

    const manifest = await api(base, 'POST', '/api/github/app/manifest', {});
    assert.equal(manifest.status, 409);
    assert.equal(manifest.json.error.code, 'github_app_exists');
  });
});

// ---------------------------------------------------- auth boundary sanity

test('the two GitHub callback GET routes work with no bearer token while every other GitHub route still 401s', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, { githubSecrets: memorySecretStore() }, async (base) => {
    const cb1 = await fetch(`${base}/api/github/callback?code=x&state=y`, { redirect: 'manual' });
    assert.notEqual(cb1.status, 401);
    const cb2 = await fetch(`${base}/api/github/app/callback?code=x&state=y`, { redirect: 'manual' });
    assert.notEqual(cb2.status, 401);

    const status = await fetch(`${base}/api/github/status`);
    assert.equal(status.status, 401);
    const login = await fetch(`${base}/api/github/login`, { method: 'POST' });
    assert.equal(login.status, 401);
    const repos = await fetch(`${base}/api/github/repos`);
    assert.equal(repos.status, 401);

    // POST on the same callback paths is not exempt.
    const postCallback = await fetch(`${base}/api/github/callback`, { method: 'POST' });
    assert.equal(postCallback.status, 401);
  });
});

test('an authorized request to a github route still works normally (auth headers do not break the exemption logic)', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, { githubSecrets: memorySecretStore() }, async (base) => {
    const res = await fetch(`${base}/api/github/status`, { headers: authHeaders() });
    assert.equal(res.status, 200);
  });
});

test('POST /api/github/logout during an in-flight refresh wins: the refresh lands and the user stays signed out', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const secrets = memorySecretStore();
  await configuredApp(secrets);
  const { saveUserToken } = await import('../ingest/github/app.ts');
  const { resolveGithubAuth, GithubNotSignedInError } = await import('../ingest/github/auth.ts');
  const now = Date.now();
  // Signed in with an access token about to expire, so the next resolve refreshes it.
  await saveUserToken(secrets, {
    accessToken: 'a', refreshToken: 'r', accessExpiresAt: new Date(now + 60_000).toISOString(), refreshExpiresAt: new Date(now + 1e10).toISOString(), login: 'owenpkent',
  });
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const fetchImpl = routedFetch({
    '/login/oauth/access_token': () => jsonResponse({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 28800 }),
  });
  const pausedFetch = (async (input: unknown, init?: RequestInit) => { await held; return fetchImpl(input as string, init); }) as typeof fetch;

  await withServer(app, { githubSecrets: secrets, githubFetchImpl: pausedFetch }, async (base) => {
    const pending = resolveGithubAuth({ secrets, fetchImpl: pausedFetch });
    await new Promise((r) => setTimeout(r, 5));
    const { status, json } = await api(base, 'POST', '/api/github/logout', {});
    assert.equal(status, 200);
    assert.deepEqual(json, { ok: true });
    assert.equal((await api(base, 'GET', '/api/github/status')).json.mode, 'none');
    release();
    await assert.rejects(pending, (e: unknown) => e instanceof GithubNotSignedInError);
    assert.equal((await api(base, 'GET', '/api/github/status')).json.mode, 'none', 'the refresh must not have signed the owner back in');
    assert.equal((await loadAppSecrets(secrets))?.accessToken, undefined);
  });
});

test('POST /api/github/logout voids a sign-in that was started but not completed', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const secrets = memorySecretStore();
  await configuredApp(secrets);
  let exchanged = false;
  const fetchImpl = routedFetch({
    '/login/oauth/access_token': () => { exchanged = true; return jsonResponse({ access_token: 'access-tok', refresh_token: 'refresh-tok', expires_in: 28800 }); },
    '/user': () => jsonResponse({ login: 'owenpkent' }),
  });
  await withServer(app, { githubSecrets: secrets, githubFetchImpl: fetchImpl }, async (base) => {
    const loginResp = await api(base, 'POST', '/api/github/login', {});
    const state = new URL(loginResp.json.url).searchParams.get('state')!;
    await api(base, 'POST', '/api/github/logout', {});

    const res = await fetch(`${base}/api/github/callback?code=user-code&state=${state}`);
    assert.equal(res.status, 400);
    assert.equal(exchanged, false, 'a voided state never reaches GitHub');
    assert.equal((await loadAppSecrets(secrets))?.accessToken, undefined);
  });
});

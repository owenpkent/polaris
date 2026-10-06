import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLoginAuthUrl, buildManifest, exchangeLoginCode, exchangeManifestCode, fetchViewerLogin, generatePkce, refreshLoginToken,
} from './oauth.ts';

function fakeFetch(handler: (url: URL, init: RequestInit | undefined) => Response): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => handler(new URL(String(input)), init)) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('buildManifest matches the ADR-006 spec exactly, using the given port for redirect_url only', () => {
  const manifest = buildManifest(54321);
  assert.equal(manifest.name, 'Polaris Command Center');
  assert.equal(manifest.url, 'https://github.com/owenpkent/constellation');
  // GitHub refuses a manifest with a hook url it cannot reach, even an inactive one.
  assert.equal('hook_attributes' in manifest, false);
  assert.equal(manifest.redirect_url, 'http://127.0.0.1:54321/api/github/app/callback');
  assert.deepEqual(manifest.callback_urls, ['http://127.0.0.1/api/github/callback']);
  assert.equal(manifest.public, true);
  assert.equal(manifest.request_oauth_on_install, false);
  assert.deepEqual(manifest.default_permissions, {
    metadata: 'read', contents: 'read', issues: 'read', pull_requests: 'read', checks: 'read', statuses: 'read',
  });
  assert.deepEqual(manifest.default_events, []);
});

test('exchangeManifestCode POSTs to app-manifests/{code}/conversions with no auth header and returns the parsed JSON', async () => {
  let seenUrl: URL | undefined;
  let seenMethod: string | undefined;
  let seenAuth: string | null | undefined;
  const fetchImpl = fakeFetch((url, init) => {
    seenUrl = url;
    seenMethod = init?.method;
    seenAuth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
    return json({ id: 1, slug: 's', name: 'n', html_url: 'https://x', client_id: 'cid', client_secret: 'csecret' });
  });
  const result = await exchangeManifestCode('one-time-code', fetchImpl);
  assert.equal(seenUrl?.pathname, '/app-manifests/one-time-code/conversions');
  assert.equal(seenMethod, 'POST');
  assert.equal(seenAuth, null);
  assert.equal(result.client_secret, 'csecret');
});

test('exchangeManifestCode throws on a non-ok response', async () => {
  const fetchImpl = fakeFetch(() => json({ message: 'not found' }, 404));
  await assert.rejects(exchangeManifestCode('bad-code', fetchImpl), /404/);
});

test('buildLoginAuthUrl includes client_id, redirect_uri, state, and S256 PKCE, and nothing else', () => {
  const url = new URL(buildLoginAuthUrl('cid', { redirectUri: 'http://127.0.0.1:9999/api/github/callback', state: 'st4te', codeChallenge: 'ch4ll' }));
  assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'cid');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:9999/api/github/callback');
  assert.equal(url.searchParams.get('state'), 'st4te');
  assert.equal(url.searchParams.get('code_challenge'), 'ch4ll');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
});

test('generatePkce challenge is the base64url(SHA-256(verifier))', () => {
  const { verifier, challenge } = generatePkce();
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  assert.doesNotMatch(challenge, /[+/=]/);
});

test('exchangeLoginCode posts client_id/client_secret/code/code_verifier/redirect_uri with Accept: application/json', async () => {
  let body: URLSearchParams | undefined;
  let accept: string | undefined;
  const fetchImpl = fakeFetch((_url, init) => {
    body = new URLSearchParams(String(init?.body));
    accept = (init?.headers as Record<string, string>)?.Accept;
    return json({ access_token: 'at', refresh_token: 'rt', expires_in: 28800, refresh_token_expires_in: 15897600 });
  });
  const resp = await exchangeLoginCode('cid', 'csecret', { code: 'c0de', verifier: 'v3rifier', redirectUri: 'http://127.0.0.1:1/api/github/callback' }, fetchImpl);
  assert.equal(body?.get('client_id'), 'cid');
  assert.equal(body?.get('client_secret'), 'csecret');
  assert.equal(body?.get('code'), 'c0de');
  assert.equal(body?.get('code_verifier'), 'v3rifier');
  assert.equal(body?.get('redirect_uri'), 'http://127.0.0.1:1/api/github/callback');
  assert.equal(accept, 'application/json');
  assert.equal(resp.access_token, 'at');
});

test('refreshLoginToken posts grant_type=refresh_token and refresh_token', async () => {
  let body: URLSearchParams | undefined;
  const fetchImpl = fakeFetch((_url, init) => {
    body = new URLSearchParams(String(init?.body));
    return json({ access_token: 'at2', refresh_token: 'rt2', expires_in: 28800 });
  });
  await refreshLoginToken('cid', 'csecret', 'old-refresh', fetchImpl);
  assert.equal(body?.get('grant_type'), 'refresh_token');
  assert.equal(body?.get('refresh_token'), 'old-refresh');
});

test('refreshLoginToken surfaces a bad_refresh_token error in the parsed response rather than throwing', async () => {
  const fetchImpl = fakeFetch(() => json({ error: 'bad_refresh_token', error_description: 'expired' }));
  const resp = await refreshLoginToken('cid', 'csecret', 'expired-refresh', fetchImpl);
  assert.equal(resp.error, 'bad_refresh_token');
  assert.equal(resp.access_token, undefined);
});

test('fetchViewerLogin GETs /user with a bearer token and returns the login', async () => {
  let seenAuth: string | undefined;
  const fetchImpl = fakeFetch((url, init) => {
    seenAuth = (init?.headers as Record<string, string>)?.Authorization;
    assert.equal(url.pathname, '/user');
    return json({ login: 'owenpkent' });
  });
  const login = await fetchViewerLogin('token-abc', fetchImpl);
  assert.equal(login, 'owenpkent');
  assert.equal(seenAuth, 'Bearer token-abc');
});

test('fetchViewerLogin throws on a non-ok response', async () => {
  const fetchImpl = fakeFetch(() => json({}, 401));
  await assert.rejects(fetchViewerLogin('bad-token', fetchImpl), /401/);
});

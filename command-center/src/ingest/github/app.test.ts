import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memorySecretStore } from '../secrets.ts';
import { GithubSessionEndedError, clearUserToken, forgetApp, loadApp, loadAppSecrets, saveAppFromConversion, saveUserToken, sessionOf } from './app.ts';
import type { ManifestConversionResponse } from './oauth.ts';

const CONVERSION: ManifestConversionResponse = {
  id: 12345,
  slug: 'polaris-command-center',
  name: 'Polaris Command Center',
  html_url: 'https://github.com/apps/polaris-command-center',
  client_id: 'client-id-abc',
  client_secret: 'client-secret-xyz',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----',
  webhook_secret: 'webhook-secret-should-never-be-stored',
};

test('saveAppFromConversion stores the app config and the client secret together in the secret store, discarding pem/webhook_secret', async () => {
  const secrets = memorySecretStore();
  await saveAppFromConversion(secrets, CONVERSION);

  const app = await loadApp(secrets);
  assert.deepEqual(app, {
    appId: '12345',
    slug: 'polaris-command-center',
    name: 'Polaris Command Center',
    htmlUrl: 'https://github.com/apps/polaris-command-center',
    clientId: 'client-id-abc',
  });

  const stored = await loadAppSecrets(secrets);
  assert.equal(stored?.clientSecret, 'client-secret-xyz');
  assert.equal(stored?.accessToken, undefined);

  // The raw stored JSON never contains the pem or webhook secret.
  const raw = JSON.stringify(stored);
  assert.doesNotMatch(raw, /BEGIN RSA PRIVATE KEY/);
  assert.doesNotMatch(raw, /webhook-secret-should-never-be-stored/);
});

test('loadApp returns undefined when no app has ever been saved', async () => {
  const secrets = memorySecretStore();
  assert.equal(await loadApp(secrets), undefined);
});

test('a value under an unrelated secret key is ignored -- there is no per-database kv fallback', async () => {
  // Regression guard: the app config used to live in the database's kv table under 'github:app'.
  // That storage is gone; a leftover value anywhere other than the SecretStore's own
  // 'github-app-secrets' key must never be picked up.
  const secrets = memorySecretStore({ 'github:app': JSON.stringify({ appId: 'old', slug: 'old-app', name: 'Old', htmlUrl: 'https://x', clientId: 'old-cid' }) });
  assert.equal(await loadApp(secrets), undefined);
});

test('saveUserToken merges into existing secrets, keeping the app config and client secret', async () => {
  const secrets = memorySecretStore();
  await saveAppFromConversion(secrets, CONVERSION);

  await saveUserToken(secrets, {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    accessExpiresAt: '2026-09-13T12:00:00.000Z',
    refreshExpiresAt: '2027-03-13T12:00:00.000Z',
    login: 'owenpkent',
  });

  const stored = await loadAppSecrets(secrets);
  assert.equal(stored?.clientSecret, 'client-secret-xyz');
  assert.equal(stored?.clientId, 'client-id-abc');
  assert.equal(stored?.accessToken, 'access-1');
  assert.equal(stored?.login, 'owenpkent');
  assert.equal((await loadApp(secrets))?.slug, 'polaris-command-center');
});

test('saveUserToken throws if the app has not been configured yet', async () => {
  const secrets = memorySecretStore();
  await assert.rejects(
    saveUserToken(secrets, { accessToken: 'a', accessExpiresAt: null, refreshExpiresAt: null, login: 'x' }),
    /before the app is configured/,
  );
});

test('clearUserToken removes only the token fields, keeping the app registration', async () => {
  const secrets = memorySecretStore();
  await saveAppFromConversion(secrets, CONVERSION);
  await saveUserToken(secrets, { accessToken: 'a', refreshToken: 'r', accessExpiresAt: null, refreshExpiresAt: null, login: 'owenpkent' });

  await clearUserToken(secrets);

  const stored = await loadAppSecrets(secrets);
  assert.equal(stored?.clientSecret, 'client-secret-xyz');
  assert.equal(stored?.accessToken, undefined);
  assert.equal(stored?.refreshToken, undefined);
  assert.equal(stored?.login, undefined);
  assert.ok(await loadApp(secrets)); // app registration itself is untouched
});

test('clearUserToken is a no-op when there is nothing stored yet', async () => {
  const secrets = memorySecretStore();
  await clearUserToken(secrets); // must not throw
  assert.equal(await loadAppSecrets(secrets), undefined);
});

test('forgetApp clears the config and every secret, including the client secret, in one call', async () => {
  const secrets = memorySecretStore();
  await saveAppFromConversion(secrets, CONVERSION);
  await saveUserToken(secrets, { accessToken: 'a', refreshToken: 'r', accessExpiresAt: null, refreshExpiresAt: null, login: 'owenpkent' });

  await forgetApp(secrets);

  assert.equal(await loadApp(secrets), undefined);
  assert.equal(await loadAppSecrets(secrets), undefined);
});

// ------------------------------------------------------------------- sessions

test('a sign-out ends the session, and a token write from the previous session is refused and saves nothing', async () => {
  const secrets = memorySecretStore();
  await saveAppFromConversion(secrets, CONVERSION);
  assert.equal(sessionOf(await loadAppSecrets(secrets)), 0, 'a fresh app has session 0');

  await saveUserToken(secrets, { accessToken: 'a', refreshToken: 'r', accessExpiresAt: null, refreshExpiresAt: null, login: 'owenpkent' }, 0);
  assert.equal((await loadAppSecrets(secrets))?.accessToken, 'a');

  await clearUserToken(secrets);
  assert.equal(sessionOf(await loadAppSecrets(secrets)), 1);

  // A refresh or a login that read session 0 before going to GitHub finishes now.
  await assert.rejects(
    saveUserToken(secrets, { accessToken: 'stale', refreshToken: 'r2', accessExpiresAt: null, refreshExpiresAt: null, login: 'owenpkent' }, 0),
    (e: unknown) => e instanceof GithubSessionEndedError,
  );
  const stored = await loadAppSecrets(secrets);
  assert.equal(stored?.accessToken, undefined, 'the stale token must not be written');
  assert.equal(stored?.login, undefined);
  assert.ok(await loadApp(secrets), 'the app registration is untouched');

  // A sign-in started after the sign-out reads session 1 and saves as usual.
  await saveUserToken(secrets, { accessToken: 'fresh', refreshToken: 'r3', accessExpiresAt: null, refreshExpiresAt: null, login: 'owenpkent' }, 1);
  assert.equal((await loadAppSecrets(secrets))?.accessToken, 'fresh');
  assert.equal(sessionOf(await loadAppSecrets(secrets)), 1, 'a sign-in does not move the session; only a sign-out does');
});

test('a record from before sessions existed reads as session 0, and clearing it moves to 1', async () => {
  const secrets = memorySecretStore({
    'github-app-secrets': JSON.stringify({ appId: '1', slug: 'cc', name: 'CC', htmlUrl: 'https://x', clientId: 'c', clientSecret: 's', accessToken: 'old', login: 'owenpkent' }),
  });
  assert.equal(sessionOf(await loadAppSecrets(secrets)), 0);
  await clearUserToken(secrets);
  assert.equal(sessionOf(await loadAppSecrets(secrets)), 1);
  assert.equal((await loadAppSecrets(secrets))?.accessToken, undefined);
});

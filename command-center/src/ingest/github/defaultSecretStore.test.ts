// In its own file on purpose: defaultGithubSecretStore caches one store per process, and node:test
// gives each file its own process, so the store picked here cannot leak into another test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultGithubSecretStore } from './app.ts';

test('off Windows the default store is a secrets.json next to the database, shared by every caller', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-default-secrets-'));
  try {
    const env = { CC_DB: join(dir, 'constellation.db') };
    const store = defaultGithubSecretStore('linux', env);
    await store.set('github-app', '{"clientId":"abc"}');

    assert.deepEqual(readdirSync(dir), ['secrets.json']);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8')), { 'github-app': '{"clientId":"abc"}' });

    // One store per process: a token refresh in flight on one caller has to be seen by the next.
    assert.equal(defaultGithubSecretStore('linux', env), store);
    assert.equal(defaultGithubSecretStore(), store);

    // Reading back checks the permission bits, which only exist off Windows.
    if (process.platform !== 'win32') assert.equal(await store.get('github-app'), '{"clientId":"abc"}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

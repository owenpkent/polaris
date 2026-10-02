import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OAuthStateStore } from './oauthState.ts';

test('a freshly created state consumes once, returning its codeVerifier', () => {
  const store = new OAuthStateStore();
  const state = store.create('login', 'verifier-1');
  const result = store.consume(state, 'login');
  assert.deepEqual(result, { codeVerifier: 'verifier-1' });
});

test('a state is single-use: the second consume fails even with the right kind', () => {
  const store = new OAuthStateStore();
  const state = store.create('manifest');
  assert.ok(store.consume(state, 'manifest'));
  assert.equal(store.consume(state, 'manifest'), undefined);
});

test('consuming with the wrong kind fails, and also burns the state (single-use regardless of outcome)', () => {
  const store = new OAuthStateStore();
  const state = store.create('login', 'v');
  assert.equal(store.consume(state, 'manifest'), undefined);
  assert.equal(store.consume(state, 'login'), undefined); // already burned by the failed attempt above
});

test('an unknown state is rejected', () => {
  const store = new OAuthStateStore();
  assert.equal(store.consume('never-issued', 'login'), undefined);
});

test('a state older than the 10-minute TTL is rejected even though it was never consumed before', () => {
  let now = 1_000_000;
  const store = new OAuthStateStore(() => now);
  const state = store.create('login');
  now += 10 * 60_000 + 1;
  assert.equal(store.consume(state, 'login'), undefined);
});

test('a state just under the TTL still works', () => {
  let now = 1_000_000;
  const store = new OAuthStateStore(() => now);
  const state = store.create('login');
  now += 10 * 60_000 - 1;
  assert.ok(store.consume(state, 'login'));
});

test('two created states are distinct, high-entropy base64url strings', () => {
  const store = new OAuthStateStore();
  const a = store.create('login');
  const b = store.create('login');
  assert.notEqual(a, b);
  assert.doesNotMatch(a, /[+/=]/);
  assert.ok(a.length >= 40); // 32 random bytes, base64url
});

test('invalidate drops every pending state of one kind and leaves the other kind alone', () => {
  const store = new OAuthStateStore();
  const login = store.create('login', 'verifier');
  const manifest = store.create('manifest');
  store.invalidate('login');
  assert.equal(store.consume(login, 'login'), undefined);
  assert.deepEqual(store.consume(manifest, 'manifest'), { codeVerifier: undefined });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../../core/index.ts';
import { fakeGithubFetch } from './fixtures.ts';
import { GithubClient, GithubFileTooLargeError, GithubRateLimitStop, GithubRequestError } from './client.ts';

test('paginated follows the Link header next relation across pages', async () => {
  const store = openStore(':memory:');
  const { fetchImpl, calls } = fakeGithubFetch([
    {
      pathname: '/repos/o/r/issues', query: { state: 'open' }, once: true,
      json: [{ number: 1 }],
      headers: { link: '<https://api.github.com/repos/o/r/issues?per_page=100&state=open&page=2>; rel="next"' },
    },
    { pathname: '/repos/o/r/issues', query: { page: '2' }, json: [{ number: 2 }] },
  ]);
  const client = new GithubClient({ token: 't', store, fetchImpl });
  const { items, notModified } = await client.paginated<{ number: number }>('/repos/o/r/issues', { state: 'open' });
  assert.equal(notModified, false);
  assert.deepEqual(items.map((i) => i.number), [1, 2]);
  assert.equal(calls.length, 2);
  assert.equal(client.apiCalls, 2);
});

test('a 304 with no cached list on file (e.g. a stale/foreign KV entry) falls back to empty, not an error', async () => {
  const store = openStore(':memory:');
  const url = 'https://api.github.com/repos/o/r/issues?per_page=100&state=open';
  store.setKv(`github:etag:${url}`, 'W/"cached"'); // legacy/malformed shape, not {etag, items}
  const { fetchImpl, calls } = fakeGithubFetch([
    { pathname: '/repos/o/r/issues', query: { state: 'open' }, status: 304 },
  ]);
  const client = new GithubClient({ token: 't', store, fetchImpl });
  const { items, notModified } = await client.paginated('/repos/o/r/issues', { state: 'open' });
  assert.equal(notModified, true);
  assert.deepEqual(items, []);
  assert.equal(calls.length, 1);
});

test('a fresh 200 response stages its ETag and item list, but does not persist until commitEtagCache', async () => {
  const store = openStore(':memory:');
  const url = 'https://api.github.com/repos/o/r/issues?per_page=100&state=open';
  const { fetchImpl } = fakeGithubFetch([
    { pathname: '/repos/o/r/issues', query: { state: 'open' }, json: [{ number: 1 }], headers: { etag: 'W/"fresh"' } },
  ]);
  const client = new GithubClient({ token: 't', store, fetchImpl });
  await client.paginated('/repos/o/r/issues', { state: 'open' });
  assert.equal(store.getKv(`github:etag:${url}`), undefined, 'not persisted until the caller commits it');

  client.commitEtagCache();
  assert.deepEqual(store.getKv(`github:etag:${url}`), { etag: 'W/"fresh"', items: [{ number: 1 }] });
});

test('discardEtagCache drops a staged ETag without persisting it (the --dry-run / failed-stage path)', async () => {
  const store = openStore(':memory:');
  const url = 'https://api.github.com/repos/o/r/issues?per_page=100&state=open';
  const { fetchImpl } = fakeGithubFetch([
    { pathname: '/repos/o/r/issues', query: { state: 'open' }, json: [{ number: 1 }], headers: { etag: 'W/"fresh"' } },
  ]);
  const client = new GithubClient({ token: 't', store, fetchImpl });
  await client.paginated('/repos/o/r/issues', { state: 'open' });
  client.discardEtagCache();
  client.commitEtagCache(); // nothing left to commit
  assert.equal(store.getKv(`github:etag:${url}`), undefined);
});

test('a 304 reuses the cached item list instead of returning empty', async () => {
  const store = openStore(':memory:');
  const url = 'https://api.github.com/repos/o/r/issues?per_page=100&state=open';
  store.setKv(`github:etag:${url}`, { etag: 'W/"cached"', items: [{ number: 1 }, { number: 2 }] });
  const { fetchImpl } = fakeGithubFetch([{ pathname: '/repos/o/r/issues', query: { state: 'open' }, status: 304 }]);
  const client = new GithubClient({ token: 't', store, fetchImpl });
  const { items, notModified } = await client.paginated<{ number: number }>('/repos/o/r/issues', { state: 'open' });
  assert.equal(notModified, true);
  assert.deepEqual(items.map((i) => i.number), [1, 2]);
});

test('single GETs surface non-2xx responses as GithubRequestError', async () => {
  const store = openStore(':memory:');
  const { fetchImpl } = fakeGithubFetch([{ pathname: '/repos/o/r/issues/5', status: 404, json: { message: 'Not Found' } }]);
  const client = new GithubClient({ token: 't', store, fetchImpl });
  await assert.rejects(() => client.get('/repos/o/r/issues/5'), GithubRequestError);
  assert.equal(await client.getOrNull('/repos/o/r/issues/5'), null);
});

test('client stops issuing requests once the remaining rate limit hits the floor', async () => {
  const store = openStore(':memory:');
  const { fetchImpl, calls } = fakeGithubFetch([
    { pathname: '/repos/o/r/issues', json: [{ number: 1 }], headers: { 'x-ratelimit-remaining': '1' } },
  ]);
  const client = new GithubClient({ token: 't', store, fetchImpl, rateLimitFloor: 5 });
  const { items } = await client.paginated<{ number: number }>('/repos/o/r/issues');
  assert.equal(items.length, 1, 'the page already in flight still completes');
  assert.equal(client.rateLimited, true);
  assert.equal(calls.length, 1);
  await assert.rejects(() => client.get('/user'), GithubRateLimitStop);
});

test('the search API has its own, tighter rate-limit floor', async () => {
  const store = openStore(':memory:');
  const { fetchImpl } = fakeGithubFetch([
    { pathname: '/search/issues', json: { items: [] }, headers: { 'x-ratelimit-remaining': '2' } },
  ]);
  const client = new GithubClient({ token: 't', store, fetchImpl, rateLimitFloor: 1, searchRateLimitFloor: 3 });
  await client.get('/search/issues');
  assert.equal(client.rateLimited, true);
});

test('getFileText decodes base64 file content and returns null on 404', async () => {
  const store = openStore(':memory:');
  const { fetchImpl, calls } = fakeGithubFetch([
    { pathname: '/repos/o/r/contents/TODO.md', json: { type: 'file', encoding: 'base64', content: Buffer.from('- [ ] hi').toString('base64') } },
    { pathname: '/repos/o/r/contents/NOPE.md', status: 404, json: { message: 'Not Found' } },
  ]);
  const client = new GithubClient({ token: 't', store, fetchImpl });
  assert.equal(await client.getFileText('o', 'r', 'TODO.md'), '- [ ] hi');
  assert.equal(await client.getFileText('o', 'r', 'NOPE.md'), null);
  assert.equal(calls.length, 2);
});

test('getFileText returns null for a directory path (no `content` field)', async () => {
  const store = openStore(':memory:');
  const { fetchImpl } = fakeGithubFetch([
    { pathname: '/repos/o/r/contents/docs', json: [{ name: 'a.md', path: 'docs/a.md', type: 'file' }] },
  ]);
  const client = new GithubClient({ token: 't', store, fetchImpl });
  assert.equal(await client.getFileText('o', 'r', 'docs'), null);
});

test('getFileText reuses the cached content on a 304, and commitEtagCache persists it for next time', async () => {
  const store = openStore(':memory:');
  const url = 'https://api.github.com/repos/o/r/contents/TODO.md';
  const { fetchImpl: first } = fakeGithubFetch([
    { pathname: '/repos/o/r/contents/TODO.md', json: { type: 'file', encoding: 'base64', content: Buffer.from('- [ ] hi').toString('base64') }, headers: { etag: '"abc"' } },
  ]);
  const client1 = new GithubClient({ token: 't', store, fetchImpl: first });
  assert.equal(await client1.getFileText('o', 'r', 'TODO.md'), '- [ ] hi');
  assert.equal(store.getKv(`github:etag:${url}`), undefined, 'not persisted until commitEtagCache');
  client1.commitEtagCache();
  assert.ok(store.getKv(`github:etag:${url}`));

  const { fetchImpl: second } = fakeGithubFetch([{ pathname: '/repos/o/r/contents/TODO.md', status: 304 }]);
  const client2 = new GithubClient({ token: 't', store, fetchImpl: second });
  assert.equal(await client2.getFileText('o', 'r', 'TODO.md'), '- [ ] hi');
});

test('listDirectory returns entries, null on 404, and null for a file path (not an array)', async () => {
  const store = openStore(':memory:');
  const { fetchImpl } = fakeGithubFetch([
    { pathname: '/repos/o/r/contents/docs', json: [{ name: 'a.md', path: 'docs/a.md', type: 'file' }, { name: 'sub', path: 'docs/sub', type: 'dir' }] },
    { pathname: '/repos/o/r/contents/missing', status: 404, json: { message: 'Not Found' } },
    { pathname: '/repos/o/r/contents/TODO.md', json: { type: 'file', content: 'aGk=' } },
  ]);
  const client = new GithubClient({ token: 't', store, fetchImpl });
  const entries = await client.listDirectory('o', 'r', 'docs');
  assert.deepEqual(entries?.map((e) => e.name), ['a.md', 'sub']);
  assert.equal(await client.listDirectory('o', 'r', 'missing'), null);
  assert.equal(await client.listDirectory('o', 'r', 'TODO.md'), null);
});

test('getFileText throws for a file too big to inline, so it can never be mistaken for an empty or missing one', async () => {
  // Over 1 MB the contents API answers {"encoding":"none","content":""}. Read as an empty file
  // that would parse to zero checklist items and sweep away every task from the file, and the
  // ETag cached alongside it would make that stick on later runs.
  const store = openStore(':memory:');
  const { fetchImpl } = fakeGithubFetch([
    { pathname: '/repos/o/r/BIG.md', json: { type: 'file', encoding: 'none', content: '', size: 1500000 } },
    { pathname: '/repos/o/r/contents/BIG.md', json: { type: 'file', encoding: 'none', content: '', size: 1500000 } },
  ]);
  const client = new GithubClient({ token: 't', store, fetchImpl });
  await assert.rejects(client.getFileText('o', 'r', 'BIG.md'), (e: unknown) => e instanceof GithubFileTooLargeError && /BIG\.md is too large/.test((e as Error).message));
});

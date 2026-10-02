import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchInstallationRepos, fetchUserInstallations } from './installations.ts';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('fetchUserInstallations GETs /user/installations with a bearer token and returns the list', async () => {
  let seenAuth: string | undefined;
  let seenPath: string | undefined;
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    seenPath = url.pathname;
    seenAuth = (init?.headers as Record<string, string>)?.Authorization;
    return json({ installations: [{ id: 1, account: { login: 'owenpkent', type: 'User' }, repository_selection: 'selected', html_url: 'https://github.com/settings/installations/1' }] });
  }) as typeof fetch;

  const installations = await fetchUserInstallations('tok', fetchImpl);
  assert.equal(seenPath, '/user/installations');
  assert.equal(seenAuth, 'Bearer tok');
  assert.equal(installations.length, 1);
  assert.equal(installations[0].account.login, 'owenpkent');
});

test('fetchUserInstallations returns an empty array when the response has no installations field', async () => {
  const fetchImpl = (async () => json({})) as typeof fetch;
  assert.deepEqual(await fetchUserInstallations('tok', fetchImpl), []);
});

test('fetchUserInstallations throws with the status code on a non-ok response', async () => {
  const fetchImpl = (async () => json({ message: 'bad creds' }, 401)) as typeof fetch;
  await assert.rejects(fetchUserInstallations('tok', fetchImpl), /401/);
});

test('fetchInstallationRepos follows pages until a short page ends the list', async () => {
  const pages: Record<string, unknown> = {
    '1': { repositories: Array.from({ length: 100 }, (_, i) => ({ full_name: `owenpkent/repo-${i}`, private: false })) },
    '2': { repositories: [{ full_name: 'owenpkent/repo-100', private: true }] },
  };
  const calls: number[] = [];
  const fetchImpl = (async (input: unknown) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get('page'));
    calls.push(page);
    return json(pages[String(page)]);
  }) as typeof fetch;

  const repos = await fetchInstallationRepos('tok', 42, fetchImpl);
  assert.deepEqual(calls, [1, 2]);
  assert.equal(repos.length, 101);
  assert.equal(repos[100].full_name, 'owenpkent/repo-100');
  assert.equal(repos[100].private, true);
});

test('fetchInstallationRepos stops after one page when it comes back short', async () => {
  const fetchImpl = (async () => json({ repositories: [{ full_name: 'owenpkent/only-one', private: false }] })) as typeof fetch;
  const repos = await fetchInstallationRepos('tok', 1, fetchImpl);
  assert.equal(repos.length, 1);
});

test('fetchInstallationRepos throws with the status code and installation id on a non-ok response', async () => {
  const fetchImpl = (async () => json({}, 404)) as typeof fetch;
  await assert.rejects(fetchInstallationRepos('tok', 7, fetchImpl), /404/);
});

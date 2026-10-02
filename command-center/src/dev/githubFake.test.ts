// The guard on the fake GitHub: it is not there unless CC_GITHUB_FAKE is exactly "1", it answers
// only from its fixtures, it never writes, and nothing reaches the real fetch while it is on.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { githubFakeFromEnv } from '../http/commands.ts';
import { api, fakeApp, withServer } from '../http/test-support.ts';
import { syncGithubRepoFiles } from '../ingest/github/repoFiles.ts';
import {
  FAKE_GITHUB_REPOS, FAKE_GITHUB_USER, FAKE_LISTED_REPOS, createGithubFake, fakeIssueTitle, fakeReadmeItems, signInGithubFake,
} from './githubFake.ts';

// The scratch locations the fake insists on. fakeApp() holds its secrets in memory, so nothing is
// written under CC_SECRETS_DIR here; the value only has to be present.
const SCRATCH_ENV = { CC_GITHUB_FAKE: '1', CC_SECRETS_DIR: '/scratch/secrets', CC_DB: ':memory:' };

/**
 * Replaces the global fetch for one test: requests to the test server on loopback go through,
 * anything else (GitHub, say) is recorded and fails as if the network were down.
 */
function trapGlobalFetch(t: TestContext): string[] {
  const real = globalThis.fetch;
  const hits: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === '127.0.0.1') return real(input, init);
    hits.push(url.toString());
    throw new Error(`network request to ${url.hostname} during a test`);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = real; });
  return hits;
}

/** Starts one sync job the way the dashboard does (POST /api/sync/:job) and waits for it to finish. */
async function runSyncJob(base: string, job: string): Promise<{ lastRunAt: string | null; lastError: string | null }> {
  const before = (await api(base, 'GET', '/api/sync')).json.jobs[job];
  const started = await api(base, 'POST', `/api/sync/${job}`);
  assert.equal(started.status, 202, `start ${job}: ${JSON.stringify(started.json)}`);
  for (let i = 0; i < 200; i++) {
    const { json } = await api(base, 'GET', '/api/sync');
    const status = json.jobs[job];
    if (status && !status.running && (status.lastRunAt !== before.lastRunAt || status.lastError)) return status;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`${job} did not finish`);
}

test('with the flag unset, or anything but exactly "1", the fake is not loaded and the server keeps the real fetch', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  for (const value of [undefined, '', '0', 'true', 'yes', ' 1', '1 ', '01']) {
    const env = value === undefined ? {} : { ...SCRATCH_ENV, CC_GITHUB_FAKE: value };
    assert.equal(await githubFakeFromEnv(app, env), undefined, `CC_GITHUB_FAKE=${JSON.stringify(value)}`);
  }
  assert.equal(app.githubFetch, undefined, 'openApp-style apps carry no GitHub fetch of their own');

  // With no wiring, the routes use the global fetch: a sign-in stored the same way the fake
  // stores it makes the status route go to api.github.com, and the trap sees it.
  const hits = trapGlobalFetch(t);
  await signInGithubFake(app.secrets!);
  await withServer(app, { githubSecrets: app.secrets }, async (base) => {
    const { status, json } = await api(base, 'GET', '/api/github/status');
    assert.equal(status, 200);
    assert.equal(json.signedIn, true);
    assert.match(json.error, /network request to api\.github\.com/);
  });
  assert.deepEqual(hits, ['https://api.github.com/user/installations?per_page=100']);
});

test('with the flag exactly "1", the fake answers every GitHub call and nothing reaches the real fetch', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const hits = trapGlobalFetch(t);
  const wiring = await githubFakeFromEnv(app, SCRATCH_ENV);
  assert.ok(wiring, 'the fake is wired');
  assert.equal(wiring.app.githubFetch, wiring.fake.fetch);
  assert.equal(wiring.app.store, app.store, 'the wired app is the same app with a fetch added');

  await withServer(app, wiring.http, async (base) => {
    const status = await api(base, 'GET', '/api/github/status');
    assert.equal(status.status, 200);
    assert.equal(status.json.signedIn, true);
    assert.equal(status.json.user.login, FAKE_GITHUB_USER);
    assert.equal(status.json.error, undefined);
    assert.equal(status.json.installations.length, 1);

    const repos = await api(base, 'GET', '/api/github/repos');
    assert.deepEqual(repos.json.repos.map((r: { fullName: string }) => r.fullName), FAKE_LISTED_REPOS);
    assert.ok(repos.json.repos.every((r: { tracked: boolean }) => !r.tracked), 'nothing is tracked until the switch is used');

    // Track the desktop repo and the unreadable one, then sync the way the dashboard would.
    for (const fullName of [FAKE_GITHUB_REPOS.desktop, FAKE_GITHUB_REPOS.unreadable]) {
      const patched = await api(base, 'PATCH', `/api/github/repos/${fullName}`, { tracked: true });
      assert.equal(patched.status, 200);
      assert.equal(patched.json.repo.tracked, true);
    }
    const files = await runSyncJob(base, 'repo-files');
    assert.equal(files.lastError, null, 'an unreadable repo is skipped by the checklist reader, not a failure');
    // The issue sync has no readability check of its own: a tracked repo it cannot list fails
    // the job, as it would on GitHub, until its Sync issues switch is off.
    const failed = await runSyncJob(base, 'github');
    assert.match(failed.lastError ?? '', /HTTP 404/);
    await api(base, 'PATCH', `/api/github/repos/${FAKE_GITHUB_REPOS.unreadable}`, { syncIssues: false });
    const issues = await runSyncJob(base, 'github');
    assert.equal(issues.lastError, null);
  });

  // The README checklist is the owner's own file, so its items are open tasks of the project; the
  // issue, third-party text, is an inbox suggestion. The unreadable repo produced nothing.
  const open = app.store.searchTasks({ status: ['open'] });
  const desktop = app.store.listProjects().find((p) => p.github?.endsWith(FAKE_GITHUB_REPOS.desktop));
  assert.ok(desktop, 'tracking made a project');
  const readmeTasks = open.filter((task) => task.projectId === desktop.id).map((task) => task.title).sort();
  assert.deepEqual(readmeTasks, fakeReadmeItems(FAKE_GITHUB_REPOS.desktop).sort());
  const inbox = app.store.searchTasks({ status: ['inbox'] });
  assert.deepEqual(inbox.filter((task) => task.projectId === desktop.id).map((task) => task.title), [fakeIssueTitle(FAKE_GITHUB_REPOS.desktop)]);
  const unreadable = app.store.listProjects().find((p) => p.github?.endsWith(FAKE_GITHUB_REPOS.unreadable));
  assert.ok(unreadable);
  assert.equal(app.store.searchTasks({ status: ['open', 'inbox', 'done'] }).filter((task) => task.projectId === unreadable.id).length, 0);

  // And the repo-files report names the unreadable repo as skipped.
  const report = await syncGithubRepoFiles(app.store, { secrets: app.secrets, fetchImpl: wiring.fake.fetch });
  assert.equal(report.errors.length, 0, report.errors.join('; '));
  assert.ok(report.skipped?.some((line) => line.includes(`${FAKE_GITHUB_REPOS.unreadable} cannot be read`)), JSON.stringify(report.skipped));

  assert.deepEqual(hits, [], 'no request left the process');
  assert.deepEqual(wiring.fake.writes, [], 'nothing tried to write');
  assert.ok(wiring.fake.calls.length > 0 && wiring.fake.calls.every((line) => line.startsWith('GET ')), 'every call was a GET');
});

test('the fake refuses to start against anything but scratch locations', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await assert.rejects(githubFakeFromEnv(app, { CC_GITHUB_FAKE: '1', CC_DB: ':memory:' }), /CC_SECRETS_DIR/);
  await assert.rejects(githubFakeFromEnv(app, { CC_GITHUB_FAKE: '1', CC_SECRETS_DIR: '/scratch' }), /CC_DB/);
});

test('the fake answers 404 with a JSON body off its fixtures, and 405 to anything that is not a GET', async () => {
  const fake = createGithubFake();
  const missing = await fake.fetch('https://api.github.com/repos/ui-test/unreadable');
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { message: 'Not Found' });
  const elsewhere = await fake.fetch('https://example.com/anything');
  assert.equal(elsewhere.status, 404);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = await fake.fetch(`https://api.github.com/repos/${FAKE_GITHUB_REPOS.desktop}/issues`, { method, body: '{}' });
    assert.equal(res.status, 405, method);
  }
  const refresh = await fake.fetch(new Request('https://github.com/login/oauth/access_token', { method: 'POST' }));
  assert.equal(refresh.status, 405, 'the token endpoint is a write too');
  assert.deepEqual(fake.writes, [
    `POST /repos/${FAKE_GITHUB_REPOS.desktop}/issues`, `PUT /repos/${FAKE_GITHUB_REPOS.desktop}/issues`,
    `PATCH /repos/${FAKE_GITHUB_REPOS.desktop}/issues`, `DELETE /repos/${FAKE_GITHUB_REPOS.desktop}/issues`,
    'POST /login/oauth/access_token',
  ]);
});

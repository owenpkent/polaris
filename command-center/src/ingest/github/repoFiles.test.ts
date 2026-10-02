import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../core/index.ts';
import { memorySecretStore } from '../secrets.ts';
import { fakeGithubFetch, type FixtureRoute } from './fixtures.ts';
import { syncGithubRepoFiles } from './repoFiles.ts';
import { setRepoSettings } from './repoSettings.ts';

const here = dirname(fileURLToPath(import.meta.url));

function b64(text: string): string {
  return Buffer.from(text).toString('base64');
}

function fileRoute(path: string, content: string, headers?: Record<string, string>): FixtureRoute {
  return { pathname: `/repos/o/r/contents/${path}`, json: { type: 'file', encoding: 'base64', content: b64(content) }, headers };
}

function notFound(path: string): FixtureRoute {
  return { pathname: `/repos/o/r/contents/${path}`, status: 404, json: { message: 'Not Found' } };
}

/** The readability check every repo now gets before any file is fetched. */
function repoRoute(owner = 'o', repo = 'r'): FixtureRoute {
  return { pathname: `/repos/${owner}/${repo}`, json: { full_name: `${owner}/${repo}` } };
}

function repoNotFound(owner = 'o', repo = 'r'): FixtureRoute {
  return { pathname: `/repos/${owner}/${repo}`, status: 404, json: { message: 'Not Found' } };
}

const DOCS_LISTING: FixtureRoute = {
  pathname: '/repos/o/r/contents/docs',
  json: [
    { name: 'ROADMAP.md', path: 'docs/ROADMAP.md', type: 'file' },
    { name: 'image.png', path: 'docs/image.png', type: 'file' },
    { name: 'sub', path: 'docs/sub', type: 'dir' },
  ],
};

test('syncGithubRepoFiles: fetches TODO/README/CLAUDE/docs for a project with no local path, using the same source id scheme as the local importer', async () => {
  const store = openStore(':memory:');
  const project = store.upsertProject({ slug: 'octavium', name: 'Octavium', github: 'https://github.com/o/r' });

  const { fetchImpl } = fakeGithubFetch([
    repoRoute(),
    fileRoute('TODO.md', '- [ ] fix the bug'),
    notFound('README.md'),
    notFound('CLAUDE.md'),
    DOCS_LISTING,
    fileRoute('docs/ROADMAP.md', '## Later\n\n- [ ] ship v2'),
  ]);

  const report = await syncGithubRepoFiles(store, { token: 't', fetchImpl });
  assert.equal(report.partial, false);
  assert.equal(report.created, 2);

  const tasks = store.searchTasks({ projectId: project.id, sourceType: ['todo_md'], limit: 10 });
  assert.equal(tasks.length, 2);
  const bug = tasks.find((t) => t.title === 'fix the bug')!;
  const ship = tasks.find((t) => t.title === 'ship v2')!;
  assert.ok(bug.sourceId!.startsWith('octavium:TODO.md:'));
  assert.ok(ship.sourceId!.startsWith('octavium:docs/ROADMAP.md:'));
  assert.equal(bug.status, 'open');
});

test('syncGithubRepoFiles: a file 404 is a successful fetch of zero content -- previously active items under it are gone-swept', async () => {
  const store = openStore(':memory:');
  const project = store.upsertProject({ slug: 'octavium', name: 'Octavium', github: 'https://github.com/o/r' });

  const first = fakeGithubFetch([
    repoRoute(),
    fileRoute('TODO.md', '- [ ] fix the bug'),
    notFound('README.md'),
    notFound('CLAUDE.md'),
    { pathname: '/repos/o/r/contents/docs', status: 404, json: { message: 'Not Found' } },
  ]);
  const report1 = await syncGithubRepoFiles(store, { token: 't', fetchImpl: first.fetchImpl });
  assert.equal(report1.created, 1);

  // README.md now exists with a checkbox, and TODO.md's checkbox was removed (file deleted / emptied upstream).
  const second = fakeGithubFetch([
    repoRoute(),
    notFound('TODO.md'),
    fileRoute('README.md', '- [ ] a new one'),
    notFound('CLAUDE.md'),
    { pathname: '/repos/o/r/contents/docs', status: 404, json: { message: 'Not Found' } },
  ]);
  const report2 = await syncGithubRepoFiles(store, { token: 't', fetchImpl: second.fetchImpl });
  assert.equal(report2.created, 1);
  assert.equal(report2.goneCompleted, 1);

  const tasks = store.searchTasks({ projectId: project.id, sourceType: ['todo_md'], limit: 10 });
  const bug = tasks.find((t) => t.title === 'fix the bug')!;
  const created = tasks.find((t) => t.title === 'a new one')!;
  assert.equal(bug.status, 'dropped');
  assert.equal(created.status, 'open');
});

test('syncGithubRepoFiles: --dry-run makes no store changes', async () => {
  const store = openStore(':memory:');
  const project = store.upsertProject({ slug: 'octavium', name: 'Octavium', github: 'https://github.com/o/r' });
  const { fetchImpl } = fakeGithubFetch([
    repoRoute(),
    fileRoute('TODO.md', '- [ ] fix the bug'),
    notFound('README.md'),
    notFound('CLAUDE.md'),
    { pathname: '/repos/o/r/contents/docs', status: 404, json: { message: 'Not Found' } },
  ]);
  const report = await syncGithubRepoFiles(store, { token: 't', fetchImpl, dryRun: true });
  assert.equal(report.created, 1);
  assert.equal(store.searchTasks({ projectId: project.id, sourceType: ['todo_md'], limit: 10 }).length, 0);
});

test('syncGithubRepoFiles: a project with a local path and a github url is synced too; only no-github and initiative projects are excluded', async () => {
  const store = openStore(':memory:');
  const hasLocal = store.upsertProject({ slug: 'has-local', name: 'Has Local', github: 'https://github.com/o/r', path: here });
  store.upsertProject({ slug: 'no-github', name: 'No Github' });
  store.upsertProject({ slug: 'initiative-x', name: 'Initiative X', category: 'initiative', github: 'https://github.com/o/r' });

  const { fetchImpl, calls } = fakeGithubFetch([
    repoRoute(),
    fileRoute('TODO.md', '- [ ] fix the bug'),
    notFound('README.md'),
    notFound('CLAUDE.md'),
    { pathname: '/repos/o/r/contents/docs', status: 404, json: { message: 'Not Found' } },
  ]);
  const report = await syncGithubRepoFiles(store, { token: 't', fetchImpl });
  assert.equal(report.checked?.count, 1, 'only has-local was a target; no-github and the initiative project were excluded');
  assert.ok(calls.length > 0);

  const tasks = store.searchTasks({ projectId: hasLocal.id, sourceType: ['todo_md'], limit: 10 });
  assert.equal(tasks.find((t) => t.title === 'fix the bug')?.status, 'open');
});

test('syncGithubRepoFiles: a rate-limit stop partway through a project never gone-sweeps files not yet reached this run', async () => {
  const store = openStore(':memory:');
  const project = store.upsertProject({ slug: 'octavium', name: 'Octavium', github: 'https://github.com/o/r' });

  // First (successful) run: two items live under two different files.
  const first = fakeGithubFetch([
    repoRoute(),
    fileRoute('TODO.md', '- [ ] item a'),
    notFound('README.md'),
    notFound('CLAUDE.md'),
    DOCS_LISTING,
    fileRoute('docs/ROADMAP.md', '- [ ] item b'),
  ]);
  const report1 = await syncGithubRepoFiles(store, { token: 't', fetchImpl: first.fetchImpl });
  assert.equal(report1.created, 2);
  const before = store.searchTasks({ projectId: project.id, sourceType: ['todo_md'], limit: 10 });
  assert.equal(before.length, 2);

  // Second run: TODO.md itself fetches fine but reports the rate limit floor hit, and TODO.md's
  // own item is gone in this response (simulating "item a" being removed upstream) -- that file's
  // own fetch succeeded so it is still swept -- but every later file (README/CLAUDE/docs) must
  // never even be attempted, so docs/ROADMAP.md's "item b" must survive untouched.
  const second = fakeGithubFetch([
    repoRoute(),
    { pathname: '/repos/o/r/contents/docs', status: 404, json: { message: 'Not Found' } },
    { pathname: '/repos/o/r/contents/TODO.md', json: { type: 'file', encoding: 'base64', content: b64('') }, headers: { 'x-ratelimit-remaining': '1' } },
  ]);
  const report2 = await syncGithubRepoFiles(store, { token: 't', fetchImpl: second.fetchImpl, rateLimitFloor: 5 });
  assert.equal(report2.partial, true);
  assert.equal(second.calls.length, 3, 'only the readability check, the docs listing, and the one file fetch that tripped the floor were made');

  const after = store.searchTasks({ projectId: project.id, sourceType: ['todo_md'], limit: 10 });
  const itemA = after.find((t) => t.title === 'item a')!;
  const itemB = after.find((t) => t.title === 'item b')!;
  assert.equal(itemA.status, 'dropped', 'TODO.md itself fetched successfully this run, so it is still swept');
  assert.equal(itemB.status, 'open', 'docs/ROADMAP.md was never reached this run once rate limited, so it is left alone');
});

test('syncGithubRepoFiles: readChecklists=false skips the repo entirely, making no request for it and leaving its existing tasks untouched', async () => {
  const store = openStore(':memory:');
  const project = store.upsertProject({ slug: 'octavium', name: 'Octavium', github: 'https://github.com/o/r' });

  const first = fakeGithubFetch([
    repoRoute(),
    fileRoute('TODO.md', '- [ ] fix the bug'),
    notFound('README.md'),
    notFound('CLAUDE.md'),
    { pathname: '/repos/o/r/contents/docs', status: 404, json: { message: 'Not Found' } },
  ]);
  const report1 = await syncGithubRepoFiles(store, { token: 't', fetchImpl: first.fetchImpl });
  assert.equal(report1.created, 1);

  setRepoSettings(store, 'o/r', { readChecklists: false });

  // No fixtures at all: any request would 404 through fakeGithubFetch's fallback and the assertion
  // on calls.length below would fail, proving the repo is skipped before any network call.
  const second = fakeGithubFetch([]);
  const report2 = await syncGithubRepoFiles(store, { token: 't', fetchImpl: second.fetchImpl });
  assert.equal(report2.partial, false);
  assert.equal(report2.checked?.count, 0);
  assert.equal(second.calls.length, 0);

  const tasks = store.searchTasks({ projectId: project.id, sourceType: ['todo_md'], limit: 10 });
  const bug = tasks.find((t) => t.title === 'fix the bug')!;
  assert.equal(bug.status, 'open', 'the existing task from the now-disabled repo is left untouched, not gone-swept');
});

test('syncGithubRepoFiles: an unreadable repo (404 on the readability check) is skipped whole, leaving its existing tasks untouched', async () => {
  const store = openStore(':memory:');
  const project = store.upsertProject({ slug: 'octavium', name: 'Octavium', github: 'https://github.com/o/r' });

  const first = fakeGithubFetch([
    repoRoute(),
    fileRoute('TODO.md', '- [ ] fix the bug'),
    notFound('README.md'),
    notFound('CLAUDE.md'),
    { pathname: '/repos/o/r/contents/docs', status: 404, json: { message: 'Not Found' } },
  ]);
  const report1 = await syncGithubRepoFiles(store, { token: 't', fetchImpl: first.fetchImpl });
  assert.equal(report1.created, 1);

  // Second run: the repo itself now 404s (GitHub App uninstalled, repo deleted, or made private).
  const second = fakeGithubFetch([repoNotFound()]);
  const report2 = await syncGithubRepoFiles(store, { token: 't', fetchImpl: second.fetchImpl });
  assert.equal(report2.partial, false);
  assert.deepEqual(report2.errors, []);
  assert.equal(report2.skipped?.length, 1);
  assert.match(report2.skipped![0], /octavium/);
  assert.match(report2.skipped![0], /o\/r/);
  assert.equal(second.calls.length, 1, 'only the readability check was fetched; no file fetch was made for the unreadable repo');

  const tasks = store.searchTasks({ projectId: project.id, sourceType: ['todo_md'], limit: 10 });
  const bug = tasks.find((t) => t.title === 'fix the bug')!;
  assert.equal(bug.status, 'open', 'left exactly as it was: not dropped, not marked done');
});

test('syncGithubRepoFiles: a readability check that fails with a 500 marks the sync partial, records an error, retires nothing, and still moves on to the next repo', async () => {
  const store = openStore(':memory:');
  const bad = store.upsertProject({ slug: 'bad-repo', name: 'Bad Repo', github: 'https://github.com/o/r' });
  const good = store.upsertProject({ slug: 'good-repo', name: 'Good Repo', github: 'https://github.com/p/q' });

  const first = fakeGithubFetch([
    repoRoute(),
    fileRoute('TODO.md', '- [ ] fix the bug'),
    notFound('README.md'),
    notFound('CLAUDE.md'),
    { pathname: '/repos/o/r/contents/docs', status: 404, json: { message: 'Not Found' } },
  ]);
  const report1 = await syncGithubRepoFiles(store, { token: 't', fetchImpl: first.fetchImpl });
  assert.equal(report1.created, 1);

  const second = fakeGithubFetch([
    { pathname: '/repos/o/r', status: 500, json: { message: 'Internal Server Error' } },
    repoRoute('p', 'q'),
    { pathname: '/repos/p/q/contents/TODO.md', json: { type: 'file', encoding: 'base64', content: b64('- [ ] ship it') } },
    { pathname: '/repos/p/q/contents/README.md', status: 404, json: { message: 'Not Found' } },
    { pathname: '/repos/p/q/contents/CLAUDE.md', status: 404, json: { message: 'Not Found' } },
    { pathname: '/repos/p/q/contents/docs', status: 404, json: { message: 'Not Found' } },
  ]);
  const report2 = await syncGithubRepoFiles(store, { token: 't', fetchImpl: second.fetchImpl });
  assert.equal(report2.partial, true);
  assert.equal(report2.errors.length, 1);
  assert.match(report2.errors[0], /bad-repo/);
  assert.equal(report2.skipped, undefined, 'a check failure is an error, not a skip');

  const badTasks = store.searchTasks({ projectId: bad.id, sourceType: ['todo_md'], limit: 10 });
  assert.equal(badTasks.find((t) => t.title === 'fix the bug')!.status, 'open', 'bad-repo\'s task was left alone, not retired');

  const goodTasks = store.searchTasks({ projectId: good.id, sourceType: ['todo_md'], limit: 10 });
  assert.equal(goodTasks.find((t) => t.title === 'ship it')!.status, 'open', 'the next repo in the list was still processed');
});

test('with no GitHub sign-in the run is reported as skipped, not failed, and nothing is fetched or retired', async () => {
  const store = openStore(':memory:');
  const project = store.upsertProject({ slug: 'octavium', name: 'Octavium', github: 'https://github.com/owenpkent/Octavium' });
  const kept = store.upsertFromSource({ sourceType: 'todo_md', sourceId: 'octavium:TODO.md:abc', title: 'Keep me', contentHash: 'h', projectId: project.id, initialStatus: 'open' }).task;
  let calls = 0;
  const fetchImpl = (async () => { calls++; throw new Error('must not be called'); }) as typeof fetch;

  const report = await syncGithubRepoFiles(store, { secrets: memorySecretStore(), fetchImpl });

  assert.equal(report.partial, true);
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /^skipped: Not signed in to GitHub\./);
  assert.equal(calls, 0);
  assert.equal(store.getTask(kept.id)?.status, 'open');
});

test('syncGithubRepoFiles: a checklist file that grew past 1 MB is skipped and reported, and the tasks it already has are kept', async () => {
  const store = openStore(':memory:');
  store.upsertProject({ slug: 'octavium', name: 'Octavium', github: 'https://github.com/o/r' });
  const docs404: FixtureRoute = { pathname: '/repos/o/r/contents/docs', status: 404, json: { message: 'Not Found' } };

  const first = fakeGithubFetch([repoRoute(), fileRoute('TODO.md', '- [ ] fix the bug'), notFound('README.md'), notFound('CLAUDE.md'), docs404]);
  await syncGithubRepoFiles(store, { token: 't', fetchImpl: first.fetchImpl });
  const task = store.searchTasks({ status: ['open'] })[0];
  assert.equal(task.title, 'fix the bug');

  // Over 1 MB the contents API sends no content. That must not read as "the file is now empty".
  const tooBig: FixtureRoute = { pathname: '/repos/o/r/contents/TODO.md', json: { type: 'file', encoding: 'none', content: '', size: 1500000 } };
  const second = fakeGithubFetch([repoRoute(), tooBig, notFound('README.md'), notFound('CLAUDE.md'), docs404]);
  const report = await syncGithubRepoFiles(store, { token: 't', fetchImpl: second.fetchImpl });

  assert.equal(store.getTask(task.id)?.status, 'open');
  assert.equal(report.goneCompleted, 0);
  assert.equal(report.partial, false);
  assert.deepEqual(report.errors, []);
  assert.equal(report.skipped?.length, 1);
  assert.match(report.skipped![0], /octavium:TODO\.md is over 1 MB/);
});

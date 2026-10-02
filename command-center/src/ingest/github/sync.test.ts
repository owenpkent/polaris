import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../../core/index.ts';
import { fakeGithubFetch, type FixtureRoute } from './fixtures.ts';
import { setRepoSettings } from './repoSettings.ts';
import { syncGithub } from './sync.ts';

// Always pass a token. Without one syncGithub falls back to the machine's real `gh` login, which
// made these tests pass only where someone is signed in to GitHub.
const TEST_TOKEN = 'test-token';

const USER: FixtureRoute = { pathname: '/user', json: { login: 'owenpkent' } };

function emptyList(pathname: string, query?: Record<string, string>): FixtureRoute {
  return { pathname, query, json: [] };
}

function store() {
  const s = openStore(':memory:');
  s.upsertProject({ slug: 'octavium', name: 'Octavium', github: 'https://github.com/owenpkent/Octavium' });
  return s;
}

test('assigned issue is created in the inbox, then unchanged on a second sync (idempotency)', async () => {
  const s = store();
  const assignedIssue = {
    number: 7, title: 'Fix crash', body: 'stack trace', state: 'open',
    html_url: 'https://github.com/owenpkent/Octavium/issues/7',
    labels: [], assignees: [{ login: 'owenpkent' }], user: { login: 'owenpkent' },
    repository: { full_name: 'owenpkent/Octavium' },
  };
  const routes: FixtureRoute[] = [
    USER,
    { pathname: '/issues', query: { filter: 'assigned' }, json: [assignedIssue] },
    emptyList('/search/issues'),
    { pathname: '/issues', query: { filter: 'created' }, json: [] },
    emptyList('/repos/owenpkent/Octavium/issues'),
  ];
  const { fetchImpl } = fakeGithubFetch(routes);
  const r1 = await syncGithub(s, { token: TEST_TOKEN, fetchImpl });
  assert.equal(r1.partial, false);
  assert.equal(r1.created, 1);
  const task = s.getTaskBySource('github', 'owenpkent/Octavium#7');
  assert.ok(task);
  assert.equal(task!.status, 'inbox');
  assert.equal(task!.title, 'Fix crash');

  const { fetchImpl: fetchImpl2 } = fakeGithubFetch(routes);
  const r2 = await syncGithub(s, { token: TEST_TOKEN, fetchImpl: fetchImpl2 });
  assert.equal(r2.created, 0);
  assert.equal(r2.unchanged, 1);
});

test('review-requested PR becomes a :review item titled "Review: <title>"', async () => {
  const s = store();
  const pr = {
    number: 3, title: 'Add feature', body: null, state: 'open',
    html_url: 'https://github.com/owenpkent/Octavium/pull/3',
    labels: [], assignees: [], user: { login: 'someoneelse' },
    repository_url: 'https://api.github.com/repos/owenpkent/Octavium',
  };
  const routes: FixtureRoute[] = [
    USER,
    { pathname: '/issues', query: { filter: 'assigned' }, json: [] },
    { pathname: '/search/issues', json: { items: [pr] } },
    { pathname: '/issues', query: { filter: 'created' }, json: [] },
    emptyList('/repos/owenpkent/Octavium/issues'),
  ];
  const { fetchImpl } = fakeGithubFetch(routes);
  const report = await syncGithub(s, { token: TEST_TOKEN, fetchImpl });
  assert.equal(report.created, 1);
  const task = s.getTaskBySource('github', 'owenpkent/Octavium#3:review');
  assert.equal(task?.title, 'Review: Add feature');
});

test('own open PR with a failing check becomes a :attention item', async () => {
  const s = store();
  const prSummary = {
    number: 9, title: 'My change', body: '', state: 'open',
    html_url: 'https://github.com/owenpkent/Octavium/pull/9',
    labels: [], assignees: [], user: { login: 'owenpkent' }, pull_request: {},
    repository: { full_name: 'owenpkent/Octavium' },
  };
  const prDetail = { ...prSummary, head: { sha: 'sha9' }, requested_reviewers: [] };
  const routes: FixtureRoute[] = [
    USER,
    { pathname: '/issues', query: { filter: 'assigned' }, json: [] },
    emptyList('/search/issues'),
    { pathname: '/issues', query: { filter: 'created' }, json: [prSummary] },
    { pathname: '/repos/owenpkent/Octavium/pulls/9', json: prDetail },
    { pathname: '/repos/owenpkent/Octavium/commits/sha9/check-runs', json: { check_runs: [{ status: 'completed', conclusion: 'failure', name: 'ci' }] } },
    { pathname: '/repos/owenpkent/Octavium/commits/sha9/status', json: { state: 'success' } },
    { pathname: '/repos/owenpkent/Octavium/pulls/9/reviews', json: [] },
    emptyList('/repos/owenpkent/Octavium/issues'),
  ];
  const { fetchImpl } = fakeGithubFetch(routes);
  const report = await syncGithub(s, { token: TEST_TOKEN, fetchImpl });
  assert.equal(report.created, 1);
  const task = s.getTaskBySource('github', 'owenpkent/Octavium#9:attention');
  assert.equal(task?.title, 'Fix PR: My change (check failing: ci)');
});

test('open issue opened by someone else in a tracked repo is ingested; the viewer\'s own issue is not', async () => {
  const s = store();
  const othersIssue = {
    number: 11, title: 'Please add X', body: '', state: 'open',
    html_url: 'https://github.com/owenpkent/Octavium/issues/11',
    labels: [], assignees: [], user: { login: 'someoneelse' },
  };
  const ownIssue = {
    number: 12, title: 'My own note', body: '', state: 'open',
    html_url: 'https://github.com/owenpkent/Octavium/issues/12',
    labels: [], assignees: [], user: { login: 'owenpkent' },
  };
  const routes: FixtureRoute[] = [
    USER,
    { pathname: '/issues', query: { filter: 'assigned' }, json: [] },
    emptyList('/search/issues'),
    { pathname: '/issues', query: { filter: 'created' }, json: [] },
    { pathname: '/repos/owenpkent/Octavium/issues', json: [othersIssue, ownIssue] },
  ];
  const { fetchImpl } = fakeGithubFetch(routes);
  const report = await syncGithub(s, { token: TEST_TOKEN, fetchImpl });
  assert.equal(report.created, 1);
  assert.ok(s.getTaskBySource('github', 'owenpkent/Octavium#11'));
  assert.equal(s.getTaskBySource('github', 'owenpkent/Octavium#12'), undefined);
});

test('a closed issue leaves its untriaged task in the inbox, with the fact recorded', async () => {
  const s = store();
  const assignedIssue = {
    number: 7, title: 'Fix crash', body: '', state: 'open',
    html_url: 'https://github.com/owenpkent/Octavium/issues/7',
    labels: [], assignees: [{ login: 'owenpkent' }], user: { login: 'owenpkent' },
    repository: { full_name: 'owenpkent/Octavium' },
  };
  const routesWithIssue: FixtureRoute[] = [
    USER,
    { pathname: '/issues', query: { filter: 'assigned' }, json: [assignedIssue] },
    emptyList('/search/issues'),
    { pathname: '/issues', query: { filter: 'created' }, json: [] },
    emptyList('/repos/owenpkent/Octavium/issues'),
  ];
  await syncGithub(s, { token: TEST_TOKEN, fetchImpl: fakeGithubFetch(routesWithIssue).fetchImpl });
  assert.equal(s.getTaskBySource('github', 'owenpkent/Octavium#7')!.status, 'inbox');

  // Second sync: the issue no longer shows up assigned (closed), and a direct GET confirms it.
  const routesClosed: FixtureRoute[] = [
    USER,
    { pathname: '/issues', query: { filter: 'assigned' }, json: [] },
    emptyList('/search/issues'),
    { pathname: '/issues', query: { filter: 'created' }, json: [] },
    emptyList('/repos/owenpkent/Octavium/issues'),
    { pathname: '/repos/owenpkent/Octavium/issues/7', json: { ...assignedIssue, state: 'closed' } },
  ];
  const report = await syncGithub(s, { token: TEST_TOKEN, fetchImpl: fakeGithubFetch(routesClosed).fetchImpl });
  assert.equal(report.partial, false);
  assert.equal(report.goneCompleted, 1);
  // The owner never accepted this suggestion, so completing it would record work the owner did
  // not do: it would show up in the digest's "Completed" section and count toward any goal it is
  // linked to. It stays in the inbox for the owner to decide, with a comment recording that the
  // source is gone.
  const task = s.getTaskBySource('github', 'owenpkent/Octavium#7')!;
  assert.equal(task.status, 'inbox');
  assert.match(s.listComments(task.id).at(-1)!.body, /closed or resolved upstream/);
});

test('a closed issue does complete its task once the owner has accepted it', async () => {
  const s = store();
  const assignedIssue = {
    number: 7, title: 'Fix crash', body: '', state: 'open',
    html_url: 'https://github.com/owenpkent/Octavium/issues/7',
    labels: [], assignees: [{ login: 'owenpkent' }], user: { login: 'owenpkent' },
    repository: { full_name: 'owenpkent/Octavium' },
  };
  await syncGithub(s, {
    token: TEST_TOKEN,
    fetchImpl: fakeGithubFetch([
      USER,
      { pathname: '/issues', query: { filter: 'assigned' }, json: [assignedIssue] },
      emptyList('/search/issues'),
      { pathname: '/issues', query: { filter: 'created' }, json: [] },
      emptyList('/repos/owenpkent/Octavium/issues'),
    ]).fetchImpl,
  });
  const accepted = s.acceptInboxItem(s.getTaskBySource('github', 'owenpkent/Octavium#7')!.id, {}, 'human');
  assert.equal(accepted.status, 'open');

  await syncGithub(s, {
    token: TEST_TOKEN,
    fetchImpl: fakeGithubFetch([
      USER,
      { pathname: '/issues', query: { filter: 'assigned' }, json: [] },
      emptyList('/search/issues'),
      { pathname: '/issues', query: { filter: 'created' }, json: [] },
      emptyList('/repos/owenpkent/Octavium/issues'),
      { pathname: '/repos/owenpkent/Octavium/issues/7', json: { ...assignedIssue, state: 'closed' } },
    ]).fetchImpl,
  });
  assert.equal(s.getTaskBySource('github', 'owenpkent/Octavium#7')!.status, 'done');
});

test('a partial sync (an errored stage) marks nothing gone', async () => {
  const s = store();
  const assignedIssue = {
    number: 7, title: 'Fix crash', body: '', state: 'open',
    html_url: 'https://github.com/owenpkent/Octavium/issues/7',
    labels: [], assignees: [{ login: 'owenpkent' }], user: { login: 'owenpkent' },
    repository: { full_name: 'owenpkent/Octavium' },
  };
  await syncGithub(s, {
    token: TEST_TOKEN,
    fetchImpl: fakeGithubFetch([
      USER,
      { pathname: '/issues', query: { filter: 'assigned' }, json: [assignedIssue] },
      emptyList('/search/issues'),
      { pathname: '/issues', query: { filter: 'created' }, json: [] },
      emptyList('/repos/owenpkent/Octavium/issues'),
    ]).fetchImpl,
  });
  assert.equal(s.getTaskBySource('github', 'owenpkent/Octavium#7')!.status, 'inbox');

  // Second sync: assigned list now empty (would normally look closed) but the search stage 500s.
  const report = await syncGithub(s, {
    token: TEST_TOKEN,
    fetchImpl: fakeGithubFetch([
      USER,
      { pathname: '/issues', query: { filter: 'assigned' }, json: [] },
      { pathname: '/search/issues', status: 500, json: { message: 'boom' } },
    ]).fetchImpl,
  });
  assert.equal(report.partial, true);
  assert.equal(report.goneCompleted, 0);
  assert.equal(s.getTaskBySource('github', 'owenpkent/Octavium#7')!.status, 'inbox', 'nothing marked gone from a partial sync');
});

test('a rejected item stays suppressed across future syncs', async () => {
  const s = store();
  const issue = {
    number: 20, title: 'Spammy issue', body: '', state: 'open',
    html_url: 'https://github.com/owenpkent/Octavium/issues/20',
    labels: [], assignees: [{ login: 'owenpkent' }], user: { login: 'owenpkent' },
    repository: { full_name: 'owenpkent/Octavium' },
  };
  const routes = (title: string): FixtureRoute[] => [
    USER,
    { pathname: '/issues', query: { filter: 'assigned' }, json: [{ ...issue, title }] },
    emptyList('/search/issues'),
    { pathname: '/issues', query: { filter: 'created' }, json: [] },
    emptyList('/repos/owenpkent/Octavium/issues'),
  ];
  await syncGithub(s, { token: TEST_TOKEN, fetchImpl: fakeGithubFetch(routes('Spammy issue')).fetchImpl });
  const task = s.getTaskBySource('github', 'owenpkent/Octavium#20')!;
  s.rejectInboxItem(task.id, 'not actionable');

  const report = await syncGithub(s, { token: TEST_TOKEN, fetchImpl: fakeGithubFetch(routes('Spammy issue (edited)')).fetchImpl });
  assert.equal(report.suppressed, 1);
  const after = s.getTaskBySource('github', 'owenpkent/Octavium#20')!;
  assert.equal(after.status, 'dropped');
  assert.equal(after.title, 'Spammy issue', 'rejected items never come back, even when the source changes');
});

test('an ETag 304 on the assigned-issues page is treated as "no changes reported" and never marks tasks gone', async () => {
  const s = store();
  const assignedIssue = {
    number: 7, title: 'Fix crash', body: '', state: 'open',
    html_url: 'https://github.com/owenpkent/Octavium/issues/7',
    labels: [], assignees: [{ login: 'owenpkent' }], user: { login: 'owenpkent' },
    repository: { full_name: 'owenpkent/Octavium' },
  };
  await syncGithub(s, {
    token: TEST_TOKEN,
    fetchImpl: fakeGithubFetch([
      USER,
      { pathname: '/issues', query: { filter: 'assigned' }, json: [assignedIssue] },
      emptyList('/search/issues'),
      { pathname: '/issues', query: { filter: 'created' }, json: [] },
      emptyList('/repos/owenpkent/Octavium/issues'),
    ]).fetchImpl,
  });

  // Second sync: assigned-issues page 304s (nothing changed). The disappearance sweep still
  // confirms #7 directly and finds it open, so nothing is marked gone.
  const report = await syncGithub(s, {
    token: TEST_TOKEN,
    fetchImpl: fakeGithubFetch([
      USER,
      { pathname: '/issues', query: { filter: 'assigned' }, status: 304 },
      emptyList('/search/issues'),
      { pathname: '/issues', query: { filter: 'created' }, json: [] },
      emptyList('/repos/owenpkent/Octavium/issues'),
      { pathname: '/repos/owenpkent/Octavium/issues/7', json: assignedIssue },
    ]).fetchImpl,
  });
  assert.equal(report.partial, false);
  assert.equal(report.goneCompleted, 0);
  assert.equal(s.getTaskBySource('github', 'owenpkent/Octavium#7')!.status, 'inbox');
});

test('--dry-run does not write to the store', async () => {
  const s = store();
  const issue = {
    number: 30, title: 'Dry run me', body: '', state: 'open',
    html_url: 'https://github.com/owenpkent/Octavium/issues/30',
    labels: [], assignees: [{ login: 'owenpkent' }], user: { login: 'owenpkent' },
    repository: { full_name: 'owenpkent/Octavium' },
  };
  const report = await syncGithub(s, {
    token: TEST_TOKEN,
    dryRun: true,
    fetchImpl: fakeGithubFetch([
      USER,
      { pathname: '/issues', query: { filter: 'assigned' }, json: [issue] },
      emptyList('/search/issues'),
      { pathname: '/issues', query: { filter: 'created' }, json: [] },
      emptyList('/repos/owenpkent/Octavium/issues'),
    ]).fetchImpl,
  });
  assert.equal(report.created, 1);
  assert.equal(s.getTaskBySource('github', 'owenpkent/Octavium#30'), undefined);
});

test('a dry run never poisons the ETag cache: a real sync right after still creates the items', async () => {
  const s = store();
  const issue = {
    number: 40, title: 'Do not lose me', body: '', state: 'open',
    html_url: 'https://github.com/owenpkent/Octavium/issues/40',
    labels: [], assignees: [{ login: 'owenpkent' }], user: { login: 'owenpkent' },
    repository: { full_name: 'owenpkent/Octavium' },
  };
  const routes = (): FixtureRoute[] => [
    USER,
    { pathname: '/issues', query: { filter: 'assigned' }, json: [issue], headers: { etag: 'W/"assigned-v1"' } },
    emptyList('/search/issues'),
    { pathname: '/issues', query: { filter: 'created' }, json: [] },
    emptyList('/repos/owenpkent/Octavium/issues'),
  ];

  const dryReport = await syncGithub(s, { token: TEST_TOKEN, dryRun: true, fetchImpl: fakeGithubFetch(routes()).fetchImpl });
  assert.equal(dryReport.created, 1);
  assert.equal(s.getTaskBySource('github', 'owenpkent/Octavium#40'), undefined, 'dry run must not write');

  // If the dry run had persisted the ETag, this real sync would get a 304 and create nothing.
  const realReport = await syncGithub(s, { token: TEST_TOKEN, fetchImpl: fakeGithubFetch(routes()).fetchImpl });
  assert.equal(realReport.created, 1, 'the dry run must not have cached an ETag that starves this real sync');
  assert.ok(s.getTaskBySource('github', 'owenpkent/Octavium#40'));
});

test('a genuine 304 against a previously committed ETag reuses the cached list: unchanged, nothing gone', async () => {
  const s = store();
  const issue = {
    number: 41, title: 'Steady state', body: '', state: 'open',
    html_url: 'https://github.com/owenpkent/Octavium/issues/41',
    labels: [], assignees: [{ login: 'owenpkent' }], user: { login: 'owenpkent' },
    repository: { full_name: 'owenpkent/Octavium' },
  };
  const first = await syncGithub(s, {
    token: TEST_TOKEN,
    fetchImpl: fakeGithubFetch([
      USER,
      { pathname: '/issues', query: { filter: 'assigned' }, json: [issue], headers: { etag: 'W/"assigned-v1"' } },
      emptyList('/search/issues'),
      { pathname: '/issues', query: { filter: 'created' }, json: [] },
      emptyList('/repos/owenpkent/Octavium/issues'),
    ]).fetchImpl,
  });
  assert.equal(first.created, 1);

  // The assigned-issues list now 304s. A correct client reuses the cached list (still #41)
  // instead of seeing an empty list, which would otherwise send #41 into the disappearance sweep.
  const second = await syncGithub(s, {
    token: TEST_TOKEN,
    fetchImpl: fakeGithubFetch([
      USER,
      { pathname: '/issues', query: { filter: 'assigned' }, status: 304 },
      emptyList('/search/issues'),
      { pathname: '/issues', query: { filter: 'created' }, json: [] },
      emptyList('/repos/owenpkent/Octavium/issues'),
    ]).fetchImpl,
  });
  assert.equal(second.partial, false);
  assert.equal(second.unchanged, 1);
  assert.equal(second.goneCompleted, 0);
  assert.equal(s.getTaskBySource('github', 'owenpkent/Octavium#41')!.status, 'inbox');
});

test('a later stage failing does not undo an earlier stage\'s already-successful ETag commit', async () => {
  const s = store();
  const issue = {
    number: 50, title: 'Fine on its own', body: '', state: 'open',
    html_url: 'https://github.com/owenpkent/Octavium/issues/50',
    labels: [], assignees: [{ login: 'owenpkent' }], user: { login: 'owenpkent' },
    repository: { full_name: 'owenpkent/Octavium' },
  };
  // The assigned-issues stage fully succeeds (fetch + upsert), so it commits its own ETag;
  // the search stage failing afterwards makes the overall sync partial, but must not reach
  // back and discard a stage that already completed cleanly.
  const report = await syncGithub(s, {
    token: TEST_TOKEN,
    fetchImpl: fakeGithubFetch([
      USER,
      { pathname: '/issues', query: { filter: 'assigned' }, json: [issue], headers: { etag: 'W/"assigned-v1"' } },
      { pathname: '/search/issues', status: 500, json: { message: 'boom' } },
    ]).fetchImpl,
  });
  assert.equal(report.partial, true);
  const url = 'https://api.github.com/issues?per_page=100&filter=assigned&state=open';
  assert.ok(s.getKv(`github:etag:${url}`), 'the assigned stage\'s own successful ETag survives a later stage\'s failure');
});

test('a stage whose upserts fail after a successful fetch does not persist that stage\'s own ETag', async () => {
  const s = store();
  const badIssue = {
    number: 51, title: '   ', body: '', state: 'open', // blank title: Store rejects it mid-upsert
    html_url: 'https://github.com/owenpkent/Octavium/issues/51',
    labels: [], assignees: [{ login: 'owenpkent' }], user: { login: 'owenpkent' },
    repository: { full_name: 'owenpkent/Octavium' },
  };
  const report = await syncGithub(s, {
    token: TEST_TOKEN,
    fetchImpl: fakeGithubFetch([
      USER,
      { pathname: '/issues', query: { filter: 'assigned' }, json: [badIssue], headers: { etag: 'W/"assigned-v1"' } },
      emptyList('/search/issues'),
      { pathname: '/issues', query: { filter: 'created' }, json: [] },
      emptyList('/repos/owenpkent/Octavium/issues'),
    ]).fetchImpl,
  });
  assert.equal(report.partial, true);
  const url = 'https://api.github.com/issues?per_page=100&filter=assigned&state=open';
  assert.equal(s.getKv(`github:etag:${url}`), undefined, 'the fetch succeeded but the upsert that followed it did not');
});

test('the review search uses user-review-requested, not the broader review-requested', async () => {
  const s = store();
  const pr = {
    number: 60, title: 'Team-adjacent PR', body: null, state: 'open',
    html_url: 'https://github.com/owenpkent/Octavium/pull/60',
    labels: [], assignees: [], user: { login: 'someoneelse' },
    repository_url: 'https://api.github.com/repos/owenpkent/Octavium',
  };
  // The fixture only answers the narrower query; a route match failure (falling through to a 404)
  // would show up as report.partial, catching a regression back to the team-inclusive query.
  const report = await syncGithub(s, {
    token: TEST_TOKEN,
    fetchImpl: fakeGithubFetch([
      USER,
      { pathname: '/issues', query: { filter: 'assigned' }, json: [] },
      { pathname: '/search/issues', query: { q: 'is:pr is:open user-review-requested:@me' }, json: { items: [pr] } },
      { pathname: '/issues', query: { filter: 'created' }, json: [] },
      emptyList('/repos/owenpkent/Octavium/issues'),
    ]).fetchImpl,
  });
  assert.equal(report.partial, false);
  assert.equal(report.created, 1);
  assert.ok(s.getTaskBySource('github', 'owenpkent/Octavium#60:review'));
});

test('a review request only through a team never flaps: the disappearance sweep leaves it alone if requested_reviewers still lists the viewer', async () => {
  const s = store();
  const prIssue = {
    number: 61, title: 'Reviewed via team', body: null, state: 'open',
    html_url: 'https://github.com/owenpkent/Octavium/pull/61',
    labels: [], assignees: [], user: { login: 'someoneelse' }, pull_request: {},
  };
  // Created once via the (individual) search result.
  await syncGithub(s, {
    token: TEST_TOKEN,
    fetchImpl: fakeGithubFetch([
      USER,
      { pathname: '/issues', query: { filter: 'assigned' }, json: [] },
      { pathname: '/search/issues', query: { q: 'is:pr is:open user-review-requested:@me' }, json: { items: [{ ...prIssue, repository_url: 'https://api.github.com/repos/owenpkent/Octavium' }] } },
      { pathname: '/issues', query: { filter: 'created' }, json: [] },
      emptyList('/repos/owenpkent/Octavium/issues'),
    ]).fetchImpl,
  });
  assert.equal(s.getTaskBySource('github', 'owenpkent/Octavium#61:review')!.status, 'inbox');

  // Next poll: the search result is empty this time (e.g. search index lag), so the
  // disappearance sweep confirms directly. The PR detail still lists the viewer individually
  // in requested_reviewers, so it must stay open rather than being completed and reopened.
  const report = await syncGithub(s, {
    token: TEST_TOKEN,
    fetchImpl: fakeGithubFetch([
      USER,
      { pathname: '/issues', query: { filter: 'assigned' }, json: [] },
      { pathname: '/search/issues', query: { q: 'is:pr is:open user-review-requested:@me' }, json: { items: [] } },
      { pathname: '/issues', query: { filter: 'created' }, json: [] },
      emptyList('/repos/owenpkent/Octavium/issues'),
      { pathname: '/repos/owenpkent/Octavium/issues/61', json: prIssue },
      { pathname: '/repos/owenpkent/Octavium/pulls/61', json: { ...prIssue, head: { sha: 'sha61' }, requested_reviewers: [{ login: 'owenpkent' }] } },
    ]).fetchImpl,
  });
  assert.equal(report.goneCompleted, 0);
  assert.equal(s.getTaskBySource('github', 'owenpkent/Octavium#61:review')!.status, 'inbox');
});

test('once requested_reviewers clears, the sweep retires the :review task (no flap back)', async () => {
  const s = store();
  const prIssue = {
    number: 62, title: 'Review done', body: null, state: 'open',
    html_url: 'https://github.com/owenpkent/Octavium/pull/62',
    labels: [], assignees: [], user: { login: 'someoneelse' }, pull_request: {},
  };
  await syncGithub(s, {
    token: TEST_TOKEN,
    fetchImpl: fakeGithubFetch([
      USER,
      { pathname: '/issues', query: { filter: 'assigned' }, json: [] },
      { pathname: '/search/issues', query: { q: 'is:pr is:open user-review-requested:@me' }, json: { items: [{ ...prIssue, repository_url: 'https://api.github.com/repos/owenpkent/Octavium' }] } },
      { pathname: '/issues', query: { filter: 'created' }, json: [] },
      emptyList('/repos/owenpkent/Octavium/issues'),
    ]).fetchImpl,
  });

  const report = await syncGithub(s, {
    token: TEST_TOKEN,
    fetchImpl: fakeGithubFetch([
      USER,
      { pathname: '/issues', query: { filter: 'assigned' }, json: [] },
      { pathname: '/search/issues', query: { q: 'is:pr is:open user-review-requested:@me' }, json: { items: [] } },
      { pathname: '/issues', query: { filter: 'created' }, json: [] },
      emptyList('/repos/owenpkent/Octavium/issues'),
      { pathname: '/repos/owenpkent/Octavium/issues/62', json: prIssue },
      { pathname: '/repos/owenpkent/Octavium/pulls/62', json: { ...prIssue, head: { sha: 'sha62' }, requested_reviewers: [] } },
    ]).fetchImpl,
  });
  assert.equal(report.goneCompleted, 1);
  // Same rule as the closed-issue case: the review request is gone, but the owner never accepted
  // the suggestion, so it waits in the inbox rather than being recorded as a review the owner completed.
  const reviewTask = s.getTaskBySource('github', 'owenpkent/Octavium#62:review')!;
  assert.equal(reviewTask.status, 'inbox');
  assert.match(s.listComments(reviewTask.id).at(-1)!.body, /closed or resolved upstream/);
});

test('syncIssues=false: no new item is created from that repo (assigned, review-requested, own-PR-attention, or tracked-repo issues), and an existing task from it is left untouched by the disappearance sweep', async () => {
  const s = store();
  const assignedIssue = {
    number: 7, title: 'Fix crash', body: '', state: 'open',
    html_url: 'https://github.com/owenpkent/Octavium/issues/7',
    labels: [], assignees: [{ login: 'owenpkent' }], user: { login: 'owenpkent' },
    repository: { full_name: 'owenpkent/Octavium' },
  };
  await syncGithub(s, {
    token: TEST_TOKEN,
    fetchImpl: fakeGithubFetch([
      USER,
      { pathname: '/issues', query: { filter: 'assigned' }, json: [assignedIssue] },
      emptyList('/search/issues'),
      { pathname: '/issues', query: { filter: 'created' }, json: [] },
      emptyList('/repos/owenpkent/Octavium/issues'),
    ]).fetchImpl,
  });
  assert.equal(s.getTaskBySource('github', 'owenpkent/Octavium#7')!.status, 'inbox');

  setRepoSettings(s, 'owenpkent/Octavium', { syncIssues: false });

  const newIssue = {
    number: 8, title: 'Should never be created', body: '', state: 'open',
    html_url: 'https://github.com/owenpkent/Octavium/issues/8',
    labels: [], assignees: [{ login: 'owenpkent' }], user: { login: 'owenpkent' },
    repository: { full_name: 'owenpkent/Octavium' },
  };
  const reviewPr = {
    number: 9, title: 'Should never be created either', body: null, state: 'open',
    html_url: 'https://github.com/owenpkent/Octavium/pull/9',
    labels: [], assignees: [], user: { login: 'someoneelse' },
    repository_url: 'https://api.github.com/repos/owenpkent/Octavium',
  };
  // No fixture for GET /repos/owenpkent/Octavium/issues/7 (the disappearance sweep's per-item
  // confirmation) or /repos/owenpkent/Octavium/issues (the tracked-repo stage): a correct
  // implementation never calls either once the repo's sync is turned off, so their absence from
  // this fixture list would otherwise surface as a 404 -> report.partial/errors.
  const report = await syncGithub(s, {
    token: TEST_TOKEN,
    fetchImpl: fakeGithubFetch([
      USER,
      { pathname: '/issues', query: { filter: 'assigned' }, json: [newIssue] },
      { pathname: '/search/issues', query: { q: 'is:pr is:open user-review-requested:@me' }, json: { items: [reviewPr] } },
      { pathname: '/issues', query: { filter: 'created' }, json: [] },
    ]).fetchImpl,
  });

  assert.equal(report.partial, false);
  assert.equal(report.created, 0, 'nothing from the disabled repo is created, even from @me searches');
  assert.equal(report.goneCompleted, 0, 'the disabled repo\'s existing task is left alone, not confirmed or swept');
  assert.equal(s.getTaskBySource('github', 'owenpkent/Octavium#7')!.status, 'inbox', 'untouched');
  assert.equal(s.getTaskBySource('github', 'owenpkent/Octavium#8'), undefined);
  assert.equal(s.getTaskBySource('github', 'owenpkent/Octavium#9:review'), undefined);
});

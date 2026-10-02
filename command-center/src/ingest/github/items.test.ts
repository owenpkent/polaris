import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../../core/index.ts';
import { fakeGithubFetch } from './fixtures.ts';
import { GithubClient } from './client.ts';
import { buildAttentionItem, buildPlainItem, buildReviewItem, checkAttention, isPullRequest, priorityFor } from './items.ts';

const baseIssue = {
  number: 42,
  title: 'Something broke',
  body: 'a'.repeat(600),
  state: 'open',
  html_url: 'https://github.com/owenpkent/Octavium/issues/42',
  labels: [{ name: 'bug' }, { name: 'ui' }],
  assignees: [{ login: 'owenpkent' }],
  user: { login: 'someoneelse' },
};

test('priorityFor flags bug/urgent/critical/P0/P1 labels, case-insensitively', () => {
  assert.equal(priorityFor(baseIssue), 'high');
  assert.equal(priorityFor({ ...baseIssue, labels: [{ name: 'P1' }] }), 'high');
  assert.equal(priorityFor({ ...baseIssue, labels: [{ name: 'enhancement' }] }), 'none');
  assert.equal(priorityFor({ ...baseIssue, labels: [] }), 'none');
});

test('isPullRequest distinguishes issues from PRs', () => {
  assert.equal(isPullRequest(baseIssue), false);
  assert.equal(isPullRequest({ ...baseIssue, pull_request: {} }), true);
});

test('buildPlainItem truncates body to 500 chars and includes labels + author in notes', () => {
  const item = buildPlainItem('owenpkent/Octavium', baseIssue, 'p1');
  assert.equal(item.sourceType, 'github');
  assert.equal(item.sourceId, 'owenpkent/Octavium#42');
  assert.equal(item.title, 'Something broke');
  assert.equal(item.initialStatus, 'inbox');
  assert.equal(item.priority, 'high');
  assert.ok(item.notes!.includes('a'.repeat(500)));
  assert.ok(!item.notes!.includes('a'.repeat(501)));
  assert.ok(item.notes!.includes('Labels: bug, ui'));
  assert.ok(item.notes!.includes('Author: someoneelse'));
});

test('contentHash ignores updated_at-style fields and reacts to title/labels/assignees/state', () => {
  const a = buildPlainItem('o/r', baseIssue, null);
  const b = buildPlainItem('o/r', { ...baseIssue }, null);
  assert.equal(a.contentHash, b.contentHash);
  const changedTitle = buildPlainItem('o/r', { ...baseIssue, title: 'Different' }, null);
  assert.notEqual(a.contentHash, changedTitle.contentHash);
  const changedAssignees = buildPlainItem('o/r', { ...baseIssue, assignees: [] }, null);
  assert.notEqual(a.contentHash, changedAssignees.contentHash);
});

test('buildReviewItem prefixes the title with "Review:" and works from plain issue-shaped fields', () => {
  const pr = { ...baseIssue, pull_request: {} };
  const item = buildReviewItem('owenpkent/Octavium', pr, 'p1');
  assert.equal(item.sourceId, 'owenpkent/Octavium#42:review');
  assert.equal(item.title, 'Review: Something broke');
});

test('buildAttentionItem folds the reason into the title and the content hash', () => {
  const pr = { ...baseIssue, pull_request: {}, head: { sha: 'abc' } };
  const failing = buildAttentionItem('owenpkent/Octavium', pr, 'p1', 'check failing: build');
  const changesRequested = buildAttentionItem('owenpkent/Octavium', pr, 'p1', 'changes requested');
  assert.equal(failing.sourceId, 'owenpkent/Octavium#42:attention');
  assert.equal(failing.title, 'Fix PR: Something broke (check failing: build)');
  assert.notEqual(failing.contentHash, changesRequested.contentHash);
});

test('checkAttention: failing check run wins over everything else', async () => {
  const store = openStore(':memory:');
  const { fetchImpl } = fakeGithubFetch([
    { pathname: '/repos/o/r/commits/sha1/check-runs', json: { check_runs: [{ status: 'completed', conclusion: 'failure', name: 'build' }] } },
    { pathname: '/repos/o/r/commits/sha1/status', json: { state: 'success' } },
    { pathname: '/repos/o/r/pulls/1/reviews', json: [] },
  ]);
  const client = new GithubClient({ token: 't', store, fetchImpl });
  const pr = { ...baseIssue, number: 1, pull_request: {}, head: { sha: 'sha1' } };
  assert.equal(await checkAttention(client, 'o', 'r', pr), 'check failing: build');
});

test('checkAttention: falls back to combined status, then to changes-requested review, then null', async () => {
  const store = openStore(':memory:');
  const passing = fakeGithubFetch([
    { pathname: '/repos/o/r/commits/sha1/check-runs', json: { check_runs: [] } },
    { pathname: '/repos/o/r/commits/sha1/status', json: { state: 'failure' } },
    { pathname: '/repos/o/r/pulls/1/reviews', json: [] },
  ]);
  const clientA = new GithubClient({ token: 't', store, fetchImpl: passing.fetchImpl });
  const pr = { ...baseIssue, number: 1, pull_request: {}, head: { sha: 'sha1' } };
  assert.equal(await checkAttention(clientA, 'o', 'r', pr), 'status checks failing');

  const reviewed = fakeGithubFetch([
    { pathname: '/repos/o/r/commits/sha1/check-runs', json: { check_runs: [] } },
    { pathname: '/repos/o/r/commits/sha1/status', json: { state: 'success' } },
    { pathname: '/repos/o/r/pulls/1/reviews', json: [{ user: { login: 'rev' }, state: 'COMMENTED' }, { user: { login: 'rev2' }, state: 'CHANGES_REQUESTED' }] },
  ]);
  const clientB = new GithubClient({ token: 't', store, fetchImpl: reviewed.fetchImpl });
  assert.equal(await checkAttention(clientB, 'o', 'r', pr), 'changes requested');

  const clean = fakeGithubFetch([
    { pathname: '/repos/o/r/commits/sha1/check-runs', json: { check_runs: [] } },
    { pathname: '/repos/o/r/commits/sha1/status', json: { state: 'success' } },
    { pathname: '/repos/o/r/pulls/1/reviews', json: [{ user: { login: 'rev' }, state: 'APPROVED' }] },
  ]);
  const clientC = new GithubClient({ token: 't', store, fetchImpl: clean.fetchImpl });
  assert.equal(await checkAttention(clientC, 'o', 'r', pr), null);
});

test('the content hash covers projectId, so a task links up once its repo becomes tracked', () => {
  // upsertFromSource short-circuits on an unchanged hash before it applies projectId, so a task
  // created while its repo was untracked would otherwise stay unlinked forever.
  const issue = {
    number: 7, title: 'Fix crash', body: 'b', state: 'open',
    html_url: 'https://github.com/o/r/issues/7',
    labels: [], assignees: [{ login: 'owenpkent' }], user: { login: 'owenpkent' },
  } as never;

  const untracked = buildPlainItem('o/r', issue, null);
  const tracked = buildPlainItem('o/r', issue, 'p_123');
  assert.notEqual(untracked.contentHash, tracked.contentHash);
  assert.equal(buildPlainItem('o/r', issue, 'p_123').contentHash, tracked.contentHash, 'and is still stable');
});

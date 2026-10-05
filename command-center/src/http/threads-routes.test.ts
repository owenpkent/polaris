import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_TOKENS, api, fakeApp, withServer } from './test-support.ts';

// docs/agent-threads-proposal.md, stage 1: the owner's side of a thread over REST.

test('threads: open one on a task, post to it, read it back, and list it with counts', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const task = app.store.createTask({ title: 'Why does the solver stall?' }, 'human');
  await withServer(app, {}, async (base) => {
    assert.equal((await api(base, 'GET', `/api/tasks/${task.id}/thread`)).status, 404, 'no thread yet');
    assert.deepEqual((await api(base, 'GET', '/api/threads')).json, { threads: [] });

    const opened = await api(base, 'POST', `/api/tasks/${task.id}/thread`, { title: 'Stall analysis' });
    assert.equal(opened.status, 201);
    const thread = opened.json.thread;
    assert.equal(thread.taskId, task.id);
    assert.equal(thread.title, 'Stall analysis');
    assert.equal(thread.status, 'open');

    // Opening it again is the same thread, answered 200.
    const again = await api(base, 'POST', `/api/tasks/${task.id}/thread`, {});
    assert.equal(again.status, 200);
    assert.equal(again.json.thread.id, thread.id);

    const claim = await api(base, 'POST', `/api/threads/${thread.id}/posts`, { type: 'claim', body: 'It is a cache miss.', confidence: 'medium' });
    assert.equal(claim.status, 201);
    assert.equal(claim.json.post.author, 'human');
    assert.equal(claim.json.post.authorName, null);
    assert.equal(claim.json.post.status, 'open');
    assert.equal(claim.json.post.untrustedText, false);
    const objection = await api(base, 'POST', `/api/threads/${thread.id}/posts`, { type: 'objection', body: 'The profile disagrees.', refs: [claim.json.post.id], parentPostId: claim.json.post.id });
    assert.equal(objection.status, 201);
    assert.equal(objection.json.post.status, null);

    const byTask = await api(base, 'GET', `/api/tasks/${task.id}/thread`);
    assert.equal(byTask.status, 200);
    assert.equal(byTask.json.thread.id, thread.id);
    assert.deepEqual(byTask.json.posts.map((p: { type: string }) => p.type), ['claim', 'objection']);

    const byId = await api(base, 'GET', `/api/threads/${thread.id}?after=${claim.json.post.id}&limit=10`);
    assert.equal(byId.status, 200);
    assert.deepEqual(byId.json.posts.map((p: { id: string }) => p.id), [objection.json.post.id]);

    const list = await api(base, 'GET', '/api/threads?status=open');
    assert.equal(list.status, 200);
    assert.equal(list.json.threads.length, 1);
    assert.deepEqual(
      (({ taskTitle, postCount, openClaims, objections, results }) => ({ taskTitle, postCount, openClaims, objections, results }))(list.json.threads[0]),
      { taskTitle: 'Why does the solver stall?', postCount: 2, openClaims: 1, objections: 1, results: 0 },
    );
    assert.deepEqual((await api(base, 'GET', '/api/threads?status=closed')).json, { threads: [] });
    assert.equal((await api(base, 'GET', '/api/threads?status=stale')).status, 400);
  });
  // Every write landed in history as the human, and the task itself is untouched by them.
  const kinds = app.store.taskHistory(task.id).map((e) => [e.kind, e.actor]);
  assert.deepEqual(kinds, [['task.created', 'human'], ['thread.created', 'human'], ['post.added', 'human'], ['post.added', 'human']]);
  assert.equal(app.store.requireTask(task.id).status, 'open');
});

test('threads: bad input is a 400, missing things are 404, and the thread token boundary holds', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const task = app.store.createTask({ title: 'T' }, 'human');
  await withServer(app, {}, async (base) => {
    assert.equal((await api(base, 'POST', '/api/tasks/t_missing000/thread', {})).status, 404);
    const thread = (await api(base, 'POST', `/api/tasks/${task.id}/thread`, {})).json.thread;
    assert.equal((await api(base, 'POST', `/api/threads/${thread.id}/posts`, { type: 'verdict', body: 'x' })).status, 400);
    assert.equal((await api(base, 'POST', `/api/threads/${thread.id}/posts`, { type: 'claim', body: '' })).status, 400);
    assert.equal((await api(base, 'POST', `/api/threads/${thread.id}/posts`, { type: 'claim', body: 'x', confidence: 'sure' })).status, 400);
    assert.equal((await api(base, 'POST', `/api/threads/${thread.id}/posts`, { type: 'claim', body: 'x', refs: ['po_missing000'] })).status, 400);
    assert.equal((await api(base, 'POST', `/api/threads/${thread.id}/posts`, { type: 'claim', body: 'x', status: 'accepted' })).status, 400, 'no status from the client');
    assert.equal((await api(base, 'POST', `/api/threads/${thread.id}/posts`, { type: 'claim', body: 'x', opId: 'op-0000000001', deviceId: 'device-test' })).status, 400, 'a post carries no op identity');
    assert.equal((await api(base, 'POST', '/api/threads/th_missing000/posts', { type: 'claim', body: 'x' })).status, 404);
    assert.equal((await api(base, 'GET', '/api/threads/th_missing000')).status, 404);
    assert.equal((await api(base, 'GET', `/api/threads/${thread.id}?after=po_missing000`)).status, 404);

    // The MCP tokens are refused on the REST thread routes, like every other /api route.
    for (const token of [TEST_TOKENS.mcp, TEST_TOKENS.mcpReadonly]) {
      const res = await fetch(`${base}/api/threads/${thread.id}/posts`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'claim', body: 'x' }),
      });
      assert.equal(res.status, 401);
    }
    assert.equal(app.store.listPosts(thread.id).length, 0);
  });
});

test('threads: an inbox task refuses a thread, and once accepted its posts are marked untrusted in the answer', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const { task } = app.store.upsertFromSource({ sourceType: 'github', sourceId: 'o/r#1', title: 'Issue', contentHash: 'h' });
  await withServer(app, {}, async (base) => {
    const refused = await api(base, 'POST', `/api/tasks/${task.id}/thread`, {});
    assert.equal(refused.status, 400);
    assert.equal((await api(base, 'GET', `/api/tasks/${task.id}/thread`)).status, 404);
    app.store.acceptInboxItem(task.id, {}, 'human');
    const thread = (await api(base, 'POST', `/api/tasks/${task.id}/thread`, {})).json.thread;
    const post = await api(base, 'POST', `/api/threads/${thread.id}/posts`, { type: 'question', body: 'Which build?' });
    assert.equal(post.json.post.untrustedText, true);
  });
});

// ---- stage 2: the owner's controls over REST ----

test('threads: the owner judges, pins, sets options, closes, reopens, forks, and searches, every one as the human', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const task = app.store.createTask({ title: 'Why does the solver stall?' }, 'human');
  const thread = app.store.createThread(task.id, null, 'human');
  const claim = app.store.addPost(thread.id, { type: 'claim', body: 'Cache miss.' }, 'agent', { actor: 'agent', name: 'scribe' });
  const objection = app.store.addPost(thread.id, { type: 'objection', body: 'Profile says no.' }, 'agent', { actor: 'agent', name: 'critic' });
  const summary = app.store.addPost(thread.id, { type: 'summary', body: 'Where we are.' }, 'agent', { actor: 'agent', name: 'scribe' });
  const result = app.store.addPost(thread.id, { type: 'result', body: 'Holds on the small case.' }, 'agent', { actor: 'agent', name: 'scribe' });
  await withServer(app, {}, async (base) => {
    const judged = await api(base, 'PATCH', `/api/posts/${claim.id}`, { status: 'accepted' });
    assert.equal(judged.status, 200);
    assert.equal(judged.json.post.status, 'accepted');
    assert.ok(judged.json.post.judgedAt);
    assert.equal((await api(base, 'PATCH', `/api/posts/${objection.id}`, { status: 'accepted' })).status, 400, 'an objection carries no status');
    assert.equal((await api(base, 'PATCH', `/api/posts/${claim.id}`, { status: 'done' })).status, 400);
    assert.equal((await api(base, 'PATCH', '/api/posts/po_missing000', { status: 'accepted' })).status, 404);
    assert.equal((await api(base, 'PATCH', `/api/posts/${result.id}`, { status: 'accepted' })).status, 200);

    const pinned = await api(base, 'PATCH', `/api/threads/${thread.id}`, { pinnedPostId: summary.id, authorHidden: true, dailyCap: 3 });
    assert.equal(pinned.status, 200);
    assert.equal(pinned.json.thread.pinnedPostId, summary.id);
    assert.equal(pinned.json.thread.authorHidden, true);
    assert.equal(pinned.json.thread.dailyCap, 3);
    // A reader of the thread gets the pinned post by id, whatever window of posts it asked for.
    const windowed = await api(base, 'GET', `/api/threads/${thread.id}?limit=1`);
    assert.equal(windowed.json.pinned.id, summary.id);
    assert.equal(windowed.json.posts.length, 1);
    assert.ok(windowed.json.total >= 2);
    assert.equal((await api(base, 'PATCH', `/api/threads/${thread.id}`, {})).status, 400, 'nothing to change');
    assert.equal((await api(base, 'PATCH', `/api/threads/${thread.id}`, { dailyCap: 0 })).status, 400);
    assert.equal((await api(base, 'PATCH', `/api/threads/${thread.id}`, { pinnedPostId: 'po_missing000' })).status, 400);
    assert.equal((await api(base, 'PATCH', `/api/threads/${thread.id}`, { status: 'closed' })).status, 400, 'status is not a patch field');
    const unpinned = await api(base, 'PATCH', `/api/threads/${thread.id}`, { pinnedPostId: null, dailyCap: null });
    assert.equal(unpinned.json.thread.pinnedPostId, null);
    assert.equal(unpinned.json.thread.dailyCap, null);
    assert.equal(unpinned.json.thread.authorHidden, true);

    const list = await api(base, 'GET', '/api/threads');
    const row = list.json.threads[0];
    assert.equal(row.unansweredObjections, 1);
    assert.equal(row.acceptedResults, 1);
    assert.equal(row.openClaims, 0);
    assert.equal(row.lastProgressAt, (await api(base, 'GET', `/api/threads/${thread.id}`)).json.posts.find((p: { id: string }) => p.id === result.id).judgedAt);
    assert.equal(row.thread.authorHidden, true);

    const search = await api(base, 'GET', '/api/posts?type=result&status=accepted');
    assert.deepEqual(search.json.posts.map((h: { post: { id: string }; taskTitle: string; threadTitle: string }) => [h.post.id, h.taskTitle, h.threadTitle]), [[result.id, 'Why does the solver stall?', 'Why does the solver stall?']]);
    assert.equal((await api(base, 'GET', '/api/posts?q=profile')).json.posts.length, 1);
    assert.equal((await api(base, 'GET', `/api/posts?taskId=${task.id}&limit=2`)).json.posts.length, 2);
    assert.equal((await api(base, 'GET', '/api/posts?type=verdict')).status, 400);
    assert.equal((await api(base, 'GET', '/api/posts?status=done')).status, 400);

    const closed = await api(base, 'POST', `/api/threads/${thread.id}/close`, {});
    assert.equal(closed.status, 200);
    assert.equal(closed.json.thread.status, 'closed');
    assert.equal((await api(base, 'POST', `/api/threads/${thread.id}/posts`, { type: 'claim', body: 'x' })).status, 400, 'closed threads take no posts');
    assert.equal((await api(base, 'POST', `/api/threads/${thread.id}/close`, {})).status, 400);
    assert.equal((await api(base, 'POST', `/api/threads/${thread.id}/fork`, { title: 'B' })).status, 400, 'a closed thread cannot fork');
    const reopened = await api(base, 'POST', `/api/threads/${thread.id}/reopen`, {});
    assert.equal(reopened.json.thread.status, 'open');
    assert.equal((await api(base, 'POST', `/api/threads/${thread.id}/reopen`, {})).status, 400);

    assert.equal((await api(base, 'POST', `/api/threads/${thread.id}/fork`, {})).status, 400, 'a fork needs a title');
    const forked = await api(base, 'POST', `/api/threads/${thread.id}/fork`, { title: 'Approach B' });
    assert.equal(forked.status, 201);
    assert.equal(forked.json.thread.status, 'closed');
    assert.equal(forked.json.thread.successorThreadId, forked.json.successor.id);
    assert.equal(forked.json.task.parentId, task.id);
    assert.equal(forked.json.task.title, 'Approach B');
    assert.equal((await api(base, 'GET', `/api/tasks/${forked.json.task.id}/thread`)).json.thread.id, forked.json.successor.id);
    assert.equal((await api(base, 'POST', '/api/threads/th_missing000/close', {})).status, 404);

    // The MCP tokens are refused on every owner route.
    for (const [method, path] of [['PATCH', `/api/posts/${claim.id}`], ['PATCH', `/api/threads/${thread.id}`], ['POST', `/api/threads/${thread.id}/reopen`], ['POST', `/api/threads/${forked.json.successor.id}/fork`]] as const) {
      const res = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${TEST_TOKENS.mcp}`, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'open', title: 'x' }) });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  });
  const owner = app.store.taskHistory(task.id).filter((e) => /^(thread|post)\./.test(e.kind) && e.kind !== 'post.added');
  assert.ok(owner.length >= 8);
  assert.ok(owner.every((e) => e.actor === 'human'), 'every owner control is recorded as the human');
});

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

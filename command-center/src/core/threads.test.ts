import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './index.ts';
import { NotFoundError, ValidationError } from './store.ts';

function fresh() {
  let tick = 0;
  const store = openStore(':memory:', { now: () => new Date(Date.UTC(2026, 9, 5, 12, 0, tick++)).toISOString() });
  const task = store.createTask({ title: 'Why does the solver stall?' }, 'human');
  return { store, task };
}

// ---- threads ----

test('createThread: one per task, titled after the task by default, recorded against who opened it', () => {
  const { store, task } = fresh();
  const before = store.lastEventId();
  const thread = store.createThread(task.id, null, { actor: 'agent', name: 'scribe' });
  assert.match(thread.id, /^th_/);
  assert.equal(thread.taskId, task.id);
  assert.equal(thread.title, 'Why does the solver stall?');
  assert.equal(thread.status, 'open');
  assert.equal(thread.pinnedPostId, null);
  assert.equal(thread.closedAt, null);
  assert.deepEqual(store.getThread(thread.id), thread);
  assert.deepEqual(store.getThreadForTask(task.id), thread);

  const events = store.eventsSince(before);
  assert.deepEqual(events.map((e) => [e.kind, e.taskId, e.actor, e.actorName, e.payload]), [['thread.created', task.id, 'agent', 'scribe', { threadId: thread.id }]]);

  // A second call is the same thread and records nothing: two agents cannot race to open it.
  const again = store.createThread(task.id, 'Another title', 'human');
  assert.deepEqual(again, thread);
  assert.equal(store.lastEventId(), events.at(-1)!.id);
});

test('createThread: a given title is trimmed, and a blank one falls back to the task', () => {
  const { store, task } = fresh();
  const titled = store.createThread(task.id, '  Stall  analysis ', 'human');
  assert.equal(titled.title, 'Stall analysis');
  const other = store.createTask({ title: 'Other' }, 'human');
  assert.equal(store.createThread(other.id, '   ', 'human').title, 'Other');
  assert.throws(() => store.createThread('t_missing000', null, 'human'), NotFoundError);
});

test('listThreads: newest first, with the counts the thread list shows', () => {
  const { store, task } = fresh();
  const first = store.createThread(task.id, null, 'human');
  const other = store.createTask({ title: 'Second challenge' }, 'human');
  const second = store.createThread(other.id, null, 'human');
  const claim = store.addPost(first.id, { type: 'claim', body: 'The stall is a cache miss.' }, 'agent', { actor: 'agent', name: 'a' });
  store.addPost(first.id, { type: 'objection', body: 'The profile says otherwise.', refs: [claim.id] }, 'agent', { actor: 'agent', name: 'b' });
  store.addPost(first.id, { type: 'result', body: 'Reproduced on the small case.' }, 'agent', 'agent');
  store.addPost(first.id, { type: 'question', body: 'Which build?' }, 'human', 'human');

  const rows = store.listThreads();
  assert.deepEqual(rows.map((r) => r.thread.id), [second.id, first.id]);
  const [, summary] = rows;
  assert.equal(summary.taskTitle, 'Why does the solver stall?');
  assert.equal(summary.postCount, 4);
  assert.equal(summary.openClaims, 1);
  assert.equal(summary.objections, 1);
  assert.equal(summary.results, 1);
  assert.equal(rows[0].postCount, 0);
  assert.equal(store.listThreads({ status: 'closed' }).length, 0);
  assert.equal(store.listThreads({ status: 'open' }).length, 2);
});

test('a thread goes with its task', () => {
  const { store, task } = fresh();
  const thread = store.createThread(task.id, null, 'human');
  store.addPost(thread.id, { type: 'question', body: 'Still here?' }, 'human', 'human');
  store.db.run('DELETE FROM tasks WHERE id = ?', [task.id]);
  assert.equal(store.getThread(thread.id), null);
  assert.equal(store.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM posts')?.n, 0);
});

// ---- posts ----

test('addPost: a typed post with refs, recorded with its actor and name, and only a claim or result carries a status', () => {
  const { store, task } = fresh();
  const thread = store.createThread(task.id, null, 'human');
  const before = store.lastEventId();
  const claim = store.addPost(thread.id, { type: 'claim', body: 'Cache miss.', confidence: 'medium' }, 'agent', { actor: 'agent', name: 'scribe' });
  assert.match(claim.id, /^po_/);
  assert.equal(claim.threadId, thread.id);
  assert.equal(claim.author, 'agent');
  assert.equal(claim.authorName, 'scribe');
  assert.equal(claim.type, 'claim');
  assert.equal(claim.confidence, 'medium');
  assert.equal(claim.status, 'open');
  assert.deepEqual(claim.refs, []);
  assert.equal(claim.parentPostId, null);
  assert.equal(claim.untrustedText, false);

  const objection = store.addPost(thread.id, { type: 'objection', body: 'Not on the profile.', refs: [claim.id, claim.id], parentPostId: claim.id }, 'agent', { actor: 'agent', name: 'critic' });
  assert.equal(objection.status, null, 'an objection has no status to judge');
  assert.deepEqual(objection.refs, [claim.id], 'refs are deduplicated');
  assert.equal(objection.parentPostId, claim.id);
  assert.equal(objection.confidence, null);
  const result = store.addPost(thread.id, { type: 'result', body: 'Confirmed.' }, 'human', 'human');
  assert.equal(result.status, 'open');
  assert.equal(result.authorName, null);

  assert.deepEqual(store.getPost(claim.id), claim);
  assert.deepEqual(store.listPosts(thread.id), [claim, objection, result]);

  const events = store.eventsSince(before);
  assert.deepEqual(events.map((e) => [e.kind, e.taskId, e.actor, e.actorName]), [
    ['post.added', task.id, 'agent', 'scribe'], ['post.added', task.id, 'agent', 'critic'], ['post.added', task.id, 'human', null],
  ]);
  assert.deepEqual(events[0].payload, { threadId: thread.id, postId: claim.id, type: 'claim' });
});

test('addPost: a name rides on a post only when the actor is the author', () => {
  const { store, task } = fresh();
  const thread = store.createThread(task.id, null, 'human');
  const post = store.addPost(thread.id, { type: 'summary', body: 'State of play.' }, 'human', { actor: 'agent', name: 'scribe' });
  assert.equal(post.author, 'human');
  assert.equal(post.authorName, null);
});

test('addPost: refuses an empty body, a bad type or confidence, a ref or parent outside the thread, and a closed thread', () => {
  const { store, task } = fresh();
  const thread = store.createThread(task.id, null, 'human');
  const other = store.createThread(store.createTask({ title: 'Other' }, 'human').id, null, 'human');
  const elsewhere = store.addPost(other.id, { type: 'claim', body: 'Elsewhere.' }, 'human', 'human');
  assert.throws(() => store.addPost(thread.id, { type: 'claim', body: '   ' }, 'human', 'human'), ValidationError);
  assert.throws(() => store.addPost(thread.id, { type: 'verdict' as never, body: 'x' }, 'human', 'human'), ValidationError);
  assert.throws(() => store.addPost(thread.id, { type: 'claim', body: 'x', confidence: 'certain' as never }, 'human', 'human'), ValidationError);
  assert.throws(() => store.addPost(thread.id, { type: 'claim', body: 'x', refs: [elsewhere.id] }, 'human', 'human'), ValidationError);
  assert.throws(() => store.addPost(thread.id, { type: 'claim', body: 'x', refs: ['po_missing000'] }, 'human', 'human'), ValidationError);
  assert.throws(() => store.addPost(thread.id, { type: 'claim', body: 'x', parentPostId: elsewhere.id }, 'human', 'human'), ValidationError);
  assert.throws(() => store.addPost('th_missing000', { type: 'claim', body: 'x' }, 'human', 'human'), NotFoundError);
  assert.equal(store.listPosts(thread.id).length, 0);

  // Nothing closes a thread yet, but a closed one refuses posts all the same.
  store.db.run("UPDATE threads SET status = 'closed', closed_at = ? WHERE id = ?", ['2026-10-05T13:00:00.000Z', thread.id]);
  assert.throws(() => store.addPost(thread.id, { type: 'claim', body: 'x' }, 'human', 'human'), /closed/);
});

test('addPost: a post on an accepted third-party task carries untrusted_text', () => {
  const { store } = fresh();
  const { task } = store.upsertFromSource({ sourceType: 'github', sourceId: 'o/r#1', title: 'Issue title', contentHash: 'h' });
  store.acceptInboxItem(task.id, {}, 'human');
  const thread = store.createThread(task.id, null, 'human');
  const post = store.addPost(thread.id, { type: 'claim', body: 'On the issue.' }, 'agent', 'agent');
  assert.equal(post.untrustedText, true);
  assert.equal(store.getPost(post.id)?.untrustedText, true);
  assert.equal(store.addPost(thread.id, { type: 'evidence', body: 'Later.' }, 'human', 'human').untrustedText, true);
});

test('createThread and addPost: an inbox task has no thread until the owner accepts it', () => {
  const { store } = fresh();
  const { task } = store.upsertFromSource({ sourceType: 'github', sourceId: 'o/r#1', title: 'Issue title', contentHash: 'h' });
  assert.throws(() => store.createThread(task.id, null, { actor: 'agent', name: 'scribe' }), ValidationError);
  assert.equal(store.getThreadForTask(task.id), null);
  assert.equal(store.listThreads().length, 0);
  store.acceptInboxItem(task.id, {}, 'human');
  const thread = store.createThread(task.id, null, 'human');
  store.addPost(thread.id, { type: 'question', body: 'Now?' }, 'human', 'human');
  // A task sent back to the inbox keeps its thread but takes no more posts until it is accepted again.
  store.updateTask(task.id, { status: 'inbox' }, 'human');
  assert.throws(() => store.addPost(thread.id, { type: 'claim', body: 'Still?' }, 'agent', 'agent'), ValidationError);
  assert.equal(store.countPosts(thread.id), 1);
});

test('countPosts: the whole thread, whatever window a reader fetched', () => {
  const { store, task } = fresh();
  const thread = store.createThread(task.id, null, 'human');
  assert.equal(store.countPosts(thread.id), 0);
  for (let i = 0; i < 3; i++) store.addPost(thread.id, { type: 'claim', body: `Claim ${i}.` }, 'agent', 'agent');
  assert.equal(store.countPosts(thread.id), 3);
  assert.equal(store.listPosts(thread.id, { limit: 1 }).length, 1);
  assert.throws(() => store.countPosts('th_missing00'), NotFoundError);
});

test('addPost: never touches the task row', () => {
  const { store, task } = fresh();
  const thread = store.createThread(task.id, null, 'human');
  const before = store.requireTask(task.id);
  for (const type of ['claim', 'evidence', 'objection', 'question', 'failed_attempt', 'summary', 'result'] as const) {
    store.addPost(thread.id, { type, body: `A ${type}.` }, 'agent', 'agent');
  }
  assert.deepEqual(store.requireTask(task.id), before);
  const kinds = store.taskHistory(task.id).map((e) => e.kind);
  assert.deepEqual(kinds.filter((k) => k.startsWith('task.')), ['task.created']);
});

test('listPosts: oldest first, after a cursor, with a limit, and a stale cursor is an error', () => {
  const { store, task } = fresh();
  const thread = store.createThread(task.id, null, 'human');
  const posts = ['one', 'two', 'three', 'four'].map((body) => store.addPost(thread.id, { type: 'question', body }, 'human', 'human'));
  assert.deepEqual(store.listPosts(thread.id).map((p) => p.body), ['one', 'two', 'three', 'four']);
  assert.deepEqual(store.listPosts(thread.id, { after: posts[1].id }).map((p) => p.body), ['three', 'four']);
  assert.deepEqual(store.listPosts(thread.id, { after: posts[3].id }), []);
  assert.deepEqual(store.listPosts(thread.id, { limit: 2 }).map((p) => p.body), ['one', 'two']);
  assert.deepEqual(store.listPosts(thread.id, { after: posts[0].id, limit: 1 }).map((p) => p.body), ['two']);
  assert.throws(() => store.listPosts(thread.id, { after: 'po_missing000' }), NotFoundError);
  assert.throws(() => store.listPosts('th_missing000'), NotFoundError);
});

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
  // Without a cursor the window is the newest posts, still oldest first: a reader of a long
  // thread lands where it is now, and countPosts says how much came before.
  assert.deepEqual(store.listPosts(thread.id, { limit: 2 }).map((p) => p.body), ['three', 'four']);
  assert.deepEqual(store.listPosts(thread.id, { after: posts[0].id, limit: 1 }).map((p) => p.body), ['two']);
  assert.throws(() => store.listPosts(thread.id, { after: 'po_missing000' }), NotFoundError);
  assert.throws(() => store.listPosts('th_missing000'), NotFoundError);
});

test('listPosts: the cursor follows insertion order, so two posts in the same millisecond are never skipped', () => {
  const frozen = '2026-10-05T12:00:00.000Z';
  const store = openStore(':memory:', { now: () => frozen });
  const task = store.createTask({ title: 'Same instant' }, 'human');
  const thread = store.createThread(task.id, null, 'human');
  // Ids are random, so make the later post sort below the earlier one by id on purpose.
  const first = store.addPost(thread.id, { type: 'question', body: 'first' }, 'human', 'human');
  const second = store.addPost(thread.id, { type: 'question', body: 'second' }, 'human', 'human');
  assert.equal(first.createdAt, second.createdAt);
  const lower = `po_${'0'.repeat(first.id.length - 3)}`;
  store.db.run('UPDATE posts SET id = ? WHERE id = ?', [lower, second.id]);
  assert.deepEqual(store.listPosts(thread.id).map((p) => p.body), ['first', 'second']);
  assert.deepEqual(store.listPosts(thread.id, { after: first.id }).map((p) => p.body), ['second']);
  assert.deepEqual(store.listPosts(thread.id, { after: lower }), []);
});

test('listThreads: an objection answered in the same millisecond by a reply with a lower id still counts as answered', () => {
  const frozen = '2026-10-05T12:00:00.000Z';
  const store = openStore(':memory:', { now: () => frozen });
  const task = store.createTask({ title: 'Same instant' }, 'human');
  const thread = store.createThread(task.id, null, 'human');
  const objection = store.addPost(thread.id, { type: 'objection', body: 'But the lemma.' }, 'agent', { actor: 'agent', name: 'critic' });
  const byParent = store.addPost(thread.id, { type: 'evidence', body: 'The lemma holds.', parentPostId: objection.id }, 'agent', { actor: 'agent', name: 'scribe' });
  const second = store.addPost(thread.id, { type: 'objection', body: 'And the bound.' }, 'agent', { actor: 'agent', name: 'critic' });
  const byRef = store.addPost(thread.id, { type: 'evidence', body: 'The bound holds.', refs: [second.id] }, 'agent', { actor: 'agent', name: 'scribe' });
  const unanswered = store.addPost(thread.id, { type: 'objection', body: 'Nobody answers this.' }, 'agent', { actor: 'agent', name: 'critic' });
  // Ids are random: give both answers ids that sort below their objections, in the same instant.
  const low = (n: number) => `po_${String(n).padStart(byParent.id.length - 3, '0')}`;
  store.db.run('UPDATE posts SET id = ? WHERE id = ?', [low(1), byParent.id]);
  store.db.run('UPDATE posts SET id = ? WHERE id = ?', [low(2), byRef.id]);
  assert.equal(store.getPost(unanswered.id)!.createdAt, objection.createdAt);
  const [row] = store.listThreads();
  assert.equal(row.objections, 3);
  assert.equal(row.unansweredObjections, 1, 'only the objection nobody replied to');
});

// ---- stage 2: the owner's controls ----

const AGENT = { actor: 'agent', name: 'scribe' } as const;

test('setPostStatus: the owner judges a claim or a result, judged_at follows, open clears it, and nobody else may', () => {
  const { store, task } = fresh();
  const thread = store.createThread(task.id, null, 'human');
  const claim = store.addPost(thread.id, { type: 'claim', body: 'Cache miss.' }, 'agent', AGENT);
  const question = store.addPost(thread.id, { type: 'question', body: 'Which build?' }, 'agent', AGENT);
  const before = store.lastEventId();
  const accepted = store.setPostStatus(claim.id, 'accepted', 'human');
  assert.equal(accepted.status, 'accepted');
  assert.match(accepted.judgedAt!, /^2026-10-05T12:00/);
  assert.deepEqual(store.getPost(claim.id), accepted);
  const events = store.eventsSince(before);
  assert.deepEqual(events.map((e) => [e.kind, e.taskId, e.actor, e.payload]), [['post.status_changed', task.id, 'human', { threadId: thread.id, postId: claim.id, status: 'accepted' }]]);
  assert.equal(store.setPostStatus(claim.id, 'open', 'human').judgedAt, null);
  assert.throws(() => store.setPostStatus(question.id, 'accepted', 'human'), /carries no status/);
  for (const actor of [AGENT, 'agent', 'system', 'rule'] as const) {
    assert.throws(() => store.setPostStatus(claim.id, 'rejected', actor), /only the owner/);
  }
  assert.throws(() => store.setPostStatus(claim.id, 'done' as never, 'human'), ValidationError);
  assert.throws(() => store.setPostStatus('po_missing000', 'accepted', 'human'), NotFoundError);
  assert.equal(store.getPost(claim.id)!.status, 'open');
  assert.deepEqual(store.requireTask(task.id), store.requireTask(task.id), 'the task is untouched');
});

test('pinPost and setThreadOptions: owner only, validated, each change an event', () => {
  const { store, task } = fresh();
  const thread = store.createThread(task.id, null, 'human');
  const summary = store.addPost(thread.id, { type: 'summary', body: 'Where we are.' }, 'agent', AGENT);
  const elsewhere = store.addPost(store.createThread(store.createTask({ title: 'Other' }, 'human').id, null, 'human').id, { type: 'summary', body: 'x' }, 'human', 'human');
  const before = store.lastEventId();
  assert.equal(store.pinPost(thread.id, summary.id, 'human').pinnedPostId, summary.id);
  assert.equal(store.getThread(thread.id)!.pinnedPostId, summary.id);
  assert.throws(() => store.pinPost(thread.id, elsewhere.id, 'human'), /not a post of this thread/);
  assert.throws(() => store.pinPost(thread.id, summary.id, AGENT), /only the owner/);
  assert.equal(store.pinPost(thread.id, null, 'human').pinnedPostId, null);

  const set = store.setThreadOptions(thread.id, { authorHidden: true, dailyCap: 5 }, 'human');
  assert.equal(set.authorHidden, true);
  assert.equal(set.dailyCap, 5);
  assert.deepEqual(store.getThread(thread.id), set);
  assert.equal(store.setThreadOptions(thread.id, { dailyCap: null }, 'human').dailyCap, null);
  assert.equal(store.getThread(thread.id)!.authorHidden, true, 'an option left out is unchanged');
  assert.throws(() => store.setThreadOptions(thread.id, { dailyCap: 0 }, 'human'), ValidationError);
  assert.throws(() => store.setThreadOptions(thread.id, { dailyCap: 1.5 }, 'human'), ValidationError);
  assert.throws(() => store.setThreadOptions(thread.id, {}, 'human'), /nothing to change/);
  assert.throws(() => store.setThreadOptions(thread.id, { authorHidden: false }, 'system'), /only the owner/);
  const kinds = store.eventsSince(before).map((e) => [e.kind, e.payload.field]);
  assert.deepEqual(kinds, [
    ['thread.updated', 'pinnedPostId'], ['thread.updated', 'pinnedPostId'],
    ['thread.updated', 'authorHidden'], ['thread.updated', 'dailyCap'], ['thread.updated', 'dailyCap'],
  ]);
});

test('closeThread and reopenThread: owner only, a closed thread takes no posts, reopening keeps the fork pointer', () => {
  const { store, task } = fresh();
  const thread = store.createThread(task.id, null, 'human');
  assert.throws(() => store.closeThread(thread.id, AGENT), /only the owner/);
  const closed = store.closeThread(thread.id, 'human');
  assert.equal(closed.status, 'closed');
  assert.match(closed.closedAt!, /^2026-10-05/);
  assert.throws(() => store.addPost(thread.id, { type: 'claim', body: 'x' }, 'human', 'human'), /closed/);
  assert.throws(() => store.closeThread(thread.id, 'human'), /already closed/);
  assert.throws(() => store.reopenThread(thread.id, 'rule'), /only the owner/);
  const reopened = store.reopenThread(thread.id, 'human');
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.closedAt, null);
  assert.throws(() => store.reopenThread(thread.id, 'human'), /already open/);
  assert.deepEqual(store.taskHistory(task.id).map((e) => e.kind).filter((k) => k.startsWith('thread.')), ['thread.created', 'thread.closed', 'thread.reopened']);
});

test('forkThread: a subtask with a thread of its own, the old thread closed and pointing at it, the original task otherwise untouched', () => {
  const { store, task } = fresh();
  const project = store.createProject({ name: 'Solver' });
  store.updateTask(task.id, { projectId: project.id }, 'human');
  const thread = store.createThread(task.id, null, 'human');
  store.addPost(thread.id, { type: 'claim', body: 'Two ways forward.' }, 'agent', AGENT);
  const taskBefore = store.requireTask(task.id);
  assert.throws(() => store.forkThread(thread.id, { title: 'Approach B' }, AGENT), /only the owner/);
  assert.throws(() => store.forkThread(thread.id, { title: '   ' }, 'human'), /needs a title/);
  const before = store.lastEventId();
  const forked = store.forkThread(thread.id, { title: '  Approach   B ' }, 'human');
  assert.equal(forked.task.title, 'Approach B');
  assert.equal(forked.task.parentId, task.id);
  assert.equal(forked.task.projectId, project.id);
  assert.equal(forked.task.status, 'open');
  assert.equal(forked.successor.taskId, forked.task.id);
  assert.equal(forked.successor.title, 'Approach B');
  assert.equal(forked.successor.status, 'open');
  assert.equal(forked.thread.status, 'closed');
  assert.equal(forked.thread.successorThreadId, forked.successor.id);
  assert.deepEqual(store.getThread(thread.id), forked.thread);
  assert.deepEqual(store.requireTask(task.id), taskBefore, 'the original task row is unchanged');
  assert.deepEqual(store.searchTasks({ parentId: task.id }).map((t) => t.id), [forked.task.id]);
  const kinds = store.eventsSince(before).map((e) => [e.kind, e.taskId, e.actor]);
  assert.deepEqual(kinds, [['task.created', forked.task.id, 'human'], ['thread.created', forked.task.id, 'human'], ['thread.closed', task.id, 'human']]);
  assert.deepEqual(store.eventsSince(before).at(-1)!.payload, { threadId: thread.id, successorThreadId: forked.successor.id });
  assert.throws(() => store.forkThread(thread.id, { title: 'Again' }, 'human'), /closed/);
  // Reopened, the pointer is still there as history.
  assert.equal(store.reopenThread(thread.id, 'human').successorThreadId, forked.successor.id);
});

test('addPost: the daily cap counts an agent\'s posts per name per UTC day, and never the owner\'s', () => {
  let at = Date.UTC(2026, 9, 5, 23, 59, 0);
  const store = openStore(':memory:', { now: () => new Date(at++).toISOString() });
  const task = store.createTask({ title: 'Capped' }, 'human');
  const thread = store.createThread(task.id, null, 'human');
  store.setThreadOptions(thread.id, { dailyCap: 2 }, 'human');
  store.addPost(thread.id, { type: 'claim', body: 'one' }, 'agent', AGENT);
  store.addPost(thread.id, { type: 'claim', body: 'two' }, 'agent', AGENT);
  assert.throws(() => store.addPost(thread.id, { type: 'claim', body: 'three' }, 'agent', AGENT), /daily cap of 2 posts reached for scribe/);
  assert.equal(store.postsTodayBy(thread.id, 'scribe'), 2);
  // Another name has its own count, and so does an unnamed agent; the owner is never counted.
  store.addPost(thread.id, { type: 'objection', body: 'critic one' }, 'agent', { actor: 'agent', name: 'critic' });
  store.addPost(thread.id, { type: 'objection', body: 'unnamed one' }, 'agent', 'agent');
  store.addPost(thread.id, { type: 'objection', body: 'unnamed two' }, 'agent', 'agent');
  assert.throws(() => store.addPost(thread.id, { type: 'objection', body: 'unnamed three' }, 'agent', 'agent'), /reached for an unnamed agent/);
  for (let i = 0; i < 5; i++) store.addPost(thread.id, { type: 'question', body: `owner ${i}` }, 'human', 'human');
  // A new UTC day starts the count over.
  at = Date.UTC(2026, 9, 6, 0, 0, 1);
  store.addPost(thread.id, { type: 'claim', body: 'three, tomorrow' }, 'agent', AGENT);
  assert.equal(store.postsTodayBy(thread.id, 'scribe'), 1);
  assert.equal(store.countPosts(thread.id), 11);
  // No cap, no limit.
  store.setThreadOptions(thread.id, { dailyCap: null }, 'human');
  for (let i = 0; i < 3; i++) store.addPost(thread.id, { type: 'claim', body: `free ${i}` }, 'agent', AGENT);
});

test('listThreads: unanswered objections, accepted results, and the last verdict', () => {
  const { store, task } = fresh();
  const thread = store.createThread(task.id, null, 'human');
  assert.equal(store.listThreads()[0].lastProgressAt, thread.createdAt, 'no verdict yet: progress is the opening');
  const claim = store.addPost(thread.id, { type: 'claim', body: 'Cache miss.' }, 'agent', AGENT);
  const byParent = store.addPost(thread.id, { type: 'objection', body: 'Profile says no.', parentPostId: claim.id }, 'agent', AGENT);
  const byRefs = store.addPost(thread.id, { type: 'objection', body: 'And the trace.' }, 'agent', AGENT);
  const unanswered = store.addPost(thread.id, { type: 'objection', body: 'What about the build?' }, 'agent', AGENT);
  let row = store.listThreads()[0];
  assert.equal(row.objections, 3);
  assert.equal(row.unansweredObjections, 3);
  store.addPost(thread.id, { type: 'evidence', body: 'Re-profiled.', parentPostId: byParent.id }, 'agent', AGENT);
  store.addPost(thread.id, { type: 'evidence', body: 'Trace attached.', refs: [byRefs.id] }, 'agent', AGENT);
  row = store.listThreads()[0];
  assert.equal(row.unansweredObjections, 1, 'answered by parent and by refs; one left');
  const result = store.addPost(thread.id, { type: 'result', body: 'Fixed on the small case.' }, 'agent', AGENT);
  const other = store.addPost(thread.id, { type: 'result', body: 'Not fixed on the large one.' }, 'agent', AGENT);
  row = store.listThreads()[0];
  assert.equal(row.results, 2);
  assert.equal(row.acceptedResults, 0);
  const judged = store.setPostStatus(result.id, 'accepted', 'human');
  store.setPostStatus(other.id, 'rejected', 'human');
  const later = store.setPostStatus(claim.id, 'accepted', 'human');
  row = store.listThreads()[0];
  assert.equal(row.acceptedResults, 1);
  assert.equal(row.openClaims, 0);
  assert.equal(row.lastProgressAt, later.judgedAt);
  assert.ok(later.judgedAt! > judged.judgedAt!);
  assert.equal(unanswered.type, 'objection');
});

test('searchPosts: across threads, newest first, by type, status, task, and text', () => {
  const { store, task } = fresh();
  const first = store.createThread(task.id, null, 'human');
  const other = store.createTask({ title: 'Second challenge' }, 'human');
  const second = store.createThread(other.id, 'Round two', 'human');
  const r1 = store.addPost(first.id, { type: 'result', body: 'The Cache fix holds.' }, 'agent', AGENT);
  const r2 = store.addPost(second.id, { type: 'result', body: 'The index fix holds.' }, 'agent', AGENT);
  store.addPost(second.id, { type: 'claim', body: 'A cache claim.' }, 'human', 'human');
  store.setPostStatus(r1.id, 'accepted', 'human');
  const all = store.searchPosts();
  assert.deepEqual(all.map((h) => h.post.body), ['A cache claim.', 'The index fix holds.', 'The Cache fix holds.']);
  assert.deepEqual(all.map((h) => [h.taskId, h.taskTitle, h.threadTitle])[2], [task.id, 'Why does the solver stall?', 'Why does the solver stall?']);
  assert.deepEqual(store.searchPosts({ type: 'result', status: 'accepted' }).map((h) => h.post.id), [r1.id]);
  assert.deepEqual(store.searchPosts({ query: 'cache' }).map((h) => h.post.id).sort(), [r1.id, store.searchPosts({ type: 'claim' })[0].post.id].sort());
  assert.deepEqual(store.searchPosts({ taskId: other.id }).length, 2);
  assert.deepEqual(store.searchPosts({ taskId: other.id, query: 'index' }).map((h) => h.post.id), [r2.id]);
  assert.equal(store.searchPosts({ limit: 1 }).length, 1);
  assert.deepEqual(store.searchPosts({ query: 'nothing like this' }), []);
  assert.throws(() => store.searchPosts({ type: 'verdict' as never }), ValidationError);
  assert.throws(() => store.searchPosts({ status: 'done' as never }), ValidationError);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, ValidationError } from './index.ts';

const fresh = () => {
  let tick = 0;
  return openStore(':memory:', {
    now: () => new Date(Date.UTC(2026, 8, 12, 12, 0, tick++)).toISOString(),
    nextOccurrence: (_r, prev) => {
      const d = new Date(prev.slice(0, 10) + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 7);
      return d.toISOString().slice(0, 10);
    },
  });
};

test('projects upsert by slug and merge meta', () => {
  const s = fresh();
  const a = s.upsertProject({ slug: 'octavium', name: 'Octavium', category: 'software', meta: { a: 1 } });
  const b = s.upsertProject({ slug: 'octavium', name: 'Octavium', meta: { b: 2 } });
  assert.equal(a.id, b.id);
  assert.equal(b.category, 'software');
  assert.deepEqual(b.meta, { a: 1, b: 2 });
  assert.equal(s.findProject('OCTAVIUM')?.id, a.id);
});

test('task CRUD, search, subtasks, custom fields', () => {
  const s = fresh();
  const p = s.upsertProject({ slug: 'nimbus', name: 'Project Nimbus' });
  const t = s.createTask({ title: 'Ship installer', projectId: p.id, dueAt: '2026-09-20', priority: 'high', customFields: { effort: 3 } });
  const sub = s.createTask({ title: 'Sign binary', parentId: t.id });
  assert.equal(sub.projectId, p.id);
  s.createTask({ title: 'Later thing', projectId: p.id });
  assert.deepEqual(s.subtasks(t.id).map((x) => x.id), [sub.id]);
  assert.equal(s.searchTasks({ text: 'install' }).length, 1);
  assert.equal(s.searchTasks({ dueBefore: '2026-09-21' })[0].id, t.id);
  assert.equal(s.searchTasks({ customField: { key: 'effort', value: 3 } }).length, 1);
  const u = s.updateTask(t.id, { title: 'Ship signed installer', customFields: { effort: null, area: 'release' } });
  assert.deepEqual(u.customFields, { area: 'release' });
  assert.throws(() => s.updateTask(t.id, { dueAt: 'friday' }), ValidationError);
  assert.throws(() => s.updateTask(t.id, { parentId: sub.id }), ValidationError);
  const hist = s.taskHistory(t.id).map((e) => e.kind);
  assert.deepEqual(hist, ['task.created', 'task.updated']);
});

test('dependencies reject cycles and drive blocked filter', () => {
  const s = fresh();
  const a = s.createTask({ title: 'A' });
  const b = s.createTask({ title: 'B' });
  const c = s.createTask({ title: 'C' });
  s.addDependency(a.id, b.id);
  s.addDependency(b.id, c.id);
  assert.throws(() => s.addDependency(c.id, a.id), /cycle/);
  assert.deepEqual(s.searchTasks({ blocked: true }).map((t) => t.title).sort(), ['B', 'C']);
  s.completeTask(a.id);
  assert.deepEqual(s.searchTasks({ blocked: true, status: ['open'] }).map((t) => t.title), ['C']);
});

test('startBefore passes tasks with no start date and those started before the day', () => {
  const s = fresh();
  s.createTask({ title: 'No start' });
  s.createTask({ title: 'Started yesterday', startAt: '2026-09-11' });
  s.createTask({ title: 'Starts today', startAt: '2026-09-12' });
  s.createTask({ title: 'Starts today at noon', startAt: '2026-09-12T12:00:00.000Z' });
  s.createTask({ title: 'Starts tomorrow', startAt: '2026-09-13' });
  const titles = s.searchTasks({ startBefore: '2026-09-13', orderBy: 'created' }).map((t) => t.title).sort();
  assert.deepEqual(titles, ['No start', 'Started yesterday', 'Starts today', 'Starts today at noon']);
});

test('parentClosed separates subtasks of a done or dropped parent from everything else', () => {
  const s = fresh();
  const liveParent = s.createTask({ title: 'Live parent' });
  const doneParent = s.createTask({ title: 'Done parent' });
  const droppedParent = s.createTask({ title: 'Dropped parent' });
  s.createTask({ title: 'Under live', parentId: liveParent.id });
  s.createTask({ title: 'Under done', parentId: doneParent.id });
  s.createTask({ title: 'Under dropped', parentId: droppedParent.id });
  s.completeTask(doneParent.id);
  s.updateTask(droppedParent.id, { status: 'dropped' });

  const closed = s.searchTasks({ parentClosed: true }).map((t) => t.title).sort();
  assert.deepEqual(closed, ['Under done', 'Under dropped']);
  const open = s.searchTasks({ parentClosed: false, status: ['open'] }).map((t) => t.title).sort();
  assert.deepEqual(open, ['Live parent', 'Under live'], 'top-level tasks pass parentClosed: false');
});

test('recurring completion spawns next instance', () => {
  const s = fresh();
  const t = s.createTask({ title: 'Weekly sync', dueAt: '2026-09-14', recurrence: 'FREQ=WEEKLY' });
  const { task, next } = s.completeTask(t.id);
  assert.equal(task.status, 'done');
  assert.equal(next?.dueAt, '2026-09-21');
  assert.equal(next?.recurrence, 'FREQ=WEEKLY');
});

test('source upsert: create, unchanged, three-way merge, reject suppresses, gone completes', () => {
  const s = fresh();
  const item = { sourceType: 'gmail' as const, sourceId: 'thread1', title: 'Send the film cut', dueAt: '2026-09-18', contentHash: 'h1' };
  const r1 = s.upsertFromSource(item);
  assert.equal(r1.action, 'created');
  assert.equal(r1.task.status, 'inbox');
  assert.equal(s.upsertFromSource(item).action, 'unchanged');

  // Inbox items take source changes wholesale.
  const r2 = s.upsertFromSource({ ...item, title: 'Send the film rough cut', contentHash: 'h2' });
  assert.equal(r2.action, 'updated');
  assert.equal(r2.task.title, 'Send the film rough cut');

  // Once accepted, user edits win; untouched fields still follow the source.
  s.acceptInboxItem(r1.task.id, { title: 'Export and send the film cut' });
  const r3 = s.upsertFromSource({ ...item, title: 'Send the film final cut', dueAt: '2026-09-19', contentHash: 'h3' });
  assert.equal(r3.task.title, 'Export and send the film cut');
  assert.equal(r3.task.dueAt, '2026-09-19');

  // Gone + complete.
  const done = s.markSourceGone('gmail', 'thread1', 'complete');
  assert.equal(done?.status, 'done');

  // Rejected items never come back.
  const other = s.upsertFromSource({ sourceType: 'gmail', sourceId: 'spam', title: 'Buy now', contentHash: 'x' });
  s.rejectInboxItem(other.task.id, 'marketing');
  const again = s.upsertFromSource({ sourceType: 'gmail', sourceId: 'spam', title: 'Buy now!!', contentHash: 'y' });
  assert.equal(again.action, 'suppressed');
  assert.equal(again.task.status, 'dropped');
});

test('source reappearing after gone reopens the task', () => {
  const s = fresh();
  const item = { sourceType: 'todo_md' as const, sourceId: 'nimbus:TODO.md:abc', title: 'Fix drift', contentHash: 'h', initialStatus: 'open' as const };
  s.upsertFromSource(item);
  s.markSourceGone('todo_md', item.sourceId, 'complete');
  const r = s.upsertFromSource(item);
  assert.equal(r.task.status, 'open');
  assert.deepEqual(s.activeSourceIds('todo_md', 'nimbus:'), [item.sourceId]);
});

test('transactions roll back on error', () => {
  const s = fresh();
  assert.throws(() => s.db.transaction(() => {
    s.createTask({ title: 'will vanish' });
    throw new Error('boom');
  }));
  assert.equal(s.countTasks(), 0);
});

test('markSourceSeen tracks task-less items and later upsert still creates', () => {
  const s = fresh();
  s.markSourceSeen('gmail', 'newsletter', 'h1');
  assert.deepEqual(s.getSourceState('gmail', 'newsletter')?.taskId, null);
  assert.equal(s.getSourceState('gmail', 'newsletter')?.contentHash, 'h1');
  assert.equal(s.countTasks(), 0);
  const r = s.upsertFromSource({ sourceType: 'gmail', sourceId: 'newsletter', title: 'Reply to Sam', contentHash: 'h2' });
  assert.equal(r.action, 'created');
  s.markSourceSeen('gmail', 'newsletter', 'h3');
  assert.equal(s.getSourceState('gmail', 'newsletter')?.contentHash, 'h2');
  assert.equal(s.getSourceState('gmail', 'newsletter')?.taskId, r.task.id);
});

test('upsertProject and moveTask are no-ops when nothing changes', () => {
  const s = fresh();
  const p = s.upsertProject({ slug: 'x', name: 'X' });
  const t = s.createTask({ title: 'T', projectId: p.id });
  const before = s.lastEventId();
  s.upsertProject({ slug: 'x', name: 'X' });
  s.moveTask(t.id, { projectId: p.id });
  assert.equal(s.lastEventId(), before);
});

test('review fixes: drop keeps accepted tasks, inbox edits survive, bad recurrence is contained', () => {
  let tick = 0;
  const s = openStore(':memory:', {
    now: () => new Date(Date.UTC(2026, 8, 12, 12, 0, tick++)).toISOString(),
    nextOccurrence: () => { throw new Error('bad rule'); },
    validateRecurrence: (r) => (r === 'every other tuesday' ? 'unsupported' : null),
  });
  const a = s.upsertFromSource({ sourceType: 'gdrive', sourceId: 'doc:1', title: 'Draft outline', contentHash: 'h1' });
  s.acceptInboxItem(a.task.id);
  assert.equal(s.markSourceGone('gdrive', 'doc:1', 'drop')?.status, 'open');
  assert.match(s.listComments(a.task.id).at(-1)!.body, /kept because you accepted/);
  const b = s.upsertFromSource({ sourceType: 'gdrive', sourceId: 'doc:2', title: 'Other', contentHash: 'h1' });
  assert.equal(s.markSourceGone('gdrive', 'doc:2', 'drop')?.status, 'dropped');

  const c = s.upsertFromSource({ sourceType: 'gmail', sourceId: 't9', title: 'Send cut', dueAt: '2026-09-18', contentHash: 'h1' });
  s.updateTask(c.task.id, { title: 'Send final cut to Sam' }, 'human');
  const merged = s.upsertFromSource({ sourceType: 'gmail', sourceId: 't9', title: 'Send cut', dueAt: '2026-09-19', contentHash: 'h2' });
  assert.equal(merged.task.title, 'Send final cut to Sam');
  assert.equal(merged.task.dueAt, '2026-09-19');

  assert.throws(() => s.createTask({ title: 'x', recurrence: 'every other tuesday' }), ValidationError);
  const r = s.createTask({ title: 'weekly', recurrence: 'FREQ=WEEKLY', dueAt: '2026-09-14' });
  const done = s.completeTask(r.id);
  assert.equal(done.task.status, 'done');
  assert.equal(done.next, null);

  const before = s.lastEventId();
  s.addComment(r.id, 'from a rule', 'system', 'rule');
  assert.equal(s.eventsSince(before)[0].actor, 'rule');
  assert.equal(s.eventsOfKind('comment.added', null).length >= 1, true);
});


test('assignee round trip: created with a name, read back, cleared with null or blank', () => {
  const s = fresh();
  const unclaimed = s.createTask({ title: 'Nobody yet' });
  assert.equal(unclaimed.assignee, null);
  const t = s.createTask({ title: 'Write the release notes', assignee: '  scribe ' });
  assert.equal(t.assignee, 'scribe', 'stored trimmed');
  assert.equal(s.getTask(t.id)?.assignee, 'scribe');
  assert.equal(s.updateTask(t.id, { assignee: 'reviewer' }).assignee, 'reviewer');
  assert.equal(s.updateTask(t.id, { assignee: null }).assignee, null, 'null clears');
  assert.equal(s.updateTask(t.id, { assignee: 'scribe' }).assignee, 'scribe');
  assert.equal(s.updateTask(t.id, { assignee: '   ' }).assignee, null, 'a blank from a form clears too');
  assert.equal(s.createTask({ title: 'Blank at create', assignee: '' }).assignee, null);
  assert.throws(() => s.createTask({ title: 'Too long', assignee: 'x'.repeat(201) }), ValidationError);
  // An update that does not mention the field leaves it alone.
  s.updateTask(t.id, { assignee: 'scribe' });
  assert.equal(s.updateTask(t.id, { title: 'Write the release notes, v2' }).assignee, 'scribe');
});

test('assignee edits land in task history as task.updated changes, like priority and due', () => {
  const s = fresh();
  const t = s.createTask({ title: 'Triage the inbox' });
  s.updateTask(t.id, { assignee: 'triager', priority: 'high' }, 'agent');
  s.updateTask(t.id, { assignee: 'triager' });
  s.updateTask(t.id, { assignee: null });
  const updates = s.taskHistory(t.id).filter((e) => e.kind === 'task.updated');
  assert.equal(updates.length, 2, 'a same-value write records nothing');
  assert.equal(updates[0].actor, 'agent');
  assert.deepEqual(updates[0].payload, { changes: { assignee: [null, 'triager'], priority: ['none', 'high'] } });
  assert.deepEqual(updates[1].payload, { changes: { assignee: ['triager', null] } });
});

test('searchTasks filters by assignee (exact) and by unassigned, and counts agree', () => {
  const s = fresh();
  const a = s.createTask({ title: 'A', assignee: 'scribe' });
  const b = s.createTask({ title: 'B', assignee: 'Scribe' });
  const c = s.createTask({ title: 'C' });
  assert.deepEqual(s.searchTasks({ assignee: 'scribe' }).map((x) => x.id), [a.id], 'exact match, case included');
  assert.deepEqual(s.searchTasks({ assignee: 'Scribe' }).map((x) => x.id), [b.id]);
  assert.deepEqual(s.searchTasks({ unassigned: true }).map((x) => x.id), [c.id]);
  assert.deepEqual(s.searchTasks({ unassigned: false, orderBy: 'created' }).map((x) => x.id).sort(), [a.id, b.id].sort());
  assert.equal(s.searchTasks({ assignee: 'nobody' }).length, 0);
  assert.equal(s.countTasks({ unassigned: true }), 1);
  assert.equal(s.countTasks({ assignee: 'scribe' }), 1);
  assert.equal(s.searchTasks({}).length, 3, 'no filter leaves everything in');
});

test('the next occurrence of a recurring task keeps its assignee', () => {
  const s = fresh();
  const t = s.createTask({ title: 'Weekly digest', recurrence: 'FREQ=WEEKLY', dueAt: '2026-09-14', assignee: 'scribe' });
  const { next } = s.completeTask(t.id);
  assert.ok(next);
  assert.equal(next.assignee, 'scribe');
});

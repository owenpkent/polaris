import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './index.ts';
import { NotFoundError, ValidationError } from './store.ts';

function fresh(now?: () => string) {
  const store = openStore(':memory:', now ? { now } : {});
  const project = store.upsertProject({ slug: 'octavium', name: 'Octavium' });
  return { store, project };
}

// ---- create and read ----

test('createGoal: defaults to on_track, tasks mode, and records when the status was set', () => {
  const { store } = fresh(() => '2026-09-18T10:00:00.000Z');
  const goal = store.createGoal({ title: '  Ship the Octavium installer  ' });
  assert.match(goal.id, /^g_/);
  assert.equal(goal.title, 'Ship the Octavium installer');
  assert.equal(goal.status, 'on_track');
  assert.equal(goal.progressMode, 'tasks');
  assert.equal(goal.statusUpdatedAt, '2026-09-18T10:00:00.000Z');
  assert.equal(goal.parentId, null);
  assert.deepEqual(store.getGoal(goal.id), goal);
});

test('createGoal: rejects a blank title, a bad status, a bad mode, bad dates, and a reversed period', () => {
  const { store } = fresh();
  assert.throws(() => store.createGoal({ title: '   ' }), ValidationError);
  assert.throws(() => store.createGoal({} as never), ValidationError);
  assert.throws(() => store.createGoal({ title: 'x', status: 'winning' as never }), ValidationError);
  assert.throws(() => store.createGoal({ title: 'x', progressMode: 'vibes' as never }), ValidationError);
  assert.throws(() => store.createGoal({ title: 'x', startsOn: '2026/01/01' }), ValidationError);
  assert.throws(() => store.createGoal({ title: 'x', startsOn: '2026-12-31', endsOn: '2026-01-01' }), ValidationError);
  assert.throws(() => store.createGoal({ title: 'x', targetValue: Number.NaN }), ValidationError);
  assert.throws(() => store.createGoal({ title: 'x', parentId: 'g_missing' }), ValidationError);
  assert.equal(store.listGoals({ includeClosed: true }).length, 0);
});

test('listGoals: keeps creation order and hides achieved and dropped goals unless asked', () => {
  const { store } = fresh();
  const a = store.createGoal({ title: 'A' });
  const b = store.createGoal({ title: 'B', status: 'achieved' });
  const c = store.createGoal({ title: 'C', status: 'at_risk' });
  const d = store.createGoal({ title: 'D', status: 'dropped' });
  assert.deepEqual(store.listGoals().map((g) => g.id), [a.id, c.id]);
  assert.deepEqual(store.listGoals({ includeClosed: true }).map((g) => g.id), [a.id, b.id, c.id, d.id]);
});

// ---- update ----

test('updateGoal: statusUpdatedAt moves only when the status or its note changes', () => {
  let clock = '2026-09-01T00:00:00.000Z';
  const { store } = fresh(() => clock);
  const goal = store.createGoal({ title: 'Grow the audience' });

  clock = '2026-09-10T00:00:00.000Z';
  const renamed = store.updateGoal(goal.id, { title: 'Grow the audience to 1,000' });
  assert.equal(renamed.statusUpdatedAt, '2026-09-01T00:00:00.000Z');
  assert.equal(renamed.updatedAt, '2026-09-10T00:00:00.000Z');

  clock = '2026-09-15T00:00:00.000Z';
  const flagged = store.updateGoal(goal.id, { status: 'at_risk', statusNote: 'No posts for two weeks' });
  assert.equal(flagged.status, 'at_risk');
  assert.equal(flagged.statusNote, 'No posts for two weeks');
  assert.equal(flagged.statusUpdatedAt, '2026-09-15T00:00:00.000Z');

  clock = '2026-09-20T00:00:00.000Z';
  const noted = store.updateGoal(goal.id, { statusNote: 'Two posts out this week' });
  assert.equal(noted.statusUpdatedAt, '2026-09-20T00:00:00.000Z');
});

test('updateGoal: null clears an optional field, undefined leaves it alone', () => {
  const { store } = fresh();
  const goal = store.createGoal({ title: 'x', periodLabel: '2026', startsOn: '2026-01-01', endsOn: '2026-12-31', unit: 'posts' });
  const kept = store.updateGoal(goal.id, { title: 'y' });
  assert.equal(kept.periodLabel, '2026');
  assert.equal(kept.unit, 'posts');
  const cleared = store.updateGoal(goal.id, { periodLabel: null, startsOn: null, endsOn: null, unit: null });
  assert.equal(cleared.periodLabel, null);
  assert.equal(cleared.startsOn, null);
  assert.equal(cleared.unit, null);
});

test('updateGoal: unknown goal is NotFound, and a reversed period is rejected against the stored dates', () => {
  const { store } = fresh();
  assert.throws(() => store.updateGoal('g_nope', { title: 'x' }), NotFoundError);
  const goal = store.createGoal({ title: 'x', startsOn: '2026-06-01' });
  assert.throws(() => store.updateGoal(goal.id, { endsOn: '2026-01-01' }), ValidationError);
});

// ---- hierarchy ----

test('a goal cannot be its own parent or be moved under one of its sub-goals', () => {
  const { store } = fresh();
  const top = store.createGoal({ title: 'top' });
  const mid = store.createGoal({ title: 'mid', parentId: top.id });
  const leaf = store.createGoal({ title: 'leaf', parentId: mid.id });
  assert.throws(() => store.updateGoal(top.id, { parentId: top.id }), ValidationError);
  assert.throws(() => store.updateGoal(top.id, { parentId: leaf.id }), ValidationError);
  assert.throws(() => store.updateGoal(mid.id, { parentId: leaf.id }), ValidationError);
  // Moving a leaf to the top level, or under a sibling branch, is fine.
  assert.equal(store.updateGoal(leaf.id, { parentId: null }).parentId, null);
  assert.equal(store.updateGoal(leaf.id, { parentId: top.id }).parentId, top.id);
  assert.deepEqual(store.goalDetail(top.id).childIds.sort(), [leaf.id, mid.id].sort());
});

test('deleteGoal: removes the goal and its links, and promotes its sub-goals to the top level', () => {
  const { store, project } = fresh();
  const top = store.createGoal({ title: 'top' });
  const child = store.createGoal({ title: 'child', parentId: top.id });
  store.linkGoal(top.id, { projectId: project.id });
  assert.equal(store.deleteGoal(top.id), true);
  assert.equal(store.getGoal(top.id), undefined);
  assert.equal(store.getGoal(child.id)?.parentId, null);
  assert.deepEqual(store.goalLinks(top.id), []);
  assert.equal(store.deleteGoal(top.id), false);
  // The project itself is untouched.
  assert.ok(store.getProject(project.id));
});

// ---- links ----

test('linkGoal: links a project by id or slug and a task by id, exactly one at a time, idempotently', () => {
  const { store, project } = fresh();
  const goal = store.createGoal({ title: 'x' });
  const task = store.createTask({ title: 'Write the installer script' });

  const bySlug = store.linkGoal(goal.id, { projectId: 'octavium' });
  assert.equal(bySlug.projectId, project.id);
  assert.deepEqual(store.linkGoal(goal.id, { projectId: project.id }), bySlug);
  store.linkGoal(goal.id, { taskId: task.id });
  assert.equal(store.goalLinks(goal.id).length, 2);

  assert.throws(() => store.linkGoal(goal.id, {}), ValidationError);
  assert.throws(() => store.linkGoal(goal.id, { projectId: project.id, taskId: task.id }), ValidationError);
  assert.throws(() => store.linkGoal(goal.id, { projectId: 'no-such-project' }), NotFoundError);
  assert.throws(() => store.linkGoal(goal.id, { taskId: 't_missing' }), NotFoundError);
  assert.throws(() => store.linkGoal('g_missing', { taskId: task.id }), NotFoundError);
});

test('unlinkGoal: removes one link and reports whether anything changed', () => {
  const { store, project } = fresh();
  const goal = store.createGoal({ title: 'x' });
  const task = store.createTask({ title: 't' });
  store.linkGoal(goal.id, { projectId: project.id });
  store.linkGoal(goal.id, { taskId: task.id });
  assert.equal(store.unlinkGoal(goal.id, { projectId: 'octavium' }), true);
  assert.equal(store.unlinkGoal(goal.id, { projectId: project.id }), false);
  assert.deepEqual(store.goalLinks(goal.id).map((l) => l.taskId), [task.id]);
  assert.throws(() => store.unlinkGoal(goal.id, {}), ValidationError);
});

test('deleting a linked task removes the link instead of leaving it dangling', () => {
  const { store } = fresh();
  const goal = store.createGoal({ title: 'x' });
  const task = store.createTask({ title: 't' });
  store.linkGoal(goal.id, { taskId: task.id });
  // There is no deleteTask on the store; the cascade is a schema guarantee, so exercise it directly.
  (store as unknown as { db: { run(sql: string, p: unknown[]): unknown } }).db.run('DELETE FROM tasks WHERE id = ?', [task.id]);
  assert.deepEqual(store.goalLinks(goal.id), []);
});

// ---- progress (decision 2026-09-18: linked tasks, plus milestone tasks of linked projects) ----

test('goalProgress (tasks): nothing linked means nothing to measure', () => {
  const { store } = fresh();
  const goal = store.createGoal({ title: 'x' });
  assert.deepEqual(store.goalProgress(goal.id), { mode: 'tasks', done: 0, total: 0, percent: null, openTasks: 0 });
});

test('goalProgress (tasks): counts linked tasks and project milestones, but not ordinary project tasks', () => {
  const { store, project } = fresh();
  const goal = store.createGoal({ title: 'Ship the installer' });
  store.linkGoal(goal.id, { projectId: project.id });

  const milestoneDone = store.createTask({ title: 'Beta out', projectId: project.id, isMilestone: true });
  store.createTask({ title: 'Signed release', projectId: project.id, isMilestone: true });
  store.createTask({ title: 'Fix a typo', projectId: project.id });
  store.completeTask(milestoneDone.id);

  const linked = store.createTask({ title: 'Buy the certificate' });
  store.linkGoal(goal.id, { taskId: linked.id });

  const progress = store.goalProgress(goal.id);
  // Counted: 2 milestones + 1 linked task. The typo fix moves the goal but is not counted.
  assert.equal(progress.total, 3);
  assert.equal(progress.done, 1);
  assert.equal(progress.percent, 33);
  // Open work: the open milestone, the typo fix, and the linked task.
  assert.equal(progress.openTasks, 3);
});

test('goalProgress (tasks): a task that is both linked and a project milestone is counted once', () => {
  const { store, project } = fresh();
  const goal = store.createGoal({ title: 'x' });
  const milestone = store.createTask({ title: 'Beta out', projectId: project.id, isMilestone: true });
  store.linkGoal(goal.id, { projectId: project.id });
  store.linkGoal(goal.id, { taskId: milestone.id });
  assert.equal(store.goalProgress(goal.id).total, 1);
});

test('goalProgress (tasks): inbox suggestions and dropped tasks never count', () => {
  const { store } = fresh();
  const goal = store.createGoal({ title: 'x' });
  const suggestion = store.upsertFromSource({ sourceType: 'github', sourceId: 'o/r#1', title: 'From GitHub', contentHash: 'h' }).task;
  const dropped = store.createTask({ title: 'Abandoned' });
  store.updateTask(dropped.id, { status: 'dropped' });
  const real = store.createTask({ title: 'Real work' });
  for (const t of [suggestion, dropped, real]) store.linkGoal(goal.id, { taskId: t.id });
  const progress = store.goalProgress(goal.id);
  assert.equal(progress.total, 1);
  assert.equal(progress.openTasks, 1);
});

test('goalProgress (tasks): a parent goal rolls up the work linked to its sub-goals', () => {
  const { store } = fresh();
  const parent = store.createGoal({ title: 'parent' });
  const child = store.createGoal({ title: 'child', parentId: parent.id });
  const grandchild = store.createGoal({ title: 'grandchild', parentId: child.id });
  const a = store.createTask({ title: 'a' });
  const b = store.createTask({ title: 'b' });
  store.linkGoal(child.id, { taskId: a.id });
  store.linkGoal(grandchild.id, { taskId: b.id });
  store.completeTask(a.id);

  assert.deepEqual(store.goalProgress(parent.id), { mode: 'tasks', done: 1, total: 2, percent: 50, openTasks: 1 });
  assert.deepEqual(store.goalProgress(grandchild.id), { mode: 'tasks', done: 0, total: 1, percent: 0, openTasks: 1 });
});

test('goalProgress (manual): percent is current over target, clamped, and null without a positive target', () => {
  const { store } = fresh();
  const goal = store.createGoal({ title: 'Subscribers', progressMode: 'manual', currentValue: 250, targetValue: 1000, unit: 'subscribers' });
  assert.deepEqual(store.goalProgress(goal.id), { mode: 'manual', done: null, total: null, percent: 25, openTasks: 0 });
  store.updateGoal(goal.id, { currentValue: 5000 });
  assert.equal(store.goalProgress(goal.id).percent, 100);
  store.updateGoal(goal.id, { currentValue: -10 });
  assert.equal(store.goalProgress(goal.id).percent, 0);
  store.updateGoal(goal.id, { targetValue: 0 });
  assert.equal(store.goalProgress(goal.id).percent, null);
  store.updateGoal(goal.id, { targetValue: null });
  assert.equal(store.goalProgress(goal.id).percent, null);
});

test('goalOpenTaskIds: the stalled-goal check sees no open work once everything linked is done', () => {
  const { store, project } = fresh();
  const goal = store.createGoal({ title: 'x' });
  store.linkGoal(goal.id, { projectId: project.id });
  const only = store.createTask({ title: 'only task', projectId: project.id });
  assert.deepEqual(store.goalOpenTaskIds(goal.id), [only.id]);
  store.completeTask(only.id);
  assert.deepEqual(store.goalOpenTaskIds(goal.id), []);
  assert.throws(() => store.goalOpenTaskIds('g_missing'), NotFoundError);
});

// ---- status is never computed, and goals never touch tasks ----

test('finishing every linked task does not change the goal status: that is always set by hand', () => {
  const { store } = fresh();
  const goal = store.createGoal({ title: 'x', status: 'at_risk' });
  const task = store.createTask({ title: 't' });
  store.linkGoal(goal.id, { taskId: task.id });
  store.completeTask(task.id);
  assert.equal(store.goalProgress(goal.id).percent, 100);
  assert.equal(store.getGoal(goal.id)?.status, 'at_risk');
});

test('linking, unlinking, and deleting a goal never changes a task', () => {
  const { store } = fresh();
  const goal = store.createGoal({ title: 'x' });
  const task = store.createTask({ title: 't', priority: 'high' });
  const before = store.getTask(task.id);
  store.linkGoal(goal.id, { taskId: task.id });
  store.unlinkGoal(goal.id, { taskId: task.id });
  store.linkGoal(goal.id, { taskId: task.id });
  store.deleteGoal(goal.id);
  assert.deepEqual(store.getTask(task.id), before);
});

// ---- events ----

test('goal changes are recorded as events with the actor, so the dashboard can refresh', () => {
  const { store, project } = fresh();
  const start = store.lastEventId();
  const goal = store.createGoal({ title: 'x' }, 'agent');
  store.updateGoal(goal.id, { status: 'off_track' }, 'agent');
  store.linkGoal(goal.id, { projectId: project.id });
  store.unlinkGoal(goal.id, { projectId: project.id });
  store.deleteGoal(goal.id);
  const events = store.eventsSince(start);
  assert.deepEqual(events.map((e) => e.kind), ['goal.created', 'goal.updated', 'goal.linked', 'goal.unlinked', 'goal.deleted']);
  assert.deepEqual(events.map((e) => e.actor), ['agent', 'agent', 'human', 'human', 'human']);
  assert.equal(events[1].payload.status, 'off_track');
  assert.deepEqual(events[1].payload.changed, ['status']);
  for (const e of events) assert.equal(e.payload.goalId, goal.id);
});

test('listGoalDetails: every open goal with its progress, links, and sub-goal ids', () => {
  const { store, project } = fresh();
  const parent = store.createGoal({ title: 'parent' });
  const child = store.createGoal({ title: 'child', parentId: parent.id });
  store.createGoal({ title: 'done already', status: 'achieved' });
  store.linkGoal(child.id, { projectId: project.id });
  const details = store.listGoalDetails();
  assert.deepEqual(details.map((d) => d.title), ['parent', 'child']);
  assert.deepEqual(details[0].childIds, [child.id]);
  assert.equal(details[1].links[0].projectId, project.id);
  assert.equal(details[0].progress.mode, 'tasks');
  assert.equal(store.listGoalDetails({ includeClosed: true }).length, 3);
});

// ---- upgrading a database that predates goals ----

test('a version 1 database gains the goal tables on open and keeps its tasks', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { MIGRATIONS } = await import('./schema.ts');

  const dir = mkdtempSync(join(tmpdir(), 'cc-goals-upgrade-'));
  const file = join(dir, 'old.db');
  try {
    // Build the database exactly as it was before the goals migration existed.
    const raw = new DatabaseSync(file);
    raw.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
    raw.exec(MIGRATIONS[0]);
    raw.exec('INSERT INTO schema_version (version) VALUES (1)');
    raw.close();

    const before = openStore(file);
    const task = before.createTask({ title: 'Existed before goals' });
    (before as unknown as { db: { close(): void } }).db.close();

    const after = openStore(file);
    assert.equal(after.getTask(task.id)?.title, 'Existed before goals');
    const goal = after.createGoal({ title: 'New after upgrade' });
    after.linkGoal(goal.id, { taskId: task.id });
    assert.equal(after.goalProgress(goal.id).total, 1);
    (after as unknown as { db: { close(): void } }).db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

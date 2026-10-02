import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../core/index.ts';
import { builtinViews, runView } from './views.ts';

const TODAY = '2026-09-12';

function seed() {
  let clock = `${TODAY}T09:00:00.000Z`;
  const s = openStore(':memory:', {
    now: () => clock,
    nextOccurrence: () => null,
  });
  const ids: Record<string, string> = {};

  ids.dueToday = s.createTask({ title: 'Due today', dueAt: TODAY }).id;
  ids.overdue = s.createTask({ title: 'Overdue', dueAt: '2026-09-10' }).id;
  ids.upcoming = s.createTask({ title: 'Due in 3 days', dueAt: '2026-09-15' }).id;
  ids.dueOnBoundary = s.createTask({ title: 'Due in exactly 7 days', dueAt: '2026-09-19' }).id;
  ids.later = s.createTask({ title: 'Due far out', dueAt: '2026-09-25' }).id;
  ids.noDue = s.createTask({ title: 'No due date' }).id;
  ids.waiting = s.createTask({ title: 'Waiting on reply', status: 'waiting' }).id;
  ids.inbox = s.createTask({ title: 'New from gmail', status: 'inbox' }).id;
  ids.milestone = s.createTask({ title: 'Launch', isMilestone: true, dueAt: '2026-09-22' }).id;

  const doneMilestone = s.createTask({ title: 'Old launch', isMilestone: true, dueAt: '2026-08-01' }).id;
  s.completeTask(doneMilestone);
  ids.doneMilestone = doneMilestone;

  const blocker = s.createTask({ title: 'Blocker' }).id;
  ids.blocked = s.createTask({ title: 'Blocked task' }).id;
  s.addDependency(blocker, ids.blocked);
  ids.blocker = blocker;

  const parent = s.createTask({ title: 'Parent' }).id;
  ids.parent = parent;
  ids.subtaskDueToday = s.createTask({ title: 'Subtask due today', parentId: parent, dueAt: TODAY }).id;

  clock = '2026-09-10T00:00:00.000Z'; // 2 days before "today" -> within the last 7 days
  ids.recentlyDone = s.createTask({ title: 'Finished recently', status: 'done' }).id;

  clock = '2026-08-20T00:00:00.000Z'; // more than 7 days before "today"
  ids.oldDone = s.createTask({ title: 'Finished long ago', status: 'done' }).id;

  clock = `${TODAY}T09:00:00.000Z`;
  ids.dropped = s.createTask({ title: 'Dropped', status: 'dropped', dueAt: TODAY }).id;

  return { s, ids };
}

test('builtinViews returns the ten documented views', () => {
  const views = builtinViews(TODAY);
  assert.deepEqual(views.map((v) => v.name).sort(), [
    'blocked', 'inbox', 'later', 'milestones', 'overdue', 'ready', 'recently-completed', 'today', 'upcoming', 'waiting',
  ]);
  for (const v of views) assert.ok(v.description.length > 0);
});

// The ready and blocked views get their own seed: one task per exclusion rule, so each test names
// the rule it checks rather than hunting through the shared seed above.
function seedReady() {
  const s = openStore(':memory:', { now: () => `${TODAY}T09:00:00.000Z`, nextOccurrence: () => null });
  const ids: Record<string, string> = {};

  ids.ready = s.createTask({ title: 'Ready', priority: 'medium', dueAt: '2026-09-20' }).id;
  ids.readyUrgentNoDue = s.createTask({ title: 'Ready, urgent, no due date', priority: 'urgent' }).id;
  ids.readyStartedEarlier = s.createTask({ title: 'Started last week', priority: 'medium', startAt: '2026-09-05' }).id;
  ids.readyStartsToday = s.createTask({ title: 'Starts today', startAt: TODAY }).id;

  ids.inbox = s.createTask({ title: 'Inbox', status: 'inbox' }).id;
  ids.waiting = s.createTask({ title: 'Waiting', status: 'waiting' }).id;
  ids.inProgress = s.createTask({ title: 'In progress', status: 'in_progress' }).id;
  ids.done = s.createTask({ title: 'Done', status: 'done' }).id;
  ids.dropped = s.createTask({ title: 'Dropped', status: 'dropped' }).id;
  ids.startsTomorrow = s.createTask({ title: 'Starts tomorrow', startAt: '2026-09-13' }).id;

  ids.blocker = s.createTask({ title: 'Blocker', status: 'in_progress' }).id;
  ids.secondBlocker = s.createTask({ title: 'Second blocker' }).id;
  ids.doneBlocker = s.createTask({ title: 'Done blocker' }).id;
  s.completeTask(ids.doneBlocker);
  ids.blocked = s.createTask({ title: 'Blocked', dueAt: '2026-09-14' }).id;
  s.addDependency(ids.blocker, ids.blocked);
  s.addDependency(ids.secondBlocker, ids.blocked);
  s.addDependency(ids.doneBlocker, ids.blocked);
  ids.blockedInProgress = s.createTask({ title: 'Blocked while in progress', status: 'in_progress' }).id;
  s.addDependency(ids.blocker, ids.blockedInProgress);
  ids.blockedWaiting = s.createTask({ title: 'Blocked and waiting', status: 'waiting' }).id;
  s.addDependency(ids.blocker, ids.blockedWaiting);
  ids.unblocked = s.createTask({ title: 'Only a done blocker' }).id;
  s.addDependency(ids.doneBlocker, ids.unblocked);

  const liveParent = s.createTask({ title: 'Live parent' }).id;
  ids.liveParent = liveParent;
  ids.underLiveParent = s.createTask({ title: 'Subtask of a live parent', parentId: liveParent }).id;
  const doneParent = s.createTask({ title: 'Done parent' }).id;
  ids.underDoneParent = s.createTask({ title: 'Subtask of a done parent', parentId: doneParent }).id;
  s.completeTask(doneParent);
  const droppedParent = s.createTask({ title: 'Dropped parent' }).id;
  ids.underDroppedParent = s.createTask({ title: 'Subtask of a dropped parent', parentId: droppedParent }).id;
  s.updateTask(droppedParent, { status: 'dropped' });

  return { s, ids };
}

test('ready: open tasks with nothing in the way, priority first then due date', () => {
  const { s, ids } = seedReady();
  const result = runView(s, 'ready', TODAY);
  assert.equal(result.blockers, undefined, 'only the blocked view carries blockers');
  const got = result.tasks.map((t) => t.id);
  const names = new Set(got);
  assert.ok(names.has(ids.ready));
  assert.ok(names.has(ids.readyUrgentNoDue), 'no due date is fine');
  assert.ok(names.has(ids.readyStartedEarlier), 'a start date in the past is fine');
  assert.ok(names.has(ids.readyStartsToday), 'a start date of today is fine');
  assert.ok(names.has(ids.unblocked), 'a blocker that is done no longer blocks');
  assert.ok(names.has(ids.liveParent), 'a parent task can itself be ready');
  assert.ok(names.has(ids.underLiveParent), 'a subtask of a live parent is ready');
  assert.ok(names.has(ids.secondBlocker), 'an open blocker is itself ready');
  assert.ok(!names.has(ids.blocker), 'a blocker that is in progress is not');
  assert.equal(got.indexOf(ids.readyUrgentNoDue) < got.indexOf(ids.ready), true, 'urgent before medium, even without a due date');
  assert.equal(got.indexOf(ids.ready) < got.indexOf(ids.readyStartedEarlier), true, 'at equal priority, a due date sorts before none');
});

test('ready: each exclusion rule removes exactly the task it names', () => {
  const { s, ids } = seedReady();
  const names = new Set(runView(s, 'ready', TODAY).tasks.map((t) => t.id));
  assert.ok(!names.has(ids.inbox), 'inbox awaits triage');
  assert.ok(!names.has(ids.waiting), 'waiting is excluded');
  assert.ok(!names.has(ids.inProgress), 'in_progress has already started');
  assert.ok(!names.has(ids.done), 'done is excluded');
  assert.ok(!names.has(ids.dropped), 'dropped is excluded');
  assert.ok(!names.has(ids.startsTomorrow), 'a start date in the future is excluded');
  assert.ok(!names.has(ids.blocked), 'an incomplete blocker excludes the task');
  assert.ok(!names.has(ids.underDoneParent), 'a subtask of a done parent is excluded');
  assert.ok(!names.has(ids.underDroppedParent), 'a subtask of a dropped parent is excluded');
});

test('ready: a task becomes ready when its blockers are completed, and when its start date arrives', () => {
  const { s, ids } = seedReady();
  const ready = () => new Set(runView(s, 'ready', TODAY).tasks.map((t) => t.id));
  assert.ok(!ready().has(ids.blocked));
  s.completeTask(ids.blocker);
  assert.ok(!ready().has(ids.blocked), 'one of two blockers done is still blocked');
  s.updateTask(ids.secondBlocker, { status: 'dropped' });
  assert.ok(ready().has(ids.blocked), 'every blocker done or dropped makes the task ready');

  assert.ok(!ready().has(ids.startsTomorrow));
  assert.ok(new Set(runView(s, 'ready', '2026-09-13').tasks.map((t) => t.id)).has(ids.startsTomorrow), 'ready on its start date');
});

test('blocked: open or in-progress tasks with an incomplete blocker, each with its blockers listed', () => {
  const { s, ids } = seedReady();
  const { tasks, blockers } = runView(s, 'blocked', TODAY);
  assert.deepEqual(tasks.map((t) => t.id).sort(), [ids.blocked, ids.blockedInProgress].sort());
  assert.ok(blockers, 'the blocked view carries blockers');
  assert.deepEqual(
    blockers[ids.blocked].map((b) => b.title).sort(),
    ['Blocker', 'Second blocker'],
    'the done blocker is not what holds the task, so it is not listed',
  );
  assert.deepEqual(blockers[ids.blockedInProgress].map((b) => b.title), ['Blocker']);
  assert.ok(!(ids.blockedWaiting in blockers), 'a waiting task is in the waiting view, not here');
  assert.equal(tasks[0].id, ids.blocked, 'ordered by due date, undated last');

  s.completeTask(ids.blocker);
  s.completeTask(ids.secondBlocker);
  const after = runView(s, 'blocked', TODAY);
  assert.deepEqual(after.tasks.map((t) => t.id), [], 'nothing is blocked once every blocker is done');
  assert.deepEqual(after.blockers, {});
});

test('today: active tasks due on or before today, including subtasks', () => {
  const { s, ids } = seed();
  const names = new Set(runView(s, 'today', TODAY).tasks.map((t) => t.id));
  assert.ok(names.has(ids.dueToday));
  assert.ok(names.has(ids.overdue), 'overdue tasks are also due "on or before today"');
  assert.ok(names.has(ids.subtaskDueToday), 'subtasks due today are included');
  assert.ok(!names.has(ids.upcoming));
  assert.ok(!names.has(ids.dropped), 'dropped tasks are not active');
});

test('overdue: active tasks due before today only', () => {
  const { s, ids } = seed();
  const names = new Set(runView(s, 'overdue', TODAY).tasks.map((t) => t.id));
  assert.ok(names.has(ids.overdue));
  assert.ok(!names.has(ids.dueToday), 'due today is not overdue');
});

test('upcoming: active tasks due after today through today+7', () => {
  const { s, ids } = seed();
  const names = new Set(runView(s, 'upcoming', TODAY).tasks.map((t) => t.id));
  assert.ok(names.has(ids.upcoming));
  assert.ok(names.has(ids.dueOnBoundary), 'due in exactly 7 days is included');
  assert.ok(!names.has(ids.dueToday));
  assert.ok(!names.has(ids.later));
});

test('later: active tasks with no due date, or due more than 7 days out', () => {
  const { s, ids } = seed();
  const names = new Set(runView(s, 'later', TODAY).tasks.map((t) => t.id));
  assert.ok(names.has(ids.later));
  assert.ok(names.has(ids.noDue));
  assert.ok(!names.has(ids.dueOnBoundary));
  assert.ok(!names.has(ids.upcoming));
});

test('waiting: status waiting OR blocked by an active dependency', () => {
  const { s, ids } = seed();
  const names = new Set(runView(s, 'waiting', TODAY).tasks.map((t) => t.id));
  assert.ok(names.has(ids.waiting));
  assert.ok(names.has(ids.blocked), 'a task blocked by an incomplete dependency counts as waiting');
  assert.ok(!names.has(ids.blocker), 'the blocker itself is not waiting');
});

test('inbox: status inbox', () => {
  const { s, ids } = seed();
  const names = new Set(runView(s, 'inbox', TODAY).tasks.map((t) => t.id));
  assert.deepEqual([...names], [ids.inbox]);
});

test('milestones: active milestones only', () => {
  const { s, ids } = seed();
  const names = new Set(runView(s, 'milestones', TODAY).tasks.map((t) => t.id));
  assert.ok(names.has(ids.milestone));
  assert.ok(!names.has(ids.doneMilestone), 'completed milestones drop out');
});

test('recently-completed: done in the last 7 days', () => {
  const { s, ids } = seed();
  const names = new Set(runView(s, 'recently-completed', TODAY).tasks.map((t) => t.id));
  assert.ok(names.has(ids.recentlyDone));
  assert.ok(!names.has(ids.oldDone));
});

test('runView resolves a saved view by name or id, else throws listing valid names', () => {
  const { s } = seed();
  s.saveView('My Custom', { status: ['open'], priority: ['urgent'] });
  const byName = runView(s, 'My Custom', TODAY);
  assert.equal(byName.view.name, 'My Custom');
  const saved = s.listViews().find((v) => v.name === 'My Custom')!;
  const byId = runView(s, saved.id, TODAY);
  assert.equal(byId.view.name, 'My Custom');

  assert.throws(() => runView(s, 'not-a-real-view', TODAY), (e: unknown) => {
    assert.ok(e instanceof Error);
    assert.match(e.message, /not-a-real-view/);
    assert.match(e.message, /today/);
    return true;
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKLIST_MAX_ITEMS, NotFoundError, ValidationError, openStore } from './index.ts';

const fresh = () => openStore(':memory:');

test('createChecklist trims the name and the items, drops blank items, and keeps their order', () => {
  const store = fresh();
  const c = store.createChecklist({ name: '  Packing:   weekend trip ', notes: 'Check the forecast.', items: [' Passport ', '', '   ', 'Phone  charger', 'Toothbrush'] });
  assert.match(c.id, /^cl_[0-9a-z]{10}$/);
  assert.equal(c.name, 'Packing: weekend trip');
  assert.equal(c.notes, 'Check the forecast.');
  assert.deepEqual(c.items, ['Passport', 'Phone charger', 'Toothbrush']);
  assert.deepEqual(store.getChecklist(c.id), c);
});

test('createChecklist refuses a blank name, too many items, and an item that is too long', () => {
  const store = fresh();
  assert.throws(() => store.createChecklist({ name: '   ' }), ValidationError);
  assert.throws(() => store.createChecklist({ name: 'x'.repeat(201) }), ValidationError);
  assert.throws(() => store.createChecklist({ name: 'Big', items: Array.from({ length: CHECKLIST_MAX_ITEMS + 1 }, (_, i) => `item ${i}`) }), /at most 200 items/);
  assert.throws(() => store.createChecklist({ name: 'Long', items: ['x'.repeat(501)] }), /500 characters/);
  assert.throws(() => store.createChecklist({ name: 'Odd', items: [3 as unknown as string] }), /must be text/);
  // Exactly at the cap is fine.
  assert.equal(store.createChecklist({ name: 'Full', items: Array.from({ length: CHECKLIST_MAX_ITEMS }, (_, i) => `item ${i}`) }).items.length, CHECKLIST_MAX_ITEMS);
  assert.equal(store.listChecklists().length, 1);
});

test('listChecklists is in the order they were made, and findChecklist matches an id or a name in any case', () => {
  const store = fresh();
  const a = store.createChecklist({ name: 'Clean the kitchen', items: ['Dishes'] });
  const b = store.createChecklist({ name: 'Packing: weekend trip', items: ['Passport'] });
  assert.deepEqual(store.listChecklists().map((c) => c.id), [a.id, b.id]);
  assert.equal(store.findChecklist(b.id)?.id, b.id);
  assert.equal(store.findChecklist('clean THE kitchen')?.id, a.id);
  assert.equal(store.findChecklist('nothing like it'), undefined);
});

test('updateChecklist changes only what the patch names, replaces items whole, and records nothing when nothing changed', () => {
  const store = fresh();
  const c = store.createChecklist({ name: 'Kitchen', notes: 'Weekly.', items: ['Dishes', 'Counters'] });
  const before = store.lastEventId();
  assert.deepEqual(store.updateChecklist(c.id, { name: 'Kitchen' }), c);
  assert.equal(store.lastEventId(), before, 'no change, no event');

  const renamed = store.updateChecklist(c.id, { name: 'Clean the kitchen', items: ['Counters', 'Dishes', ' ', 'Floor'] });
  assert.equal(renamed.name, 'Clean the kitchen');
  assert.equal(renamed.notes, 'Weekly.');
  assert.deepEqual(renamed.items, ['Counters', 'Dishes', 'Floor']);
  const [event] = store.eventsSince(before);
  assert.equal(event.kind, 'checklist.updated');
  assert.equal(event.taskId, null);
  assert.deepEqual(event.payload.changed, ['name', 'items']);

  assert.throws(() => store.updateChecklist(c.id, { name: '' }), ValidationError);
  assert.throws(() => store.updateChecklist('cl_missing00', { name: 'x' }), NotFoundError);
});

test('startChecklist makes one open task with the items as subtasks in order, and leaves the template unchanged', () => {
  const store = fresh();
  const project = store.createProject({ name: 'Home' });
  const c = store.createChecklist({ name: 'Packing: weekend trip', notes: 'Check the forecast.', items: ['Passport', 'Phone charger', 'Toothbrush', 'Book'] });
  const template = store.getChecklist(c.id);
  const before = store.lastEventId();

  const { task, subtasks } = store.startChecklist(c.id, { projectId: project.id, dueAt: '2026-10-09' });
  assert.equal(task.title, 'Packing: weekend trip');
  assert.equal(task.notes, 'Check the forecast.');
  assert.equal(task.status, 'open');
  assert.equal(task.projectId, project.id);
  assert.equal(task.dueAt, '2026-10-09');
  assert.equal(task.sourceType, null);
  assert.equal(task.untrustedText, false);
  assert.deepEqual(task.customFields, { checklistId: c.id, checklistRepeatItems: true }, 'bringing the items back is on unless asked otherwise');
  assert.deepEqual(subtasks.map((s) => s.title), ['Passport', 'Phone charger', 'Toothbrush', 'Book']);
  assert.deepEqual(store.subtasks(task.id).map((s) => s.title), ['Passport', 'Phone charger', 'Toothbrush', 'Book'], 'read back in the same order');
  for (const s of subtasks) {
    assert.equal(s.parentId, task.id);
    assert.equal(s.status, 'open');
    assert.equal(s.projectId, project.id, 'a subtask is filed with its parent');
    assert.equal(s.untrustedText, false);
  }

  // The usual task events, one per task, as the actor who started it. Nothing is said about the template.
  const events = store.eventsSince(before);
  assert.deepEqual(events.map((e) => e.kind), Array(5).fill('task.created'));
  assert.ok(events.every((e) => e.actor === 'human'));
  assert.deepEqual(store.getChecklist(c.id), template, 'starting a checklist never changes it');

  // And it can be started again, as a separate task with its own subtasks.
  const again = store.startChecklist(c.id, { title: 'Packing: Lisbon' }, 'agent');
  assert.notEqual(again.task.id, task.id);
  assert.equal(again.task.title, 'Packing: Lisbon');
  assert.equal(again.task.projectId, null);
  assert.equal(store.subtasks(again.task.id).length, 4);
  assert.equal(store.subtasks(task.id).length, 4, 'the first run keeps its own items');
  assert.equal(store.taskHistory(again.task.id)[0].actor, 'agent');
});

test('ticking an item is completing a subtask, and the template does not notice', () => {
  const store = fresh();
  const c = store.createChecklist({ name: 'Clean the kitchen', items: ['Dishes', 'Floor'] });
  const { task, subtasks } = store.startChecklist(c.id);
  store.completeTask(subtasks[0].id);
  assert.deepEqual(store.subtasks(task.id).map((s) => s.status), ['done', 'open']);
  assert.deepEqual(store.getChecklist(c.id)!.items, ['Dishes', 'Floor']);
  assert.equal(store.requireTask(task.id).status, 'open');
});

test('startChecklist is all or nothing: a bad project or due date, or an empty checklist, makes no task at all', () => {
  const store = fresh();
  const c = store.createChecklist({ name: 'Kitchen', items: ['Dishes'] });
  const empty = store.createChecklist({ name: 'Nothing yet' });
  const before = store.countTasks({});
  assert.throws(() => store.startChecklist(c.id, { projectId: 'p_missing000' }), NotFoundError);
  assert.throws(() => store.startChecklist(c.id, { dueAt: 'next tuesday' }), ValidationError);
  assert.throws(() => store.startChecklist(empty.id), /no items yet/);
  assert.throws(() => store.startChecklist('cl_missing00'), NotFoundError);
  assert.equal(store.countTasks({}), before);
});

test('deleting a checklist leaves every task started from it, subtasks and all', () => {
  const store = fresh();
  const c = store.createChecklist({ name: 'Kitchen', items: ['Dishes', 'Floor'] });
  const { task } = store.startChecklist(c.id);
  const before = store.lastEventId();
  assert.equal(store.deleteChecklist(c.id), true);
  assert.equal(store.getChecklist(c.id), undefined);
  assert.equal(store.deleteChecklist(c.id), false, 'a second delete finds nothing');
  assert.equal(store.requireTask(task.id).title, 'Kitchen');
  assert.deepEqual(store.subtasks(task.id).map((s) => s.title), ['Dishes', 'Floor']);
  assert.deepEqual(store.eventsSince(before).map((e) => [e.kind, e.payload.name]), [['checklist.deleted', 'Kitchen']]);
});

test('saveTaskAsChecklist makes a template from the subtask titles in order, leaving out dropped ones', () => {
  const store = fresh();
  const task = store.createTask({ title: 'Move flat', notes: 'Book the van first.' });
  for (const title of ['Book van', 'Pack books', 'Old idea', 'Hand back keys']) store.createTask({ title, parentId: task.id });
  const dropped = store.subtasks(task.id).find((s) => s.title === 'Old idea')!;
  store.updateTask(dropped.id, { status: 'dropped' });
  store.completeTask(store.subtasks(task.id)[0].id);

  const c = store.saveTaskAsChecklist(task.id);
  assert.equal(c.name, 'Move flat');
  assert.equal(c.notes, 'Book the van first.');
  assert.deepEqual(c.items, ['Book van', 'Pack books', 'Hand back keys'], 'a done item is still part of the routine');
  assert.equal(store.saveTaskAsChecklist(task.id, 'Moving house', 'agent').name, 'Moving house');

  const bare = store.createTask({ title: 'No subtasks' });
  assert.throws(() => store.saveTaskAsChecklist(bare.id), /no subtasks/);
  assert.throws(() => store.saveTaskAsChecklist('t_missing000'), NotFoundError);
});

test('saveTaskAsChecklist refuses a task whose text, or a subtask\'s, came from a third party', () => {
  const store = fresh();
  const issue = store.upsertFromSource({ sourceType: 'github', sourceId: 'o/r#1', title: 'Release steps', contentHash: 'h' }).task;
  store.acceptInboxItem(issue.id);
  store.createTask({ title: 'Tag it', parentId: issue.id });
  assert.throws(() => store.saveTaskAsChecklist(issue.id), /third party/);

  const mine = store.createTask({ title: 'Mine' });
  store.createTask({ title: 'Copied from an issue', parentId: mine.id, untrustedText: true });
  assert.throws(() => store.saveTaskAsChecklist(mine.id), /third party/);
  assert.equal(store.listChecklists().length, 0);
});

test('every checklist write is recorded with its actor and no task id', () => {
  const store = fresh();
  const c = store.createChecklist({ name: 'Kitchen', items: ['Dishes'] }, { actor: 'agent', name: 'scribe' });
  store.updateChecklist(c.id, { notes: 'Weekly.' }, 'human');
  store.deleteChecklist(c.id, 'human');
  const events = store.eventsSince(0);
  assert.deepEqual(events.map((e) => [e.kind, e.actor, e.actorName, e.taskId]), [
    ['checklist.created', 'agent', 'scribe', null],
    ['checklist.updated', 'human', null, null],
    ['checklist.deleted', 'human', null, null],
  ]);
});

// A weekly series: each completion makes the next occurrence a week on.
const weekly = () => openStore(':memory:', {
  nextOccurrence: (_rrule: string, prev: string) => {
    const d = new Date(`${prev.slice(0, 10)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 7);
    return d.toISOString().slice(0, 10);
  },
});

test('with repeatItems on, a repeat brings the current items back as fresh open subtasks in order, dropped ones left out', () => {
  const store = weekly();
  const c = store.createChecklist({ name: 'Clean the kitchen', items: ['Dishes', 'Counters', 'Floor'] });
  const { task, subtasks } = store.startChecklist(c.id, { dueAt: '2026-10-11' });
  store.updateTask(task.id, { recurrence: 'FREQ=WEEKLY' });
  // The owner works the list: ticks one, drops one, and adds one of their own.
  store.completeTask(subtasks[0].id);
  store.updateTask(subtasks[2].id, { status: 'dropped' });
  store.createTask({ title: 'Bins', parentId: task.id });
  const before = store.lastEventId();

  const { next } = store.completeTask(task.id, { actor: 'agent', name: 'scribe' });
  assert.ok(next);
  assert.equal(next.dueAt, '2026-10-18');
  assert.equal(next.customFields.checklistRepeatItems, true, 'the choice carries on to every later repeat');
  const copies = store.subtasks(next.id);
  assert.deepEqual(copies.map((s) => [s.title, s.status, s.untrustedText]), [['Dishes', 'open', false], ['Counters', 'open', false], ['Bins', 'open', false]]);
  for (const e of store.eventsSince(before).filter((ev) => ev.kind === 'task.created')) assert.equal(e.actor, 'agent', 'recorded as whoever completed it');
  assert.deepEqual(store.subtasks(task.id).map((s) => s.status), ['done', 'open', 'dropped', 'open'], 'the finished occurrence keeps its own items as they were');
  assert.deepEqual(store.getChecklist(c.id)!.items, ['Dishes', 'Counters', 'Floor'], 'the template is not involved');

  // And again on the next repeat.
  const third = store.completeTask(next.id).next!;
  assert.deepEqual(store.subtasks(third.id).map((s) => s.title), ['Dishes', 'Counters', 'Bins']);
});

test('with repeatItems off, or on a task that never came from a checklist, a repeat comes back alone as before', () => {
  const store = weekly();
  const c = store.createChecklist({ name: 'Clean the kitchen', items: ['Dishes', 'Floor'] });
  const { task } = store.startChecklist(c.id, { dueAt: '2026-10-11', repeatItems: false });
  assert.equal(task.customFields.checklistRepeatItems, false);
  store.updateTask(task.id, { recurrence: 'FREQ=WEEKLY' });
  const { next } = store.completeTask(task.id);
  assert.deepEqual(store.subtasks(next!.id), []);

  const plain = store.createTask({ title: 'Water plants', dueAt: '2026-10-11', recurrence: 'FREQ=WEEKLY' });
  store.createTask({ title: 'Ferns', parentId: plain.id });
  assert.deepEqual(store.subtasks(store.completeTask(plain.id).next!.id), []);
});

test('a repeat never carries a subtask marked as third-party text, even with the flag on', () => {
  const store = weekly();
  const c = store.createChecklist({ name: 'Release', items: ['Tag it'] });
  const { task } = store.startChecklist(c.id, { dueAt: '2026-10-11' });
  store.updateTask(task.id, { recurrence: 'FREQ=WEEKLY' });
  store.createTask({ title: 'Copied from an issue', parentId: task.id, untrustedText: true });
  const { next } = store.completeTask(task.id);
  assert.deepEqual(store.subtasks(next!.id).map((s) => s.title), ['Tag it']);
});

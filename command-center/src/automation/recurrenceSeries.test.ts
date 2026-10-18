// A repeating task's series through the store with the real recurrence engine wired in as app.ts
// wires it: exact COUNT across completions and skips, X-FROM=COMPLETION, and the rules a write
// refuses. The store's today and the engine's today are the same movable day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, type Store, type Task } from '../core/index.ts';
import { openApp } from '../app.ts';
import { nextOccurrence } from './recurrence.ts';

function series(start: string): { store: Store; on: (day: string) => void } {
  let today = start;
  const store = openStore(':memory:', {
    nextOccurrence: (rule, prev, context) => nextOccurrence(rule, prev, today, context),
    validateRecurrence: (rule) => {
      try { nextOccurrence(rule, today, today); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
    },
    today: () => today,
  });
  return { store, on: (day) => { today = day; } };
}

/** Complete the task and return its next instance, which must exist. */
function finish(store: Store, task: Task): Task {
  const { next } = store.completeTask(task.id, 'human');
  assert.ok(next, `completing ${task.id} (${task.recurrence}) should create a next occurrence`);
  return next!;
}

// ---- exact COUNT

test('COUNT=3 gives exactly three tasks through completions, each next one carrying one fewer', () => {
  const { store, on } = series('2026-09-10');
  const first = store.createTask({ title: 'Three times', dueAt: '2026-09-10', recurrence: 'FREQ=DAILY;COUNT=3' });
  const second = finish(store, first);
  assert.equal(second.dueAt, '2026-09-11');
  assert.equal(second.recurrence, 'FREQ=DAILY;COUNT=2');
  on('2026-09-11');
  const third = finish(store, second);
  assert.equal(third.dueAt, '2026-09-12');
  assert.equal(third.recurrence, 'FREQ=DAILY;COUNT=1');
  on('2026-09-12');
  assert.equal(store.completeTask(third.id, 'human').next, null);
  assert.equal(store.countTasks(), 3);
  // The finished tasks keep the rule they had, so their history reads true.
  assert.equal(store.requireTask(first.id).recurrence, 'FREQ=DAILY;COUNT=3');
});

test('a late finish uses up one occurrence, not the dates it jumped over', () => {
  const { store, on } = series('2026-09-04');
  const first = store.createTask({ title: 'Weekly, three times', dueAt: '2026-09-04', recurrence: 'FREQ=WEEKLY;COUNT=3' });
  on('2026-09-25');
  const second = finish(store, first);
  assert.equal(second.dueAt, '2026-09-25');
  assert.equal(second.recurrence, 'FREQ=WEEKLY;COUNT=2');
});

test('skips use up occurrences too, and the last one cannot be skipped', () => {
  const { store, on } = series('2026-09-10');
  const task = store.createTask({ title: 'Four times', dueAt: '2026-09-10', recurrence: 'FREQ=DAILY;COUNT=4' });
  const skipped = store.skipOccurrence(task.id, 'human');
  assert.equal(skipped.dueAt, '2026-09-11');
  assert.equal(skipped.recurrence, 'FREQ=DAILY;COUNT=3');
  on('2026-09-11');
  const next = finish(store, skipped);
  assert.equal(next.dueAt, '2026-09-12');
  assert.equal(next.recurrence, 'FREQ=DAILY;COUNT=2');
  const again = store.skipOccurrence(next.id, 'human');
  assert.equal(again.dueAt, '2026-09-13');
  assert.equal(again.recurrence, 'FREQ=DAILY;COUNT=1');
  assert.throws(() => store.skipOccurrence(next.id, 'human'), /last occurrence of the series, so there is nothing to skip to/);
  assert.equal(store.requireTask(next.id).dueAt, '2026-09-13', 'a refused skip changes nothing');
  assert.equal(store.requireTask(next.id).recurrence, 'FREQ=DAILY;COUNT=1');
  assert.equal(store.completeTask(next.id, 'human').next, null);
  // Four occurrences: one skipped, two completed tasks, one skipped on the second task. Two tasks.
  assert.equal(store.countTasks(), 2);
});

test('COUNT is rewritten in place, whatever the order and spelling of the rest of the rule', () => {
  const { store } = series('2026-09-10');
  const task = store.createTask({ title: 'Count first', dueAt: '2026-09-10', recurrence: 'RRULE:COUNT=12;FREQ=WEEKLY;BYDAY=TH' });
  assert.equal(finish(store, task).recurrence, 'RRULE:COUNT=11;FREQ=WEEKLY;BYDAY=TH');
  const plain = store.createTask({ title: 'No count', dueAt: '2026-09-10', recurrence: 'weekly' });
  assert.equal(store.skipOccurrence(plain.id, 'human').recurrence, 'weekly');
});

// ---- X-FROM=COMPLETION

test('X-FROM=COMPLETION counts from the day it is finished, early or late', () => {
  const { store, on } = series('2026-09-08');
  const task = store.createTask({ title: 'Water plants', dueAt: '2026-09-10', recurrence: 'FREQ=DAILY;INTERVAL=3;X-FROM=COMPLETION' });
  const early = finish(store, task);
  assert.equal(early.dueAt, '2026-09-11', 'finished two days early: three days after the finish');
  assert.equal(early.recurrence, 'FREQ=DAILY;INTERVAL=3;X-FROM=COMPLETION');
  on('2026-09-15');
  const late = finish(store, early);
  assert.equal(late.dueAt, '2026-09-18', 'finished four days late: three days after the finish');
});

test('X-FROM=COMPLETION keeps the time of day, and works on an alias and a weekly rule', () => {
  const { store, on } = series('2026-09-12');
  const timed = store.createTask({ title: 'Timed', dueAt: '2026-09-10T09:30', recurrence: 'every 3 days;X-FROM=COMPLETION' });
  assert.equal(finish(store, timed).dueAt, '2026-09-15T09:30');
  // Due Monday the 14th, finished Thursday the 17th: a week after the finish, on the Thursday.
  on('2026-09-17');
  const weekly = store.createTask({ title: 'Weekly from finish', dueAt: '2026-09-14', recurrence: 'FREQ=WEEKLY;X-FROM=COMPLETION' });
  assert.equal(finish(store, weekly).dueAt, '2026-09-24');
});

test('X-FROM=COMPLETION still ends on UNTIL and on COUNT', () => {
  const { store, on } = series('2026-09-16');
  const until = store.createTask({ title: 'Until', dueAt: '2026-09-10', recurrence: 'FREQ=DAILY;INTERVAL=3;UNTIL=20260920;X-FROM=COMPLETION' });
  assert.equal(finish(store, until).dueAt, '2026-09-19');
  on('2026-09-18');
  const late = store.createTask({ title: 'Until, late', dueAt: '2026-09-10', recurrence: 'FREQ=DAILY;INTERVAL=3;UNTIL=20260920;X-FROM=COMPLETION' });
  assert.equal(store.completeTask(late.id, 'human').next, null, 'three days after the 18th is past UNTIL');

  const counted = store.createTask({ title: 'Twice', dueAt: '2026-09-18', recurrence: 'FREQ=DAILY;INTERVAL=2;COUNT=2;X-FROM=COMPLETION' });
  const second = finish(store, counted);
  assert.equal(second.dueAt, '2026-09-20');
  assert.equal(second.recurrence, 'FREQ=DAILY;INTERVAL=2;COUNT=1;X-FROM=COMPLETION');
  assert.equal(store.completeTask(second.id, 'human').next, null);
});

test('a skip on an X-FROM=COMPLETION rule counts from the due date: skipping is not finishing', () => {
  const { store } = series('2026-09-08');
  const task = store.createTask({ title: 'Skip from due', dueAt: '2026-09-10', recurrence: 'FREQ=DAILY;INTERVAL=3;X-FROM=COMPLETION' });
  assert.equal(store.skipOccurrence(task.id, 'human').dueAt, '2026-09-13');
});

test('a two-argument hook still works and ignores the completion day', () => {
  const store = openStore(':memory:', { nextOccurrence: (rule, prev) => nextOccurrence(rule, prev, '2026-09-08') });
  const task = store.createTask({ title: 'Old hook', dueAt: '2026-09-10', recurrence: 'FREQ=DAILY;INTERVAL=3;X-FROM=COMPLETION' });
  assert.equal(store.completeTask(task.id, 'human').next?.dueAt, '2026-09-13');
});

test('the engine ignores the completion day for a rule without X-FROM', () => {
  assert.equal(nextOccurrence('FREQ=DAILY;INTERVAL=3', '2026-09-10', '2026-09-08', { completedOn: '2026-09-08' }), '2026-09-13');
  assert.equal(nextOccurrence('FREQ=DAILY;INTERVAL=3;X-FROM=COMPLETION', '2026-09-10', '2026-09-08', { completedOn: '2026-09-08' }), '2026-09-11');
  assert.equal(nextOccurrence('RRULE:X-FROM=completion;FREQ=DAILY', '2026-09-10', '2026-09-08', { completedOn: '2026-09-08' }), '2026-09-09');
});

// ---- what a write refuses

test('every other X- part, a bad X-FROM, and a doubled one are refused on write through openApp', () => {
  const app = openApp({ dbPath: ':memory:' });
  try {
    assert.throws(() => app.store.createTask({ title: 'x', recurrence: 'FREQ=DAILY;X-FOO=1' }), /X-FOO is not supported/);
    assert.throws(() => app.store.createTask({ title: 'x', recurrence: 'FREQ=DAILY;X-FROM=DUE' }), /X-FROM must be COMPLETION/);
    assert.throws(() => app.store.createTask({ title: 'x', recurrence: 'FREQ=DAILY;X-FROM=COMPLETION;X-FROM=COMPLETION' }), /X-FROM is given twice/);
    assert.throws(() => app.store.createTask({ title: 'x', recurrence: 'X-FROM=COMPLETION' }), /invalid recurrence rule/);
    assert.throws(() => app.store.createTask({ title: 'x', recurrence: 'FREQ=DAILY;COUNT=0;X-FROM=COMPLETION' }), /COUNT must be a whole number/);
    const ok = app.store.createTask({ title: 'fine', recurrence: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231;X-FROM=COMPLETION' });
    assert.equal(ok.recurrence, 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231;X-FROM=COMPLETION');
  } finally {
    app.close();
  }
});

// ---- last day and last weekday of the month

test('monthly on the last day and on the last Friday', () => {
  assert.equal(nextOccurrence('FREQ=MONTHLY;BYMONTHDAY=-1', '2026-01-31', '2026-01-31'), '2026-02-28');
  assert.equal(nextOccurrence('FREQ=MONTHLY;BYMONTHDAY=-1', '2028-01-31', '2028-01-31'), '2028-02-29');
  assert.equal(nextOccurrence('FREQ=MONTHLY;BYMONTHDAY=-1', '2026-10-14', '2026-10-14'), '2026-10-31');
  assert.equal(nextOccurrence('FREQ=MONTHLY;BYDAY=-1FR', '2026-10-30', '2026-10-30'), '2026-11-27');
  assert.equal(nextOccurrence('FREQ=MONTHLY;INTERVAL=3;BYDAY=-1WE', '2026-10-28', '2026-10-28'), '2027-01-27');
});

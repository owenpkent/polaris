import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ValidationError, applyOutbox, openStore, restoreFromHistory } from './index.ts';

test('putting back an edit restores the fields it changed and is itself in history', () => {
  const store = openStore(':memory:');
  const task = store.createTask({ title: 'Draft the plan', notes: 'first notes', priority: 'low' });
  store.updateTask(task.id, { title: 'Plan', notes: 'second notes', priority: 'high' });
  const edit = store.taskHistory(task.id).find((e) => e.kind === 'task.updated')!;

  const restored = restoreFromHistory(store, task.id, edit.id, 'human');
  assert.equal(restored.title, 'Draft the plan');
  assert.equal(restored.notes, 'first notes');
  assert.equal(restored.priority, 'low');
  assert.equal(store.taskHistory(task.id).filter((e) => e.kind === 'task.updated').length, 2);
});

test('putting back a sync conflict brings back the edit that lost', () => {
  let now = '2026-09-21T08:00:00.000Z';
  const store = openStore(':memory:', { now: () => now });
  const task = store.createTask({ title: 'Original' });
  now = '2026-09-21T11:00:00.000Z';
  store.updateTask(task.id, { title: 'From the PC' });
  now = '2026-09-21T12:00:00.000Z';
  applyOutbox(store, [{ opId: 'op_1', deviceId: 'phone', kind: 'update_task', taskId: task.id, at: '2026-09-21T10:00:00.000Z', base: task.updatedAt, body: { title: 'From the phone' } }]);
  const conflict = store.taskHistory(task.id).find((e) => e.kind === 'task.sync_conflict')!;

  assert.equal(restoreFromHistory(store, task.id, conflict.id, 'human').title, 'From the phone');
});

test('status, place, and entries of another task cannot be put back', () => {
  const store = openStore(':memory:');
  const task = store.createTask({ title: 'Ship it' });
  const other = store.createTask({ title: 'Other' });
  store.updateTask(task.id, { status: 'waiting' });
  const statusEdit = store.taskHistory(task.id).find((e) => e.kind === 'task.updated')!;
  assert.throws(() => restoreFromHistory(store, task.id, statusEdit.id, 'human'), ValidationError);
  assert.equal(store.requireTask(task.id).status, 'waiting');

  store.updateTask(other.id, { title: 'Other, renamed' });
  const otherEdit = store.taskHistory(other.id).find((e) => e.kind === 'task.updated')!;
  assert.throws(() => restoreFromHistory(store, task.id, otherEdit.id, 'human'), ValidationError);
  assert.equal(store.requireTask(other.id).title, 'Other, renamed');
});

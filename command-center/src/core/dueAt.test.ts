import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './index.ts';
import { dueDay, formatDue, isDateOnly, parseDueInput } from './dueAt.ts';

test('dueDay is the first ten characters, with or without a time', () => {
  assert.equal(dueDay('2026-10-18'), '2026-10-18');
  assert.equal(dueDay('2026-10-18T09:00'), '2026-10-18');
  assert.equal(dueDay('2026-10-18T23:30:00Z'), '2026-10-18');
});

test('isDateOnly tells a plain day from a datetime', () => {
  assert.equal(isDateOnly('2026-10-18'), true);
  assert.equal(isDateOnly('2026-10-18T09:00'), false);
  assert.equal(isDateOnly('soon'), false);
});

test('formatDue writes a time after the day with a space, dropping zero seconds and keeping a zone', () => {
  assert.equal(formatDue('2026-10-18'), '2026-10-18');
  assert.equal(formatDue('2026-10-18T09:00'), '2026-10-18 09:00');
  assert.equal(formatDue('2026-10-18T09:00:00'), '2026-10-18 09:00');
  assert.equal(formatDue('2026-10-18T09:00:00.000'), '2026-10-18 09:00');
  assert.equal(formatDue('2026-10-18T09:00:30'), '2026-10-18 09:00:30');
  assert.equal(formatDue('2026-10-18T09:00:00Z'), '2026-10-18 09:00 Z');
  assert.equal(formatDue('2026-10-18T09:00+02:00'), '2026-10-18 09:00 +02:00');
  assert.equal(formatDue('not a date'), 'not a date');
});

test('parseDueInput takes a day, or a day and HH:MM after a space or a T, and stores floating local time', () => {
  assert.equal(parseDueInput('2026-10-18'), '2026-10-18');
  assert.equal(parseDueInput('2026-10-18 09:00'), '2026-10-18T09:00');
  assert.equal(parseDueInput(' 2026-10-18 9:05 '), '2026-10-18T09:05');
  assert.equal(parseDueInput('2026-10-18T17:30'), '2026-10-18T17:30');
  // A full ISO datetime passes through for the store to judge.
  assert.equal(parseDueInput('2026-10-18T09:00:00Z'), '2026-10-18T09:00:00Z');
  assert.throws(() => parseDueInput('2026-10-18 25:00'), /not a time of day/);
  assert.throws(() => parseDueInput('2026-10-18 09:75'), /not a time of day/);
});

test('store: a task due at a time sorts after the untimed tasks of its day, then by time, before the next day', () => {
  const s = openStore(':memory:');
  const late = s.createTask({ title: 'Afternoon', dueAt: '2026-10-18T14:00' });
  const nextDay = s.createTask({ title: 'Next day', dueAt: '2026-10-19' });
  const early = s.createTask({ title: 'Morning', dueAt: '2026-10-18T09:00' });
  const untimed = s.createTask({ title: 'Some time today', dueAt: '2026-10-18' });
  const none = s.createTask({ title: 'No due date' });
  assert.deepEqual(s.searchTasks({ orderBy: 'due' }).map((t) => t.id), [untimed.id, early.id, late.id, nextDay.id, none.id]);
});

test('store: a plain-date dueBefore and dueAfter treat a timed task as its day', () => {
  const s = openStore(':memory:');
  const timedToday = s.createTask({ title: 'Today at nine', dueAt: '2026-10-18T09:00' });
  const timedYesterday = s.createTask({ title: 'Yesterday at five', dueAt: '2026-10-17T17:00' });
  const ids = (f: Parameters<typeof s.searchTasks>[0]) => s.searchTasks(f).map((t) => t.id).sort();
  // Overdue is "before today": yesterday at any time, never today at any time.
  assert.deepEqual(ids({ dueBefore: '2026-10-18' }), [timedYesterday.id]);
  // Due today is [today, tomorrow).
  assert.deepEqual(ids({ dueAfter: '2026-10-18', dueBefore: '2026-10-19' }), [timedToday.id]);
});

test('store: a time is kept as written, with no zone added', () => {
  const s = openStore(':memory:');
  const t = s.createTask({ title: 'Call', dueAt: '2026-10-18T09:00' });
  assert.equal(s.getTask(t.id)?.dueAt, '2026-10-18T09:00');
  assert.equal(s.updateTask(t.id, { dueAt: '2026-10-20T09:00' }).dueAt, '2026-10-20T09:00');
});

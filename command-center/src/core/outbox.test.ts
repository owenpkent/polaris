import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOutbox, openStore, type OutboxOp, type Store } from './index.ts';

// A clock the test moves by hand, so "who edited last" is stated rather than implied.
function storeAt(start: string): { store: Store; setNow: (iso: string) => void } {
  let now = start;
  const store = openStore(':memory:', { now: () => now });
  return { store, setNow: (iso) => { now = iso; } };
}

let seq = 0;
function op(partial: Partial<OutboxOp> & Pick<OutboxOp, 'kind' | 'taskId'>): OutboxOp {
  return { opId: `op_${String(++seq).padStart(8, '0')}`, deviceId: 'device-phone', at: '2026-09-21T10:00:00.000Z', base: null, body: {}, ...partial };
}

test('an edit nobody else touched applies, with no conflict', () => {
  const { store, setNow } = storeAt('2026-09-21T08:00:00.000Z');
  const task = store.createTask({ title: 'Write the plan' });
  setNow('2026-09-21T12:00:00.000Z');
  const [r] = applyOutbox(store, [op({ kind: 'update_task', taskId: task.id, base: task.updatedAt, body: { title: 'Write the plan today' } })]);
  assert.equal(r.status, 'applied');
  assert.equal(store.requireTask(task.id).title, 'Write the plan today');
});

test('a task created offline keeps the id the device gave it, and a replay adds nothing', () => {
  const { store } = storeAt('2026-09-21T12:00:00.000Z');
  const create = op({ kind: 'create_task', taskId: 't_abc123def4', body: { title: 'Made on the train', priority: 'high' } });
  assert.equal(applyOutbox(store, [create])[0].status, 'applied');
  assert.equal(store.requireTask('t_abc123def4').priority, 'high');
  assert.equal(applyOutbox(store, [create])[0].status, 'duplicate');
  assert.equal(store.searchTasks({ text: 'Made on the train' }).length, 1);
});

test('when both sides changed a field, the newer edit wins and the older value goes to history', () => {
  const { store, setNow } = storeAt('2026-09-21T08:00:00.000Z');
  const task = store.createTask({ title: 'Original' });
  // The PC edits at 11:00. The phone had edited at 10:00 while offline and reconnects at 12:00.
  setNow('2026-09-21T11:00:00.000Z');
  store.updateTask(task.id, { title: 'From the PC' });
  setNow('2026-09-21T12:00:00.000Z');
  const [r] = applyOutbox(store, [op({ kind: 'update_task', taskId: task.id, base: task.updatedAt, at: '2026-09-21T10:00:00.000Z', body: { title: 'From the phone' } })]);

  assert.equal(r.status, 'conflict');
  assert.deepEqual(r.conflicts, [{ field: 'title', kept: 'From the PC', discarded: 'From the phone' }]);
  assert.equal(store.requireTask(task.id).title, 'From the PC');
  const conflict = store.taskHistory(task.id).find((e) => e.kind === 'task.sync_conflict');
  assert.equal(conflict?.payload.discarded, 'From the phone');
});

test('the offline edit wins when it was made after the other change', () => {
  const { store, setNow } = storeAt('2026-09-21T08:00:00.000Z');
  const task = store.createTask({ title: 'Original' });
  setNow('2026-09-21T09:00:00.000Z');
  store.updateTask(task.id, { title: 'From the PC' });
  setNow('2026-09-21T12:00:00.000Z');
  const [r] = applyOutbox(store, [op({ kind: 'update_task', taskId: task.id, base: task.updatedAt, at: '2026-09-21T10:00:00.000Z', body: { title: 'From the phone' } })]);

  assert.equal(r.status, 'conflict');
  assert.equal(store.requireTask(task.id).title, 'From the phone');
  assert.deepEqual(r.conflicts, [{ field: 'title', kept: 'From the phone', discarded: 'From the PC' }]);
});

test('fields that did not collide merge cleanly', () => {
  const { store, setNow } = storeAt('2026-09-21T08:00:00.000Z');
  const task = store.createTask({ title: 'Original' });
  setNow('2026-09-21T11:00:00.000Z');
  store.updateTask(task.id, { priority: 'urgent' });
  setNow('2026-09-21T12:00:00.000Z');
  const [r] = applyOutbox(store, [op({ kind: 'update_task', taskId: task.id, base: task.updatedAt, body: { dueAt: '2026-09-25' } })]);
  assert.equal(r.status, 'applied');
  const merged = store.requireTask(task.id);
  assert.equal(merged.priority, 'urgent');
  assert.equal(merged.dueAt, '2026-09-25');
});

test('two offline devices are ordered by when they edited, not by who reconnected first', () => {
  const { store, setNow } = storeAt('2026-09-21T08:00:00.000Z');
  const task = store.createTask({ title: 'Original' });
  // The laptop edited at 11:00 and reconnects first. The phone edited at 10:00 and reconnects later.
  setNow('2026-09-21T12:00:00.000Z');
  applyOutbox(store, [op({ kind: 'update_task', taskId: task.id, deviceId: 'device-laptop', base: task.updatedAt, at: '2026-09-21T11:00:00.000Z', body: { title: 'Laptop' } })]);
  setNow('2026-09-21T13:00:00.000Z');
  const [r] = applyOutbox(store, [op({ kind: 'update_task', taskId: task.id, base: task.updatedAt, at: '2026-09-21T10:00:00.000Z', body: { title: 'Phone' } })]);
  assert.equal(r.status, 'conflict');
  assert.equal(store.requireTask(task.id).title, 'Laptop');
});

test('two edits made in the same millisecond end the same whichever arrives first', () => {
  const at = '2026-09-21T10:00:00.000Z';
  const replay = (order: 'laptop-first' | 'phone-first') => {
    const { store, setNow } = storeAt('2026-09-21T08:00:00.000Z');
    const task = store.createTask({ title: 'Original' });
    const laptop = op({ opId: 'op_aaaaaaaa', kind: 'update_task', taskId: task.id, deviceId: 'device-laptop', base: task.updatedAt, at, body: { title: 'Laptop' } });
    const phone = op({ opId: 'op_bbbbbbbb', kind: 'update_task', taskId: task.id, base: task.updatedAt, at, body: { title: 'Phone' } });
    const [first, second] = order === 'laptop-first' ? [laptop, phone] : [phone, laptop];
    setNow('2026-09-21T12:00:00.000Z');
    applyOutbox(store, [first]);
    setNow('2026-09-21T13:00:00.000Z');
    const [r] = applyOutbox(store, [second]);
    assert.equal(r.status, 'conflict');
    return store.requireTask(task.id).title;
  };
  // The larger op id wins the tie, in both orders.
  assert.equal(replay('laptop-first'), 'Phone');
  assert.equal(replay('phone-first'), 'Phone');
});

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

test('equally stamped edits converge in every order, even when one repeats the current value', () => {
  // Three devices, one base, one edit time. C asks for the value A already set, so in the order
  // A, C, B it changes nothing, yet it is still the newest edit and B must lose to it.
  const at = '2026-09-21T10:00:00.000Z';
  const wants = [
    { opId: 'op_aaaaaaaa', deviceId: 'device-a', title: 'Shared' },
    { opId: 'op_bbbbbbbb', deviceId: 'device-b', title: 'Other' },
    { opId: 'op_cccccccc', deviceId: 'device-c', title: 'Shared' },
  ];
  const results = permutations(wants).map((order) => {
    const { store, setNow } = storeAt('2026-09-21T08:00:00.000Z');
    const task = store.createTask({ title: 'Original' });
    order.forEach((w, i) => {
      setNow(`2026-09-21T1${2 + i}:00:00.000Z`);
      applyOutbox(store, [op({ opId: w.opId, deviceId: w.deviceId, kind: 'update_task', taskId: task.id, base: task.updatedAt, at, body: { title: w.title } })]);
    });
    return `${order.map((w) => w.opId.slice(-1)).join('')}: ${store.requireTask(task.id).title}`;
  });
  assert.deepEqual(results, ['abc: Shared', 'acb: Shared', 'bac: Shared', 'bca: Shared', 'cab: Shared', 'cba: Shared']);
});

test('a same-value op is not reported back to the device as holding anything', () => {
  const { store } = storeAt('2026-09-21T12:00:00.000Z');
  const task = store.createTask({ title: 'Same' });
  const same = op({ kind: 'update_task', taskId: task.id, base: task.updatedAt, body: { title: 'Same' } });
  const [first] = applyOutbox(store, [same]);
  const [again] = applyOutbox(store, [same]);
  assert.equal('held' in first, false);
  assert.equal('held' in again, false);
  assert.equal(again.status, 'duplicate');
});

test('a device never conflicts with its own earlier edits', () => {
  const { store, setNow } = storeAt('2026-09-21T08:00:00.000Z');
  const task = store.createTask({ title: 'Original' });
  setNow('2026-09-21T12:00:00.000Z');
  const results = applyOutbox(store, [
    op({ kind: 'update_task', taskId: task.id, base: task.updatedAt, at: '2026-09-21T10:00:00.000Z', body: { title: 'First try' } }),
    op({ kind: 'update_task', taskId: task.id, base: task.updatedAt, at: '2026-09-21T10:05:00.000Z', body: { title: 'Second try' } }),
  ]);
  assert.deepEqual(results.map((r) => r.status), ['applied', 'applied']);
  assert.equal(store.requireTask(task.id).title, 'Second try');
});

test('completing offline loses to a later reopen, and an edit time in the future is clamped', () => {
  const { store, setNow } = storeAt('2026-09-21T08:00:00.000Z');
  const task = store.createTask({ title: 'Ship it' });
  setNow('2026-09-21T11:00:00.000Z');
  store.updateTask(task.id, { status: 'waiting' });
  setNow('2026-09-21T12:00:00.000Z');
  const [lost] = applyOutbox(store, [op({ kind: 'complete_task', taskId: task.id, base: task.updatedAt, at: '2026-09-21T10:00:00.000Z' })]);
  assert.equal(lost.status, 'conflict');
  assert.equal(store.requireTask(task.id).status, 'waiting');

  // A phone whose clock runs a year ahead cannot win every merge forever.
  const base = store.requireTask(task.id).updatedAt;
  setNow('2026-09-21T13:00:00.000Z');
  store.updateTask(task.id, { title: 'Ship it soon' });
  setNow('2026-09-21T13:00:00.000Z');
  const [clamped] = applyOutbox(store, [op({ kind: 'update_task', taskId: task.id, base, at: '2027-09-21T10:00:00.000Z', body: { title: 'Clock is wrong' } })]);
  assert.equal(clamped.status, 'conflict');
  assert.equal(store.requireTask(task.id).title, 'Ship it soon');
});

test('a comment always lands, and a refused op does not stop the ones after it', () => {
  const { store } = storeAt('2026-09-21T12:00:00.000Z');
  const task = store.createTask({ title: 'Talk about it' });
  const results = applyOutbox(store, [
    op({ kind: 'update_task', taskId: 't_doesnotexi', body: { title: 'x' } }),
    op({ kind: 'update_task', taskId: task.id, base: task.updatedAt, body: { sourceType: 'github' } }),
    op({ kind: 'add_comment', taskId: task.id, base: task.updatedAt, body: { body: 'Noted on the train' } }),
  ]);
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected', 'applied']);
  assert.equal(store.listComments(task.id)[0].body, 'Noted on the train');
});

test('assignee is an offline-editable field: it applies, clears, merges per field, and loses to a newer live edit', () => {
  const { store, setNow } = storeAt('2026-09-21T08:00:00.000Z');
  const task = store.createTask({ title: 'Hand this off' });
  setNow('2026-09-21T12:00:00.000Z');
  const [set] = applyOutbox(store, [op({ kind: 'update_task', taskId: task.id, base: task.updatedAt, body: { assignee: 'scribe' } })]);
  assert.equal(set.status, 'applied');
  assert.equal(store.requireTask(task.id).assignee, 'scribe');

  // Cleared offline with null, like dueAt.
  const after = store.requireTask(task.id);
  setNow('2026-09-21T12:30:00.000Z');
  const [cleared] = applyOutbox(store, [op({ kind: 'update_task', taskId: task.id, base: after.updatedAt, at: '2026-09-21T12:10:00.000Z', body: { assignee: null } })]);
  assert.equal(cleared.status, 'applied');
  assert.equal(store.requireTask(task.id).assignee, null);

  // The PC assigns at 13:00; the phone had assigned someone else at 12:45 while offline. Newer wins,
  // and the title the phone also changed still lands, because the merge is per field.
  const base = store.requireTask(task.id).updatedAt;
  setNow('2026-09-21T13:00:00.000Z');
  store.updateTask(task.id, { assignee: 'reviewer' });
  setNow('2026-09-21T14:00:00.000Z');
  const [r] = applyOutbox(store, [op({ kind: 'update_task', taskId: task.id, base, at: '2026-09-21T12:45:00.000Z', body: { assignee: 'scribe', title: 'Hand this off today' } })]);
  assert.equal(r.status, 'conflict');
  assert.deepEqual(r.conflicts, [{ field: 'assignee', kept: 'reviewer', discarded: 'scribe' }]);
  const final = store.requireTask(task.id);
  assert.equal(final.assignee, 'reviewer');
  assert.equal(final.title, 'Hand this off today');
});

test('a task created offline keeps the assignee the device gave it', () => {
  const { store } = storeAt('2026-09-21T12:00:00.000Z');
  const [r] = applyOutbox(store, [op({ kind: 'create_task', taskId: 't_assign0001', body: { title: 'Made on the train', assignee: 'scribe' } })]);
  assert.equal(r.status, 'applied');
  assert.equal(store.requireTask('t_assign0001').assignee, 'scribe');
});

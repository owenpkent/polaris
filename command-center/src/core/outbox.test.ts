import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOnlineOnce, applyOutbox, openStore, type OutboxOp, type Store } from './index.ts';
import { nextOccurrence, todayIn } from '../automation/index.ts';

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

test('a task created offline keeps the number its device showed it at, so a move made beside it holds after replay', () => {
  const { store, setNow } = storeAt('2026-09-21T12:00:00.000Z');
  const a = store.createTask({ title: 'A' });
  const b = store.createTask({ title: 'B' });
  assert.deepEqual([a.position, b.position], [1, 2]);
  // The device's copy showed A(1), B(2). Offline, it made C after the last (3) and moved A below C (4).
  // Meanwhile the PC made E, which took 3 on the server: numbered afresh at replay, C would land on 4
  // beside A and the tie would put A back above it. C shares 3 with E instead and, made later, sorts after it.
  const e = store.createTask({ title: 'E' });
  assert.equal(e.position, 3);
  setNow('2026-09-21T12:30:00.000Z');
  const results = applyOutbox(store, [
    op({ kind: 'create_task', taskId: 't_offline0c1', body: { title: 'C', position: 3 } }),
    op({ kind: 'move_task', taskId: a.id, base: a.updatedAt, body: { position: 4 } }),
  ]);
  assert.deepEqual(results.map((r) => r.status), ['applied', 'applied']);
  assert.equal(store.requireTask('t_offline0c1').position, 3);
  assert.equal(store.requireTask(a.id).position, 4);
  const titles = store.searchTasks({ orderBy: 'position' }).map((t) => t.title);
  assert.ok(titles.indexOf('C') < titles.indexOf('A'), `A stays below C: ${titles.join(', ')}`);
  assert.deepEqual(titles.slice(0, 2), ['B', 'E']);
  // Without a number the created task goes last, as it does online.
  const [r] = applyOutbox(store, [op({ kind: 'create_task', taskId: 't_offline0d1', body: { title: 'D' } })]);
  assert.equal(r.status, 'applied');
  assert.equal(store.requireTask('t_offline0d1').position, 5);
});

test('a create whose answer was lost keeps the number the device sent with it, so a move made beside it holds', () => {
  const { store, setNow } = storeAt('2026-09-21T12:00:00.000Z');
  const a = store.createTask({ title: 'A' });
  store.createTask({ title: 'B' });
  // The device's copy showed A(1), B(2); the PC made E(3) unseen. The device's create of C carried
  // 3 (api.js sends the copy's next number with the first attempt) and was saved, but the answer
  // was lost. It then moved A below C (4), and replays both: the create is a duplicate, and must
  // leave C where the device showed it, or A would come out above C again.
  store.createTask({ title: 'E' });
  setNow('2026-09-21T12:30:00.000Z');
  const ident = { opId: 'op_lost_c0000001', deviceId: 'device-phone' };
  applyOnlineOnce(store, ident, () => {
    const task = store.createTask({ title: 'C' }, 'human', { id: 't_lostc00001', position: 3 });
    return { task, value: task };
  }, (id) => store.requireTask(id));
  const results = applyOutbox(store, [
    op({ ...ident, kind: 'create_task', taskId: 't_lostc00001', body: { title: 'C', position: 3 } }),
    op({ kind: 'move_task', taskId: a.id, base: a.updatedAt, body: { position: 4 } }),
  ]);
  assert.deepEqual(results.map((r) => r.status), ['duplicate', 'applied']);
  assert.equal(store.requireTask('t_lostc00001').position, 3);
  assert.deepEqual(store.searchTasks({ orderBy: 'position' }).map((t) => t.title), ['B', 'E', 'C', 'A']);
});

test('a Board move and a reorder of the same task, made on two devices, both hold in either replay order', () => {
  for (const order of ['reorder first', 'board first']) {
    const { store, setNow } = storeAt('2026-09-21T08:00:00.000Z');
    const project = store.createProject({ name: 'P' });
    const oldSection = store.ensureSection(project.id, 'Old');
    const newSection = store.ensureSection(project.id, 'New');
    const task = store.createTask({ title: 'T', projectId: project.id, sectionId: oldSection.id });
    store.createTask({ title: 'Other', projectId: project.id, sectionId: oldSection.id });
    setNow('2026-09-21T12:00:00.000Z');
    // From the same copy, the PC moved it to New at 10:00 and the phone gave it number 2 at 11:00.
    // Neither touched the other's field, so neither is a conflict, whichever reaches the server first.
    const board = op({ kind: 'move_task', taskId: task.id, deviceId: 'device-pc', base: task.updatedAt, at: '2026-09-21T10:00:00.000Z', body: { sectionId: newSection.id } });
    const reorder = op({ kind: 'move_task', taskId: task.id, deviceId: 'device-phone', base: task.updatedAt, at: '2026-09-21T11:00:00.000Z', body: { position: 2 } });
    const results = applyOutbox(store, order === 'reorder first' ? [reorder, board] : [board, reorder]);
    assert.deepEqual(results.map((r) => [r.status, r.conflicts]), [['applied', []], ['applied', []]], order);
    const after = store.requireTask(task.id);
    assert.deepEqual([after.sectionId, after.position], [newSection.id, 2], order);
  }
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

test('a task created offline from a share keeps its link and stays the owner\'s own text', () => {
  const { store } = storeAt('2026-09-21T12:00:00.000Z');
  const body = { title: 'Read this later', sourceUrl: 'https://example.com/post', sourceType: 'github' };
  const [r] = applyOutbox(store, [op({ kind: 'create_task', taskId: 't_share00001', body })]);
  assert.equal(r.status, 'applied');
  const task = store.requireTask('t_share00001');
  assert.equal(task.sourceUrl, 'https://example.com/post');
  // sourceType is not an offline field: the link alone never makes a task external or untrusted.
  assert.equal(task.sourceType, null);
  assert.equal(task.untrustedText, false);
  assert.notEqual(task.status, 'inbox');
});

test('a due time set offline is replayed as written, a create carries one too, and a replay changes nothing', () => {
  const { store, setNow } = storeAt('2026-09-21T08:00:00.000Z');
  const task = store.createTask({ title: 'Call the garage', dueAt: '2026-09-22' });
  setNow('2026-09-21T12:00:00.000Z');
  const edit = op({ kind: 'update_task', taskId: task.id, base: task.updatedAt, body: { dueAt: '2026-09-23T09:30' } });
  assert.equal(applyOutbox(store, [edit])[0].status, 'applied');
  assert.equal(store.requireTask(task.id).dueAt, '2026-09-23T09:30');
  assert.equal(applyOutbox(store, [edit])[0].status, 'duplicate');
  assert.equal(store.requireTask(task.id).dueAt, '2026-09-23T09:30');

  const create = op({ kind: 'create_task', taskId: 't_due0time01', body: { title: 'Made offline with a time', dueAt: '2026-09-24T17:15' } });
  assert.equal(applyOutbox(store, [create])[0].status, 'applied');
  assert.equal(store.requireTask('t_due0time01').dueAt, '2026-09-24T17:15');
});

test('a due time edited on both sides keeps the newer one and puts the other in history', () => {
  const { store, setNow } = storeAt('2026-09-21T08:00:00.000Z');
  const task = store.createTask({ title: 'Dentist', dueAt: '2026-09-22T09:00' });
  setNow('2026-09-21T11:00:00.000Z');
  store.updateTask(task.id, { dueAt: '2026-09-22T10:00' });
  setNow('2026-09-21T12:00:00.000Z');
  const [r] = applyOutbox(store, [op({ kind: 'update_task', taskId: task.id, base: task.updatedAt, at: '2026-09-21T10:00:00.000Z', body: { dueAt: '2026-09-22T08:00' } })]);
  assert.equal(r.status, 'conflict');
  assert.deepEqual(r.conflicts, [{ field: 'dueAt', kept: '2026-09-22T10:00', discarded: '2026-09-22T08:00' }]);
  assert.equal(store.requireTask(task.id).dueAt, '2026-09-22T10:00');
});

// A store with the real recurrence engine, its calendar on the given timezone, as app.ts wires it.
function recurringStoreAt(start: string, timezone = 'UTC'): { store: Store; setNow: (iso: string) => void } {
  let now = start;
  const store = openStore(':memory:', {
    now: () => now,
    today: () => todayIn(timezone, new Date(now)),
    dayOf: (iso) => todayIn(timezone, new Date(iso)),
    nextOccurrence: (rule, prev, context) => nextOccurrence(rule, prev, todayIn(timezone, new Date(now)), context),
  });
  return { store, setNow: (iso) => { now = iso; } };
}

const openSuccessor = (store: Store, title: string) => store.searchTasks({ text: title }).find((t) => t.status === 'open');

test('a completion replayed from the outbox counts the next occurrence from the day it was made, not the day it synced', () => {
  const { store, setNow } = recurringStoreAt('2026-10-14T08:00:00.000Z');
  const plants = store.createTask({ title: 'Water the plants', dueAt: '2026-10-14', recurrence: 'FREQ=DAILY;INTERVAL=3;X-FROM=COMPLETION' });
  const short = store.createTask({ title: 'Short series', dueAt: '2026-10-14', recurrence: 'FREQ=DAILY;INTERVAL=3;X-FROM=COMPLETION;UNTIL=20261017' });
  // Completed on the phone on the 14th, synced on the 16th.
  setNow('2026-10-16T09:00:00.000Z');
  const results = applyOutbox(store, [
    op({ kind: 'complete_task', taskId: plants.id, base: plants.updatedAt, at: '2026-10-14T18:00:00.000Z' }),
    op({ kind: 'complete_task', taskId: short.id, base: short.updatedAt, at: '2026-10-14T18:00:00.000Z' }),
  ]);
  assert.deepEqual(results.map((r) => r.status), ['applied', 'applied']);
  assert.equal(openSuccessor(store, 'Water the plants')?.dueAt, '2026-10-17', 'three days after the 14th, not the 16th');
  assert.equal(openSuccessor(store, 'Short series')?.dueAt, '2026-10-17', 'UNTIL the 17th still has room for it');
});

test('the offline completion day is read in the calendar timezone, and an online completion counts from today', () => {
  // 13:00 UTC on the 14th is already the 15th in Auckland.
  const { store, setNow } = recurringStoreAt('2026-10-14T08:00:00.000Z', 'Pacific/Auckland');
  const offline = store.createTask({ title: 'Offline in Auckland', dueAt: '2026-10-14', recurrence: 'FREQ=DAILY;INTERVAL=3;X-FROM=COMPLETION' });
  const online = store.createTask({ title: 'Online in Auckland', dueAt: '2026-10-14', recurrence: 'FREQ=DAILY;INTERVAL=3;X-FROM=COMPLETION' });
  setNow('2026-10-16T09:00:00.000Z');
  applyOutbox(store, [op({ kind: 'complete_task', taskId: offline.id, base: offline.updatedAt, at: '2026-10-14T13:00:00.000Z' })]);
  assert.equal(openSuccessor(store, 'Offline in Auckland')?.dueAt, '2026-10-18');
  store.completeTask(online.id);
  assert.equal(openSuccessor(store, 'Online in Auckland')?.dueAt, '2026-10-19', 'the 16th at 09:00 UTC is the 16th in Auckland, plus three');
});

test('a reorder made offline (a move with only a position) is applied on replay', () => {
  const { store, setNow } = storeAt('2026-09-21T08:00:00.000Z');
  const a = store.createTask({ title: 'a' });
  const b = store.createTask({ title: 'b' });
  const c = store.createTask({ title: 'c' });
  setNow('2026-09-21T12:00:00.000Z');
  const [r] = applyOutbox(store, [op({ kind: 'move_task', taskId: c.id, base: c.updatedAt, body: { position: (a.position + b.position) / 2 } })]);
  assert.equal(r.status, 'applied');
  assert.deepEqual(store.searchTasks({ orderBy: 'position' }).map((t) => t.title), ['a', 'c', 'b']);
});

test('an offline reorder loses to a newer move of the same task, and wins over an older one', () => {
  const { store, setNow } = storeAt('2026-09-21T08:00:00.000Z');
  const a = store.createTask({ title: 'a' });
  const b = store.createTask({ title: 'b' });
  const c = store.createTask({ title: 'c' });
  // The PC puts c first at 11:00; the phone had put it between a and b at 10:00.
  setNow('2026-09-21T11:00:00.000Z');
  store.moveTask(c.id, { position: a.position - 1 });
  setNow('2026-09-21T12:00:00.000Z');
  const [lost] = applyOutbox(store, [op({ kind: 'move_task', taskId: c.id, base: c.updatedAt, at: '2026-09-21T10:00:00.000Z', body: { position: (a.position + b.position) / 2 } })]);
  assert.equal(lost.status, 'conflict');
  assert.deepEqual(store.searchTasks({ orderBy: 'position' }).map((t) => t.title), ['c', 'a', 'b']);

  // The phone's reorder at 11:30 is newer than the PC's move, so it wins.
  const [won] = applyOutbox(store, [op({ kind: 'move_task', taskId: c.id, base: c.updatedAt, at: '2026-09-21T11:30:00.000Z', body: { position: (a.position + b.position) / 2 } })]);
  assert.equal(won.status, 'conflict');
  assert.deepEqual(won.conflicts.map((x) => x.field), ['position']);
  assert.deepEqual(store.searchTasks({ orderBy: 'position' }).map((t) => t.title), ['a', 'c', 'b']);
});

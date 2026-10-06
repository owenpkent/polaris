// Property tests for the offline outbox merge (core/outbox.ts), complementing the worked examples
// in outbox.test.ts. Each property states a rule the header of outbox.ts promises, and fast-check
// looks for an input that breaks it.
//
// Normal suite: a fixed seed and a modest run count, so the same inputs run every time and
// test:fast stays fast. Deep run (.github/workflows/nightly-properties.yml): CC_PROPERTY_SEED and
// CC_PROPERTY_RUNS come from the environment, so a nightly run explores new inputs.
//
// THE RULE when a property fails: fix the bug, then add the shrunk input as a named regression
// test in outbox.test.ts (a plain example, so it runs on every push). Do not loosen the property,
// and do not rerun until it passes. Replay a failure with the seed and path it prints:
//   CC_PROPERTY_SEED=<seed> CC_PROPERTY_PATH=<path> node --test src/core/outbox.property.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { PRIORITIES, applyOutbox, openStore, OUTBOX_OP_KINDS, type OutboxOp, type Store } from './index.ts';
import { outboxBodySchema } from '../http/schemas.ts';

const SEED = Number(process.env.CC_PROPERTY_SEED ?? 20260921);
const RUNS = Number(process.env.CC_PROPERTY_RUNS ?? 60);
const PATH = process.env.CC_PROPERTY_PATH;

/** Runs a property, and on failure throws a message that names the seed and path to replay it. */
function check<T>(arb: fc.Arbitrary<T>, predicate: (value: T) => void): void {
  const details = fc.check(
    fc.property(arb, (value) => { predicate(value); }),
    { seed: SEED, numRuns: RUNS, path: PATH, endOnFailure: false },
  );
  if (details.failed) {
    throw new Error(`property failed: seed=${details.seed} path=${details.counterexamplePath}\n${fc.defaultReportMessage(details)}`);
  }
}

const T0 = Date.parse('2026-09-21T08:00:00.000Z');
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();

/** A store whose clock is set by hand, with one task created at minute 0. */
function scenario(): { store: Store; setNow: (minute: number) => void; taskId: string; base: string } {
  let now = at(0);
  const store = openStore(':memory:', { now: () => now });
  const task = store.createTask({ title: 'Original' });
  return { store, setNow: (m) => { now = at(m); }, taskId: task.id, base: task.updatedAt };
}

const word = fc.constantFrom('Original', 'A', 'B', 'C', 'D');
const priority = fc.constantFrom(...PRIORITIES);

/** What one device wants to change, before it is given an id and a time. */
type Want =
  | { kind: 'update_task'; body: { title?: string; priority?: string } }
  | { kind: 'complete_task' | 'reopen_task'; body: Record<string, never> }
  | { kind: 'add_comment'; body: { body: string } };

const updateWant = fc.record({ title: word, priority }, { requiredKeys: [] })
  .filter((b) => Object.keys(b).length > 0)
  .map((body): Want => ({ kind: 'update_task', body }));
const statusWant = fc.constantFrom<Want>({ kind: 'complete_task', body: {} }, { kind: 'reopen_task', body: {} });
const commentWant = fc.string({ minLength: 1, maxLength: 8 }).filter((s) => s.trim().length > 0)
  .map((body): Want => ({ kind: 'add_comment', body: { body } }));

/** The fields a merge decides. Comments and history are compared separately where they matter. */
function fieldsOf(store: Store, taskId: string): { title: string; priority: string; status: string } {
  const t = store.requireTask(taskId);
  return { title: t.title, priority: t.priority, status: t.status };
}

// 1. Replaying ops that were already applied changes nothing.
test('property: replaying a batch is a no-op: every op is a duplicate and the store is unchanged', () => {
  const wants = fc.array(fc.tuple(fc.constantFrom('device-a', 'device-b', 'device-c'), fc.integer({ min: 0, max: 600 }), fc.oneof(updateWant, statusWant, commentWant)), { minLength: 1, maxLength: 6 });
  check(wants, (list) => {
    const { store, setNow, taskId, base } = scenario();
    const ops: OutboxOp[] = list.map(([deviceId, minute, want], i) => ({
      opId: `op_${String(i).padStart(8, '0')}`, deviceId, kind: want.kind, taskId, at: at(minute), base, body: want.body,
    }));
    setNow(700);
    const first = applyOutbox(store, ops);
    const snapshot = {
      fields: fieldsOf(store, taskId),
      events: store.taskHistory(taskId).length,
      comments: store.listComments(taskId).length,
      lastEvent: store.lastEventId(),
    };
    setNow(800);
    const again = applyOutbox(store, ops);
    assert.deepEqual(again.map((r) => r.status), ops.map(() => 'duplicate'));
    assert.deepEqual(again.map((r) => r.conflicts), first.map((r) => r.conflicts), 'a duplicate reports the original conflicts');
    assert.deepEqual(
      { fields: fieldsOf(store, taskId), events: store.taskHistory(taskId).length, comments: store.listComments(taskId).length, lastEvent: store.lastEventId() },
      snapshot,
    );
  });
});

// 2. Edits from different devices converge whatever order they arrive in.
test('property: edits from different devices end in the same state in any arrival order', () => {
  const edit = fc.tuple(fc.integer({ min: 0, max: 600 }), fc.oneof(updateWant, statusWant));
  const arb = fc.record({
    edits: fc.array(edit, { minLength: 2, maxLength: 4 }),
    order: fc.array(fc.nat(1000), { minLength: 4, maxLength: 4 }),
  });
  check(arb, ({ edits, order }) => {
    const ops = (taskId: string, base: string): OutboxOp[] => edits.map(([minute, want], i) => ({
      opId: `op_${String.fromCharCode(97 + i).repeat(8)}`, deviceId: `device-${i}`, kind: want.kind, taskId, at: at(minute), base, body: want.body,
    }));
    const run = (arrival: (list: OutboxOp[]) => OutboxOp[]) => {
      const { store, setNow, taskId, base } = scenario();
      arrival(ops(taskId, base)).forEach((o, i) => {
        setNow(700 + i * 60);
        applyOutbox(store, [o]);
      });
      return fieldsOf(store, taskId);
    };
    const inOrder = run((list) => list);
    const shuffled = run((list) => list.map((o, i) => ({ o, k: order[i], i })).sort((x, y) => x.k - y.k || x.i - y.i).map((x) => x.o));
    const reversed = run((list) => [...list].reverse());
    assert.deepEqual(shuffled, inOrder, 'a shuffled arrival order changed the result');
    assert.deepEqual(reversed, inOrder, 'the reverse arrival order changed the result');
  });
});

// 3. When both sides changed a field, the newer edit wins and the loser is written to history.
test('property: against a live edit, the newer edit wins and the loser is recorded as task.sync_conflict', () => {
  const arb = fc.record({
    live: fc.integer({ min: 1, max: 300 }),
    offline: fc.integer({ min: 0, max: 600 }),
    values: fc.tuple(fc.constantFrom('A', 'B', 'C'), fc.constantFrom('D', 'E', 'F')),
  });
  check(arb, ({ live, offline, values: [liveValue, offlineValue] }) => {
    const { store, setNow, taskId, base } = scenario();
    setNow(live);
    store.updateTask(taskId, { title: liveValue });
    setNow(700);
    const [r] = applyOutbox(store, [{ opId: 'op_00000001', deviceId: 'device-phone', kind: 'update_task', taskId, at: at(offline), base, body: { title: offlineValue } }]);
    // A live edit has no op id and wins a tie (outbox.ts, LIVE_KEY).
    const offlineWins = offline > live;
    const [kept, discarded] = offlineWins ? [offlineValue, liveValue] : [liveValue, offlineValue];
    assert.equal(r.status, 'conflict');
    assert.equal(store.requireTask(taskId).title, kept);
    assert.deepEqual(r.conflicts, [{ field: 'title', kept, discarded }]);
    const events = store.taskHistory(taskId).filter((e) => e.kind === 'task.sync_conflict');
    assert.equal(events.length, 1, 'exactly one conflict is recorded');
    assert.equal(events[0].payload.field, 'title');
    assert.equal(events[0].payload.kept, kept);
    assert.equal(events[0].payload.discarded, discarded);
  });
});

// 4. An edit nobody competed with applies, and a device never conflicts with itself.
test('property: one device editing alone never conflicts and ends on its latest edit', () => {
  const arb = fc.array(fc.tuple(fc.integer({ min: 0, max: 600 }), word), { minLength: 1, maxLength: 5 });
  check(arb, (edits) => {
    const { store, setNow, taskId, base } = scenario();
    setNow(700);
    const ops: OutboxOp[] = edits.map(([minute, title], i) => ({ opId: `op_${String(i).padStart(8, '0')}`, deviceId: 'device-phone', kind: 'update_task', taskId, at: at(minute), base, body: { title } }));
    const results = applyOutbox(store, ops);
    assert.ok(results.every((r) => r.status === 'applied'), JSON.stringify(results.map((r) => r.status)));
    assert.equal(store.requireTask(taskId).title, edits[edits.length - 1][1], 'ops of one device apply in the order sent');
    assert.equal(store.taskHistory(taskId).filter((e) => e.kind === 'task.sync_conflict').length, 0);
  });
});

// 5. The op kinds are a closed list.
test('property: the HTTP schema refuses any op kind outside the closed list', () => {
  const kind = fc.string({ maxLength: 20 }).filter((k) => !(OUTBOX_OP_KINDS as readonly string[]).includes(k));
  check(kind, (k) => {
    const parsed = outboxBodySchema.safeParse({
      deviceId: 'device-phone', ops: [{ opId: 'op_00000001', kind: k, taskId: 't_x', at: at(0), base: null, body: {} }],
    });
    assert.equal(parsed.success, false, `kind ${JSON.stringify(k)} was accepted`);
  });
});

// A kind outside the list that reaches the core anyway (the type says it cannot, but a caller that
// skips the schema, or a future second entry point, is not stopped by the type) must be refused
// and leave the task alone, not be read as an update.
//
// FINDING, left failing on purpose (todo): applyOne() ends with an `else` that treats every kind it
// does not know as update_task, so { kind: 'delete_task', body: { title: 'x' } } renames the task and
// reports 'applied'. Only the zod schema in http/schemas.ts keeps such a kind out today. The
// owner decides the fix (reject unknown kinds in applyOutbox); then remove `todo` below.
test('property: the core refuses an op kind outside the closed list and leaves the task alone', { todo: 'applyOne treats an unknown kind as update_task; only the HTTP schema stops it' }, () => {
  const kind = fc.oneof(
    fc.constantFrom('delete_task', 'accept_inbox', 'drop_task', 'reject_inbox', 'create_rule', 'update_goal', 'update_project'),
    fc.string({ maxLength: 12 }),
  ).filter((k) => !(OUTBOX_OP_KINDS as readonly string[]).includes(k));
  check(kind, (k) => {
    const { store, setNow, taskId, base } = scenario();
    setNow(700);
    const before = store.requireTask(taskId);
    const [r] = applyOutbox(store, [{ opId: 'op_00000001', deviceId: 'device-phone', kind: k as OutboxOp['kind'], taskId, at: at(10), base, body: { title: 'Changed by an unknown op' } }]);
    assert.equal(r.status, 'rejected', `kind ${JSON.stringify(k)} was ${r.status}`);
    assert.equal(store.requireTask(taskId).title, before.title);
  });
});

// 6. An inbox suggestion is never touched by an offline op.
test('property: no op kind changes a task that is still in the inbox', () => {
  const kind = fc.constantFrom(...OUTBOX_OP_KINDS.filter((k) => k !== 'create_task'));
  const body = fc.record({ title: word, priority, body: word, projectId: fc.constant(null) }, { requiredKeys: [] });
  check(fc.tuple(kind, body, fc.integer({ min: 0, max: 600 })), ([k, b, minute]) => {
    const store = openStore(':memory:');
    const task = store.upsertFromSource({ sourceType: 'github', sourceId: 'item-1', title: 'From GitHub', contentHash: 'a' }).task;
    assert.equal(task.status, 'inbox');
    const [r] = applyOutbox(store, [{ opId: 'op_00000001', deviceId: 'device-phone', kind: k, taskId: task.id, at: at(minute), base: task.updatedAt, body: b }]);
    assert.equal(r.status, 'rejected', `${k} was ${r.status}`);
    const after = store.requireTask(task.id);
    assert.equal(after.status, 'inbox');
    assert.equal(after.title, 'From GitHub');
    assert.equal(after.updatedAt, task.updatedAt);
    assert.equal(store.listComments(task.id).length, 0);
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './index.ts';
import { NotFoundError, ValidationError } from './store.ts';

// A clock the test can move: each call is one second later, and `advance` jumps it forward.
function fresh() {
  let offsetMs = 0;
  let tick = 0;
  const base = Date.UTC(2026, 9, 6, 12, 0, 0);
  const store = openStore(':memory:', { now: () => new Date(base + offsetMs + tick++ * 1000).toISOString() });
  return { store, advance: (ms: number) => { offsetMs += ms; } };
}

const HOUR = 60 * 60_000;

test('createUpdateRequest: the owner names a release and gets a pending row recorded as the human', () => {
  const { store } = fresh();
  const r = store.createUpdateRequest('2.1.0', 'human');
  assert.match(r.id, /^up_/);
  assert.equal(r.version, '2.1.0');
  assert.equal(r.state, 'pending');
  assert.equal(r.requestedBy, 'human');
  assert.equal(r.pickedUpAt, null);
  assert.equal(r.finishedAt, null);
  assert.equal(r.result, null);
  assert.deepEqual(store.getUpdateRequest(r.id), r);
  assert.deepEqual(store.currentUpdateRequest(), r);
  assert.equal(store.lastEventId(), 0, 'no event: an update is not a task');
});

test('createUpdateRequest: nobody but the owner, and only a strict MAJOR.MINOR.PATCH version', () => {
  const { store } = fresh();
  for (const actor of ['agent', 'system', 'rule'] as const) {
    assert.throws(() => store.createUpdateRequest('2.1.0', actor), /only the owner/);
  }
  assert.throws(() => store.createUpdateRequest('2.1.0', { actor: 'agent', name: 'scribe' }), /only the owner/);
  for (const bad of ['v2.1.0', '2.1', '2.1.0-rc1', '2.1.0 ', '', 'main', '2.1.0.1']) {
    assert.throws(() => store.createUpdateRequest(bad, 'human'), ValidationError, bad);
  }
  assert.throws(() => store.createUpdateRequest(undefined as never, 'human'), ValidationError);
  assert.equal(store.currentUpdateRequest(), null);
});

test('createUpdateRequest: one at a time, while a request is pending or picked up', () => {
  const { store } = fresh();
  const first = store.createUpdateRequest('2.1.0', 'human');
  assert.throws(() => store.createUpdateRequest('2.1.0', 'human'), /already pending/);
  store.pickUpUpdateRequest(first.id);
  assert.throws(() => store.createUpdateRequest('2.2.0', 'human'), /being installed/);
  store.finishUpdateRequest(first.id, true, 'Updated to v2.1.0');
  const second = store.createUpdateRequest('2.2.0', 'human');
  assert.notEqual(second.id, first.id);
  assert.equal(store.currentUpdateRequest()?.id, second.id);
});

test('cancelUpdateRequest: the owner takes a pending request back, and no one else', () => {
  const { store } = fresh();
  const r = store.createUpdateRequest('2.1.0', 'human');
  assert.throws(() => store.cancelUpdateRequest(r.id, 'agent'), /only the owner/);
  const cancelled = store.cancelUpdateRequest(r.id, 'human');
  assert.equal(cancelled.state, 'cancelled');
  assert.ok(cancelled.finishedAt);
  assert.throws(() => store.cancelUpdateRequest(r.id, 'human'), /cannot cancel .* cancelled; it must be pending/);
  assert.throws(() => store.cancelUpdateRequest('up_missing000', 'human'), NotFoundError);
  // A cancelled request is history: the owner can ask again.
  assert.equal(store.createUpdateRequest('2.1.0', 'human').state, 'pending');
});

test('cancelUpdateRequest: once the updater has it, the owner cannot take it back', () => {
  const { store } = fresh();
  const r = store.createUpdateRequest('2.1.0', 'human');
  store.pickUpUpdateRequest(r.id);
  assert.throws(() => store.cancelUpdateRequest(r.id, 'human'), /picked_up; it must be pending/);
});

test('pickUpUpdateRequest: moves only a pending row, once', () => {
  const { store } = fresh();
  const r = store.createUpdateRequest('2.1.0', 'human');
  const picked = store.pickUpUpdateRequest(r.id);
  assert.equal(picked.state, 'picked_up');
  assert.ok(picked.pickedUpAt);
  assert.throws(() => store.pickUpUpdateRequest(r.id), /cannot pick up .* picked_up/);
  assert.throws(() => store.pickUpUpdateRequest('up_missing000'), NotFoundError);
  store.finishUpdateRequest(r.id, false, 'Rolled back: the build failed');
  assert.throws(() => store.pickUpUpdateRequest(r.id), /failed/);
  const cancelled = store.createUpdateRequest('2.1.0', 'human');
  store.cancelUpdateRequest(cancelled.id, 'human');
  assert.throws(() => store.pickUpUpdateRequest(cancelled.id), /cancelled/);
});

test('finishUpdateRequest: a picked-up row ends done or failed with the result, and nothing else finishes', () => {
  const { store } = fresh();
  const r = store.createUpdateRequest('2.1.0', 'human');
  assert.throws(() => store.finishUpdateRequest(r.id, true, 'early'), /pending; it must be picked_up/);
  store.pickUpUpdateRequest(r.id);
  assert.throws(() => store.finishUpdateRequest(r.id, true, undefined as never), /needs a message/);
  const done = store.finishUpdateRequest(r.id, true, 'Updated to v2.1.0');
  assert.equal(done.state, 'done');
  assert.equal(done.result, 'Updated to v2.1.0');
  assert.ok(done.finishedAt);
  assert.throws(() => store.finishUpdateRequest(r.id, false, 'again'), /done; it must be picked_up/);
  assert.throws(() => store.finishUpdateRequest('up_missing000', true, 'x'), NotFoundError);

  const other = store.createUpdateRequest('2.2.0', 'human');
  store.pickUpUpdateRequest(other.id);
  assert.equal(store.finishUpdateRequest(other.id, false, 'Rolled back: the build failed').state, 'failed');
});

test('expireUpdateRequests: a pending row older than an hour expires, a younger one and a picked-up one do not', () => {
  const { store, advance } = fresh();
  const old = store.createUpdateRequest('2.1.0', 'human');
  assert.equal(store.expireUpdateRequests(), 0, 'just made');
  advance(HOUR - 60_000);
  assert.equal(store.expireUpdateRequests(), 0, 'not an hour yet');
  advance(2 * 60_000);
  assert.equal(store.expireUpdateRequests(), 1);
  const expired = store.getUpdateRequest(old.id)!;
  assert.equal(expired.state, 'expired');
  assert.ok(expired.finishedAt);
  assert.equal(store.expireUpdateRequests(), 0, 'already expired');

  const working = store.createUpdateRequest('2.1.0', 'human');
  store.pickUpUpdateRequest(working.id);
  advance(2 * HOUR);
  assert.equal(store.expireUpdateRequests(), 0, 'a picked-up request is the updater\'s however long it takes');
  assert.equal(store.getUpdateRequest(working.id)?.state, 'picked_up');
});

test('a pickup and an expiry cannot both win: whichever moves the row first is the one that counts', () => {
  // Expiry first: the row is gone from under the pickup.
  const a = fresh();
  const stale = a.store.createUpdateRequest('2.1.0', 'human');
  a.advance(HOUR + 1000);
  assert.equal(a.store.expireUpdateRequests(), 1);
  assert.throws(() => a.store.pickUpUpdateRequest(stale.id), /expired; it must be pending/);
  assert.equal(a.store.getUpdateRequest(stale.id)?.state, 'expired');

  // Pickup first: the sweep that runs a moment later finds nothing pending.
  const b = fresh();
  const claimed = b.store.createUpdateRequest('2.1.0', 'human');
  b.advance(HOUR + 1000);
  assert.equal(b.store.pickUpUpdateRequest(claimed.id).state, 'picked_up');
  assert.equal(b.store.expireUpdateRequests(), 0);
  assert.equal(b.store.getUpdateRequest(claimed.id)?.state, 'picked_up');
});

test('currentUpdateRequest: the newest row by request time, whatever its state', () => {
  const { store } = fresh();
  assert.equal(store.currentUpdateRequest(), null);
  const first = store.createUpdateRequest('2.1.0', 'human');
  store.cancelUpdateRequest(first.id, 'human');
  const second = store.createUpdateRequest('2.1.0', 'human');
  assert.equal(store.currentUpdateRequest()?.id, second.id);
  assert.equal(store.getUpdateRequest(first.id)?.state, 'cancelled', 'history is kept');
  assert.equal(store.getUpdateRequest('up_missing000'), null);
});

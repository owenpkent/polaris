import { describe, test } from 'node:test';
import { setImmediate as flushMacrotask } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { createScheduler, lastDailyAt, msUntilDailyAt, type JobResult } from './scheduler.ts';

/**
 * A fully controllable clock + timer pair. Nothing here uses real time, so the tests are
 * deterministic: time only passes when the test awaits `advance`. Advancing is async because a
 * job's `run()` resolves on a later microtask, and the scheduler only registers its *next* timer
 * (via a `.finally()`) after that resolves -- so we flush pending microtasks between each timer
 * we fire, or a fast-forward that should cross several ticks would only ever fire the first one.
 */
function fakeClock(startIso: string) {
  let virtualNow = new Date(startIso).getTime();
  let nextId = 1;
  const pending = new Map<number, { fn: () => void; due: number }>();

  const now = () => new Date(virtualNow);
  const setTimeoutFn = (fn: () => void, ms: number): unknown => {
    const id = nextId++;
    pending.set(id, { fn, due: virtualNow + ms });
    return id;
  };
  const clearTimeoutFn = (handle: unknown): void => {
    pending.delete(handle as number);
  };

  async function advance(ms: number): Promise<void> {
    const target = virtualNow + ms;
    for (;;) {
      await flushMacrotask(); // let any scheduleNext() from the previous fire register its timer
      let next: [number, { fn: () => void; due: number }] | undefined;
      for (const entry of pending) if (entry[1].due <= target && (!next || entry[1].due < next[1].due)) next = entry;
      if (!next) break;
      pending.delete(next[0]);
      virtualNow = next[1].due;
      next[1].fn();
    }
    virtualNow = target;
    await flushMacrotask();
  }

  return { now, setTimeoutFn, clearTimeoutFn, advance };
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

test('everyMs job runs on schedule and records results via the callback', async () => {
  const clock = fakeClock('2026-09-12T00:00:00.000Z');
  let runs = 0;
  const results: JobResult[] = [];
  const scheduler = createScheduler({
    jobs: [{ name: 'tick', everyMs: 1000, run: async () => { runs++; } }],
    timezone: 'UTC',
    now: clock.now,
    setTimeout: clock.setTimeoutFn,
    clearTimeout: clock.clearTimeoutFn,
    onResult: (r) => results.push(r),
  });

  await clock.advance(1000);
  assert.equal(runs, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);

  await clock.advance(3000); // three more ticks
  assert.equal(runs, 4);

  scheduler.stop();
  await clock.advance(10_000);
  assert.equal(runs, 4, 'no more runs after stop()');
});

test('a slow run is never overlapped by a second concurrent run', async () => {
  const clock = fakeClock('2026-09-12T00:00:00.000Z');
  let starts = 0;
  let finishes = 0;
  const gate = deferred();
  const scheduler = createScheduler({
    jobs: [{
      name: 'slow',
      everyMs: 1000,
      run: async () => { starts++; await gate.promise; finishes++; },
    }],
    timezone: 'UTC',
    now: clock.now,
    setTimeout: clock.setTimeoutFn,
    clearTimeout: clock.clearTimeoutFn,
  });

  // Manually trigger the same job twice while the first run is still in flight -- this is the
  // realistic overlap scenario (a manual runNow while a scheduled run is executing).
  const first = scheduler.runNow('slow');
  const second = scheduler.runNow('slow');
  await flushMacrotask();
  assert.equal(starts, 1, 'the second concurrent call must not start a new run');

  gate.resolve();
  await first;
  await second;
  assert.equal(finishes, 1);
  scheduler.stop();
});

test('per-job error isolation: one job failing does not affect another', async () => {
  const clock = fakeClock('2026-09-12T00:00:00.000Z');
  const results: JobResult[] = [];
  const scheduler = createScheduler({
    jobs: [
      { name: 'bad', everyMs: 1000, run: async () => { throw new Error('boom'); } },
      { name: 'good', everyMs: 1000, run: async () => { /* ok */ } },
    ],
    timezone: 'UTC',
    now: clock.now,
    setTimeout: clock.setTimeoutFn,
    clearTimeout: clock.clearTimeoutFn,
    onResult: (r) => results.push(r),
  });

  await clock.advance(1000);

  const bad = results.find((r) => r.name === 'bad');
  const good = results.find((r) => r.name === 'good');
  assert.equal(bad?.ok, false);
  assert.match(bad?.error ?? '', /boom/);
  assert.equal(good?.ok, true);

  await clock.advance(1000);
  assert.equal(results.filter((r) => r.name === 'good').length, 2, 'the good job keeps running after the bad one failed');
  scheduler.stop();
});

test('dailyAt schedules the next run for that time of day, and again 24h later', async () => {
  const clock = fakeClock('2026-09-12T07:00:00.000Z'); // 07:00 UTC
  let runs = 0;
  const scheduler = createScheduler({
    jobs: [{ name: 'daily', dailyAt: '08:00', run: async () => { runs++; } }],
    timezone: 'UTC',
    now: clock.now,
    setTimeout: clock.setTimeoutFn,
    clearTimeout: clock.clearTimeoutFn,
  });

  await clock.advance(59 * 60 * 1000); // 07:59, not yet
  assert.equal(runs, 0);

  await clock.advance(60 * 1000); // 08:00
  assert.equal(runs, 1);

  await clock.advance(24 * 60 * 60 * 1000); // next day, 08:00 again
  assert.equal(runs, 2);
  scheduler.stop();
});

test('lastResults reflects the most recent run per job', async () => {
  const clock = fakeClock('2026-09-12T00:00:00.000Z');
  const scheduler = createScheduler({
    jobs: [{ name: 'x', everyMs: 1000, run: async () => 'value' }],
    timezone: 'UTC',
    now: clock.now,
    setTimeout: clock.setTimeoutFn,
    clearTimeout: clock.clearTimeoutFn,
  });
  assert.equal(scheduler.lastResults().x, undefined);
  await clock.advance(1000);
  assert.equal(scheduler.lastResults().x?.ok, true);
  scheduler.stop();
});

test('createScheduler rejects a job with both or neither of everyMs/dailyAt', () => {
  assert.throws(() => createScheduler({ jobs: [{ name: 'x', run: async () => {} }], timezone: 'UTC' }));
  assert.throws(() => createScheduler({
    jobs: [{ name: 'x', everyMs: 1000, dailyAt: '08:00', run: async () => {} }],
    timezone: 'UTC',
  }));
});

// dailyAt has to resolve a real instant, not a difference of wall-clock minutes. On a DST
// transition day "eight hours on the clock" is seven or nine real hours, and the old arithmetic
// waited eight, so the digest ran an hour late in spring and an hour early in autumn.
describe('msUntilDailyAt across a DST transition', () => {
  const NY = 'America/New_York';
  const hoursUntil = (from: string, at: string, tz = NY) => msUntilDailyAt(at, tz, new Date(from)) / 3_600_000;

  test('an ordinary day is the plain number of hours', () => {
    // 2027-06-15 23:00 EDT is 03:00Z on the 16th; 07:00 EDT is 11:00Z. Eight hours.
    assert.equal(hoursUntil('2027-06-16T03:00:00Z', '07:00'), 8);
  });

  test('spring forward: the clock loses an hour, so the wait is an hour shorter', () => {
    // 2027-03-13 23:00 EST = 04:00Z on the 14th. DST starts at 02:00 local that night, so
    // 07:00 EDT on the 14th is 11:00Z: seven real hours, not eight.
    assert.equal(hoursUntil('2027-03-14T04:00:00Z', '07:00'), 7);
  });

  test('fall back: the clock gains an hour, so the wait is an hour longer', () => {
    // 2027-11-06 23:00 EDT = 03:00Z on the 7th. DST ends at 02:00 local that night, so
    // 07:00 EST on the 7th is 12:00Z: nine real hours.
    assert.equal(hoursUntil('2027-11-07T03:00:00Z', '07:00'), 9);
  });

  test('a time already past today lands on tomorrow, not on a negative wait', () => {
    const ms = msUntilDailyAt('07:00', NY, new Date('2027-06-16T12:00:00Z')); // 08:00 EDT
    assert.ok(ms > 0);
    assert.equal(ms / 3_600_000, 23);
  });

  test('UTC is unaffected, and midnight resolves rather than landing a day out', () => {
    assert.equal(hoursUntil('2027-06-16T23:00:00Z', '00:00', 'UTC'), 1);
    assert.equal(hoursUntil('2027-06-16T00:30:00Z', '00:00', 'UTC'), 23.5);
  });

  test('lastDailyAt is the most recent instant at or before now, across the same transitions', () => {
    assert.equal(lastDailyAt('04:00', 'UTC', new Date('2027-06-16T04:30:00Z')).toISOString(), '2027-06-16T04:00:00.000Z');
    assert.equal(lastDailyAt('04:00', 'UTC', new Date('2027-06-16T04:00:00Z')).toISOString(), '2027-06-16T04:00:00.000Z', 'at the moment itself');
    assert.equal(lastDailyAt('04:00', 'UTC', new Date('2027-06-16T03:59:00Z')).toISOString(), '2027-06-15T04:00:00.000Z', 'a minute before is yesterday');
    // 07:00 EDT on 2027-03-14 is 11:00Z; from 12:00Z that day, the last 07:00 was an hour ago; the one before, 08:00Z on the 13th (EST).
    assert.equal(lastDailyAt('07:00', NY, new Date('2027-03-14T12:00:00Z')).toISOString(), '2027-03-14T11:00:00.000Z');
    assert.equal(lastDailyAt('07:00', NY, new Date('2027-03-14T10:00:00Z')).toISOString(), '2027-03-13T12:00:00.000Z');
    assert.throws(() => lastDailyAt('4:00', 'UTC', new Date()), /expected 'HH:MM'/);
    assert.throws(() => lastDailyAt('24:00', 'UTC', new Date()), /expected 'HH:MM'/);
  });

  test('a malformed time is still rejected', () => {
    assert.throws(() => msUntilDailyAt('8:00', NY, new Date()));
    assert.throws(() => msUntilDailyAt('25:00', NY, new Date()));
  });
});

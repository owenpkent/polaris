// JavaScript's own RegExp, run with a budget it cannot exceed, as the reference the pattern target
// compares Polaris's bounded matcher against. RegExp backtracks: ^((a*)*)*$ on twenty-three "a"s
// and a "!" runs for longer than the fuzzer's per-input timeout, and it is the reference that is
// slow, not the code under test, so without a bound the nightly run would stop on a false timeout
// (review of #112). The regex runs in a worker thread; this thread waits on a shared cell for at
// most `budgetMs`, and on a timeout kills the worker (V8 interrupts a running regex when the
// isolate is terminated) and starts a fresh one for the next call. The result is then
// 'timeout', which the target treats as no comparison. Starting a worker is not part of the budget:
// a new one signals once it listens, and only then does the clock start, so a slow machine does not
// turn a trivial pattern into a timeout.
import { Worker } from 'node:worker_threads';

export type OracleResult = boolean | 'syntax' | 'timeout';

/** How long a new worker may take to start before the call goes ahead on the regex budget alone. */
const STARTUP_MS = 10_000;

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const ready = new Int32Array(workerData.ready);
parentPort.on('message', ({ cell, pattern, text }) => {
  const a = new Int32Array(cell);
  let result;
  try {
    result = new RegExp(pattern).test(text) ? 1 : 0;
  } catch {
    result = 2;
  }
  Atomics.store(a, 1, result);
  Atomics.store(a, 0, 1);
  Atomics.notify(a, 0);
});
Atomics.store(ready, 0, 1);
Atomics.notify(ready, 0);
`;

let worker: Worker | null = null;
let timeouts = 0;

function current(): Worker {
  if (!worker) {
    const ready = new SharedArrayBuffer(4);
    worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { ready } });
    // The worker must not keep a test process alive once the test is done.
    worker.unref();
    Atomics.wait(new Int32Array(ready), 0, 0, STARTUP_MS);
  }
  return worker;
}

/** How many times the reference regex ran out of budget since the process started. */
export function oracleTimeouts(): number {
  return timeouts;
}

/**
 * `new RegExp(pattern).test(text)` within `budgetMs`, or 'syntax' when RegExp refuses the pattern,
 * or 'timeout' when it did not answer in time. Synchronous, so it fits a sync fuzz target.
 */
export function regexWithin(pattern: string, text: string, budgetMs = 250): OracleResult {
  const cell = new SharedArrayBuffer(8);
  const a = new Int32Array(cell);
  const w = current();
  w.postMessage({ cell, pattern, text });
  if (Atomics.wait(a, 0, 0, budgetMs) === 'timed-out') {
    timeouts += 1;
    void w.terminate();
    worker = null;
    return 'timeout';
  }
  const result = Atomics.load(a, 1);
  return result === 2 ? 'syntax' : result === 1;
}

/** Stops the worker. Tests call it so nothing lingers; a fuzz run just exits. */
export async function stopOracle(): Promise<void> {
  if (worker) {
    await worker.terminate();
    worker = null;
  }
}

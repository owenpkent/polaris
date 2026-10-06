// A generic in-process job runner. Not wired to any concrete jobs here -- the integrator supplies
// the job list (digest generation, ingestion polls, rule runs) elsewhere; this module only knows
// how to run named jobs on a schedule, one at a time each, with isolated failures.

export interface JobSpec {
  name: string;
  run: () => Promise<unknown>;
  /** Run every N ms. Exactly one of `everyMs` / `dailyAt` must be set. */
  everyMs?: number;
  /** Run once a day at this local time ("HH:MM", 24h), in `SchedulerOptions.timezone`. */
  dailyAt?: string;
}

export interface JobResult {
  name: string;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  error?: string;
}

export interface SchedulerOptions {
  jobs: JobSpec[];
  /** IANA timezone used to interpret `dailyAt`. */
  timezone: string;
  /** Injectable clock, for deterministic tests. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Injectable timer, for deterministic tests. Defaults to the real `setTimeout`. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  /** Injectable timer cancellation, matching `setTimeout`. Defaults to the real `clearTimeout`. */
  clearTimeout?: (handle: unknown) => void;
  /** Called after every job run (success or failure) with its result. */
  onResult?: (result: JobResult) => void;
}

export interface Scheduler {
  /** Cancel all pending timers. Runs already in flight are left to finish. */
  stop(): void;
  /** The most recent result recorded for each job (undefined if it has not run yet). */
  lastResults(): Record<string, JobResult | undefined>;
  /** Run a job immediately, respecting the same no-overlap guard as the schedule. */
  runNow(name: string): Promise<void>;
}

/** The zone's offset from UTC, in milliseconds, at a given instant. */
function zoneOffsetMs(ts: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(ts));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  // Some ICU builds render midnight as hour 24; normalise so the arithmetic is not a day out.
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - ts;
}

/** The instant at which the given wall-clock time occurs in the zone, resolved by fixpoint. */
function zonedWallTimeToUtc(y: number, mo: number, d: number, hh: number, mm: number, timezone: string): number {
  const wall = Date.UTC(y, mo - 1, d, hh, mm, 0);
  // Two passes: the first uses the offset at the wrong instant, the second at one that is within
  // an hour of the answer, which is enough for every real zone rule.
  let ts = wall - zoneOffsetMs(wall, timezone);
  ts = wall - zoneOffsetMs(ts, timezone);
  return ts;
}

/** The zone's calendar date `dayOffset` days after the given instant. */
function zonedDatePlus(ts: number, timezone: string, dayOffset: number): { y: number; mo: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ts));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  // Day arithmetic on the calendar date, not on the instant, so a DST day is still one day.
  const shifted = new Date(Date.UTC(get('year'), get('month') - 1, get('day') + dayOffset));
  return { y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() };
}

/**
 * Milliseconds until the next time it is `hhmm` in `timezone`.
 *
 * Resolved as a real instant rather than as a difference of wall-clock minutes. The old arithmetic
 * took "eight hours on the clock" and waited eight real hours, which is an hour wrong on each DST
 * transition day: the digest ran at 08:00 in the spring and 06:00 in the autumn.
 */
export function msUntilDailyAt(hhmm: string, timezone: string, now: Date): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`invalid dailyAt '${hhmm}': expected 'HH:MM'`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) throw new Error(`invalid dailyAt '${hhmm}': expected 'HH:MM'`);

  const from = now.getTime();
  // Today, then tomorrow. A third day is only reachable if a zone skipped the hour entirely,
  // in which case the fixpoint lands after it and today's candidate is already in the past.
  for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
    const { y, mo, d } = zonedDatePlus(from, timezone, dayOffset);
    const ts = zonedWallTimeToUtc(y, mo, d, hh, mm, timezone);
    if (ts > from) return ts - from;
  }
  return 24 * 60 * 60 * 1000;
}

/**
 * The most recent instant, at or before `now`, at which it was `hhmm` in `timezone`: the start of
 * the current daily slot. The counterpart of msUntilDailyAt, resolved the same way, so a DST day
 * gives the right instant too. `cc update --auto` uses it for its quiet window.
 */
export function lastDailyAt(hhmm: string, timezone: string, now: Date): Date {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`invalid dailyAt '${hhmm}': expected 'HH:MM'`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) throw new Error(`invalid dailyAt '${hhmm}': expected 'HH:MM'`);
  const from = now.getTime();
  for (let dayOffset = 0; dayOffset >= -2; dayOffset--) {
    const { y, mo, d } = zonedDatePlus(from, timezone, dayOffset);
    const ts = zonedWallTimeToUtc(y, mo, d, hh, mm, timezone);
    if (ts <= from) return new Date(ts);
  }
  return new Date(from - 24 * 60 * 60 * 1000);
}


export function createScheduler(opts: SchedulerOptions): Scheduler {
  for (const job of opts.jobs) {
    if ((job.everyMs === undefined) === (job.dailyAt === undefined)) {
      throw new Error(`job '${job.name}': specify exactly one of everyMs or dailyAt`);
    }
  }

  const now = opts.now ?? (() => new Date());
  const setTimeoutFn = opts.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimeoutFn = opts.clearTimeout ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));

  const running = new Set<string>();
  const results = new Map<string, JobResult>();
  const timers = new Map<string, unknown>();
  let stopped = false;

  async function execute(job: JobSpec): Promise<void> {
    if (running.has(job.name)) return; // no overlapping runs of the same job
    running.add(job.name);
    const startedAt = now().toISOString();
    let result: JobResult;
    try {
      await job.run();
      result = { name: job.name, startedAt, finishedAt: now().toISOString(), ok: true };
    } catch (e) {
      result = { name: job.name, startedAt, finishedAt: now().toISOString(), ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    running.delete(job.name);
    results.set(job.name, result);
    opts.onResult?.(result);
  }

  function delayFor(job: JobSpec): number {
    return job.dailyAt !== undefined ? msUntilDailyAt(job.dailyAt, opts.timezone, now()) : (job.everyMs as number);
  }

  function scheduleNext(job: JobSpec): void {
    if (stopped) return;
    const handle = setTimeoutFn(() => {
      void execute(job).finally(() => scheduleNext(job));
    }, delayFor(job));
    timers.set(job.name, handle);
  }

  for (const job of opts.jobs) scheduleNext(job);

  return {
    stop(): void {
      stopped = true;
      for (const handle of timers.values()) clearTimeoutFn(handle);
      timers.clear();
    },
    lastResults(): Record<string, JobResult | undefined> {
      const out: Record<string, JobResult | undefined> = {};
      for (const job of opts.jobs) out[job.name] = results.get(job.name);
      return out;
    },
    async runNow(name: string): Promise<void> {
      const job = opts.jobs.find((j) => j.name === name);
      if (!job) throw new Error(`no such job '${name}'`);
      await execute(job);
    },
  };
}

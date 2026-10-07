// `cc update --auto`, the scheduled updater (docs/update-proposal.md, section 3). The OS runs it
// every five minutes (scripts/install-updater-task.ps1, scripts/install-updater-systemd.sh), as
// the owner, outside the daemon, and each run is cheap when there is nothing to do. It installs
// only signed releases, never `main`, and only a version strictly newer than the running one; it
// never asks a question. One run, in order:
//
//   1. the heartbeat: the status file gets `updaterInstalled` and `lastRunAt`, which is what
//      "the updater is installed" means to the daemon and the panel;
//   2. the daemon is asked, over loopback with the api token, for the owner's update request
//      (GET /api/update). A daemon that does not answer ends the run: there is nothing to restart
//      into, and the status file says so;
//   3. a pending request is picked up on any run, backed off or stopped or not: the owner's click
//      is the override. Pickup is one guarded UPDATE in the daemon, so two runs cannot both take
//      it; the install goes through the same path as `cc update --to`, which re-verifies the tag
//      against the pinned signers and requires it strictly newer, and the request is finished
//      with the outcome. If the daemon cannot be reached afterwards the status file's `request`
//      entry carries the outcome and the daemon reconciles from it. A request the daemon has
//      expired because an earlier run was killed mid-install is taken as finished;
//   4. with no request, and only when not backed off or stopped, the daily check: inside the
//      quiet window (one hour from CC_UPDATE_AT, 04:00 by default, in the daemon's timezone) the
//      tags are fetched once and the newest verified newer release is installed at once; outside
//      it, `available` is refreshed once a day without installing. Every attempt, a refusal
//      included, records `lastCheckAt`, so the throttle holds and a refusal is not retried every
//      five minutes;
//   5. after a failed install, the backoff ladder: a day, then three days, then the updater stops
//      and waits for the owner (`cc update --release` by hand clears the count). A request that
//      succeeds during a pause clears the count too; one that fails leaves the ladder where it is.
//
// Every program runs through the Exec seam in run.ts, and the daemon's routes through the injected
// fetch, so auto.test.ts runs the whole thing with nothing real started. This module imports no
// secret store and sends no credential anywhere but the api token to the loopback daemon.
import { lastDailyAt } from '../automation/scheduler.ts';
import { resolveTokens } from '../http/token.ts';
import { releaseTag } from './releases.ts';
import { defaultDeps, openLog, performUpdate, type Log, type UpdateDeps, type UpdateOutcome, type UpdateTarget } from './run.ts';
import { readUpdateStatus, UPDATER_STOPPED_AFTER, UPDATER_STOPPED_PREFIX, updaterStopped, writeUpdateStatus, type UpdateRequestState, type UpdateStatus } from './status.ts';
import { isVersion } from './version.ts';

export { defaultDeps } from './run.ts';

export const DEFAULT_UPDATE_AT = '04:00';
/** The quiet window: this long from CC_UPDATE_AT. */
export const QUIET_WINDOW_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** Outside the window, `available` is refreshed once this much time has passed since the last check. */
export const CHECK_INTERVAL_MS = DAY_MS;
/** No automatic install for this long after the first failure in a row, then the second; the
 *  third (UPDATER_STOPPED_AFTER) stops the updater. */
export const BACKOFF_MS = [DAY_MS, 3 * DAY_MS];

/** The status file's `problem` after a check or install the run could not make: a refusal (an
 *  untracked file, another branch, no restart method) or a failure before anything changed (a
 *  fetch that did not answer). It stays until the next check, which the throttle times, unlike a
 *  daemon problem, which the next run that reaches the daemon clears. */
export const CHECK_PROBLEM_PREFIX = /^(Refused|Failed before anything changed): /;

export interface AutoOptions {
  repoRoot: string;
  dbPath: string;
  dashboardDir: string;
  port: number;
  /** The daemon's timezone (config.timezone), which CC_UPDATE_AT is read in. */
  timezone: string;
  /** CC_UPDATE_AT, "HH:MM"; undefined means DEFAULT_UPDATE_AT. */
  updateAt?: string;
  /** CC_UPDATE_RESTART, or undefined to detect the restart method. */
  restartSpec?: string;
  remote?: string;
  branch?: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/** What the daemon says about the current request, as far as the updater needs it. */
interface DaemonRequest { id: string; version: string; state: UpdateRequestState; result: string | null; finishedAt: string | null }

type DaemonAnswer = { ok: true; status: number; body: unknown } | { ok: false; status: number | null; problem: string };

/** Whether `now` is inside the quiet window that starts at `updateAt`, and when that window opened. */
export function quietWindow(updateAt: string, timezone: string, now: Date): { open: boolean; start: Date } {
  const start = lastDailyAt(updateAt, timezone, now);
  return { open: now.getTime() - start.getTime() < QUIET_WINDOW_MS, start };
}

/** One scheduled run. Exit 0 when there was nothing to do or the install succeeded, 1 when an
 *  install was refused or rolled back, 2 when the rollback failed too. */
export async function runAuto(opts: AutoOptions, deps: UpdateDeps = defaultDeps()): Promise<number> {
  const updateAt = opts.updateAt ?? DEFAULT_UPDATE_AT;
  const now = deps.now();
  let window: { open: boolean; start: Date };
  try {
    window = quietWindow(updateAt, opts.timezone, now);
  } catch {
    opts.stderr(`cc update --auto: CC_UPDATE_AT is "${updateAt}". Use HH:MM, such as 04:00. Nothing checked.`);
    return 1;
  }
  const patch = (changes: Partial<UpdateStatus>): UpdateStatus => {
    const next = { ...readUpdateStatus(opts.dbPath), ...changes };
    writeUpdateStatus(opts.dbPath, next);
    return next;
  };
  let log: Log | null = null;
  const say: Log = (line, to) => { log ??= openLog(opts, deps); log(`cc update --auto: ${line}`, to); };

  // 1. The heartbeat. A pause (a backoff that has not passed, or the updater stopped) is noted,
  // not acted on yet: the owner's request (step 3) goes through it; the daily check (step 4) does not.
  const status = patch({ updaterInstalled: true, lastRunAt: now.toISOString() });
  const stopped = updaterStopped(status);
  const paused = stopped || (status.backoffUntil !== null && Date.parse(status.backoffUntil) > now.getTime());

  // 2. The daemon, and the owner's request.
  const base = `http://127.0.0.1:${opts.port}`;
  const token = resolveTokens(opts.dbPath, deps.env).api;
  const ask = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<DaemonAnswer> => {
    let res: Response;
    try {
      res = await deps.fetch(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      return { ok: false, status: null, problem: `the daemon is not answering on port ${opts.port} (${e instanceof Error ? e.message : String(e)})` };
    }
    const parsed: unknown = await res.json().catch(() => null);
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, body: parsed };
    const detail = typeof parsed === 'object' && parsed !== null && 'error' in parsed ? (parsed as { error?: { message?: unknown } }).error?.message : undefined;
    return { ok: false, status: res.status, problem: `${method} ${path} answered ${res.status}${typeof detail === 'string' ? ` (${detail})` : ''}` };
  };

  const current = await ask('GET', '/api/update');
  if (!current.ok) {
    // A new problem is said once; the file carries it from then on.
    if (status.problem !== current.problem) opts.stderr(`cc update --auto: ${current.problem}. Nothing installed: there is no daemon to restart into.`);
    patch({ problem: current.problem });
    return 0;
  }
  // The daemon answers: a daemon problem is over. A check problem stays until the next check.
  if (status.problem && !CHECK_PROBLEM_PREFIX.test(status.problem)) patch({ problem: null });

  // A request an earlier run picked up and never finished (that run was stopped or killed) is
  // the daemon's to expire, and the owner's to cancel; the file's entry still says Updating.
  // Take the daemon's word for it, so the file and the panel agree and the row is history.
  const seen = requestOf(current.body);
  if (seen && status.request?.id === seen.id && status.request.state === 'picked_up' && seen.state !== 'pending' && seen.state !== 'picked_up') {
    say(`the request ${seen.id}, picked up by an earlier run that did not finish, is ${seen.state}.`, 'stderr');
    patch({ request: { id: seen.id, state: seen.state, message: seen.result ?? `The request was ${seen.state}.`, finishedAt: seen.finishedAt } });
  }

  const install = async (target: UpdateTarget, why: 'request' | 'daily'): Promise<UpdateOutcome> => {
    const outcome = await performUpdate({
      repoRoot: opts.repoRoot, dbPath: opts.dbPath, dashboardDir: opts.dashboardDir, port: opts.port,
      target, checkOnly: false, yes: true, auto: true, restartSpec: opts.restartSpec, remote: opts.remote, branch: opts.branch,
      stdout: opts.stdout, stderr: opts.stderr,
    }, deps);
    recordBackoff(outcome, why);
    return outcome;
  };

  // 3. The owner's request, on any run: a pause is the updater's own caution, and the owner's
  // click overrides it.
  if (seen?.state === 'pending') {
    const request = seen;
    const picked = await ask('POST', `/api/update/requests/${encodeURIComponent(request.id)}/pickup`);
    if (picked.ok) {
      say(`picked up the request ${request.id} for ${releaseTag(request.version)}${paused ? ' (the owner\'s request goes through the pause)' : ''}.`);
      patch({ request: { id: request.id, state: 'picked_up', message: 'Updating', finishedAt: null } });
      const outcome = await install({ kind: 'to', version: request.version }, 'request');
      const ok = outcome.kind === 'updated';
      const message = ok ? `Updated to ${releaseTag(request.version)}` : outcome.message;
      patch({ request: { id: request.id, state: ok ? 'done' : 'failed', message, finishedAt: deps.now().toISOString() }, problem: checkProblem(outcome) });
      const finished = await ask('POST', `/api/update/requests/${encodeURIComponent(request.id)}/finish`, { ok, message });
      if (!finished.ok) say(`${finished.problem}; the status file carries the outcome of request ${request.id} and the daemon takes it from there.`, 'stderr');
      return outcome.code;
    }
    // 409: the row moved first (expired, cancelled, or taken by another run). Anything else is
    // the daemon's problem to report; this run carries on to the daily check.
    say(picked.status === 409 ? `the request ${request.id} was gone before it could be picked up (${picked.problem}).` : `could not pick up the request ${request.id}: ${picked.problem}`, 'stderr');
  }

  // 4. The daily check, which a pause does hold back.
  if (paused) return 0;
  const lastCheck = status.lastCheckAt ? Date.parse(status.lastCheckAt) : NaN;
  if (window.open) {
    if (Number.isFinite(lastCheck) && lastCheck >= window.start.getTime()) return 0;
    say(`the quiet window (${updateAt} ${opts.timezone}, one hour) is open: looking for a newer signed release.`);
    return recordCheckAttempt(await install({ kind: 'release' }, 'daily')).code;
  }
  if (!Number.isFinite(lastCheck) || now.getTime() - lastCheck > CHECK_INTERVAL_MS) {
    say(`${status.lastCheckAt ? `the last check was at ${status.lastCheckAt}` : 'no check yet'}: refreshing what is available. Outside the quiet window nothing is installed.`);
    const outcome = await performUpdate({
      repoRoot: opts.repoRoot, dbPath: opts.dbPath, dashboardDir: opts.dashboardDir, port: opts.port,
      target: { kind: 'release' }, checkOnly: true, yes: true, auto: true, restartSpec: opts.restartSpec, remote: opts.remote, branch: opts.branch,
      stdout: opts.stdout, stderr: opts.stderr,
    }, deps);
    return recordCheckAttempt(outcome).code;
  }
  return 0;

  /** What a run that could not check or install leaves as the problem: a refusal, or a failure
   *  before a target was chosen. Null after anything else, so the last problem is cleared. */
  function checkProblem(outcome: UpdateOutcome): string | null {
    if (outcome.kind === 'refused') return `Refused: ${outcome.message}`;
    if (outcome.kind === 'failed' && !outcome.attempted) return outcome.message;
    return null;
  }

  /** The throttle holds whatever the daily check found. run.ts records `lastCheckAt` once the
   *  tags were read; a refusal or a failure before that point records it here, with the reason
   *  as the problem, so the next run does not fetch again five minutes later and a refusal inside
   *  the window counts as that window's try. */
  function recordCheckAttempt(outcome: UpdateOutcome): UpdateOutcome {
    const after = readUpdateStatus(opts.dbPath);
    const recorded = after.lastCheckAt !== null && Date.parse(after.lastCheckAt) >= now.getTime();
    patch({ lastCheckAt: recorded ? after.lastCheckAt : deps.now().toISOString(), problem: checkProblem(outcome) });
    return outcome;
  }

  /** 5. The backoff ladder, after an install that was attempted: a success clears it, a failure
   *  climbs it, and the third failure in a row stops the updater. The owner's request during a
   *  pause is the one exception: its failure leaves the ladder where it is (and a stopped updater
   *  stays stopped), so the owner's try is not counted against the automatic schedule. */
  function recordBackoff(outcome: UpdateOutcome, why: 'request' | 'daily'): void {
    if (!outcome.attempted) return;
    if (outcome.kind === 'updated') { patch({ failures: 0, backoffUntil: null }); return; }
    const before = readUpdateStatus(opts.dbPath);
    if (why === 'request' && paused) {
      if (stopped) patch({ lastResult: { ...(before.lastResult ?? { ok: false, at: deps.now().toISOString(), version: outcome.version ?? '' }), ok: false, message: stoppedMessage(before.failures ?? UPDATER_STOPPED_AFTER, outcome.message) } });
      say(`the request failed during the pause: the ladder stays at ${before.failures ?? 0} failure${before.failures === 1 ? '' : 's'} in a row${stopped ? ', and automatic updates stay stopped' : `, no automatic install before ${before.backoffUntil}`}.`, 'stderr');
      return;
    }
    const failures = (before.failures ?? 0) + 1;
    if (failures >= UPDATER_STOPPED_AFTER) {
      const message = stoppedMessage(failures, outcome.message);
      patch({ failures, backoffUntil: null, lastResult: { ok: false, message, at: before.lastResult?.at ?? deps.now().toISOString(), version: before.lastResult?.version ?? '' } });
      say(message, 'stderr');
      return;
    }
    const until = new Date(deps.now().getTime() + BACKOFF_MS[failures - 1]).toISOString();
    patch({ failures, backoffUntil: until });
    say(`failure ${failures} in a row: no automatic install before ${until}.`, 'stderr');
  }
}

/** The `lastResult` message once the updater has stopped; the daemon's warning reads it by its prefix. */
function stoppedMessage(failures: number, last: string): string {
  return `${UPDATER_STOPPED_PREFIX}: ${failures} updates in a row failed, the last one: ${last}. Run cc update --release by hand, which clears the count.`;
}

const REQUEST_STATES: readonly string[] = ['pending', 'picked_up', 'done', 'failed', 'cancelled', 'expired'];

/** The current request in a GET /api/update body, or null. Its version must be a release version:
 *  the daemon only stores those, and nothing else is ever put on a command line. */
function requestOf(body: unknown): DaemonRequest | null {
  if (typeof body !== 'object' || body === null) return null;
  const request = (body as { request?: unknown }).request;
  if (typeof request !== 'object' || request === null) return null;
  const { id, version, state, result, finishedAt } = request as Record<string, unknown>;
  if (typeof id !== 'string' || typeof version !== 'string' || typeof state !== 'string' || !REQUEST_STATES.includes(state) || !isVersion(version)) return null;
  return { id, version, state: state as UpdateRequestState, result: typeof result === 'string' ? result : null, finishedAt: typeof finishedAt === 'string' ? finishedAt : null };
}

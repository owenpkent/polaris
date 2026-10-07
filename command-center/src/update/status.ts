// The update status file, data/update-status.json: the one place the updater (cc update, run by
// the owner or by the OS scheduler, always outside the daemon) tells the daemon and the dashboard
// what it is doing. The updater is its only writer. The daemon only reads it: it never runs an
// update and never starts a program (docs/update-proposal.md, sections 3 and 4).
//
// This module imports nothing that runs a program, so the daemon may import it; barrier.ts, the
// write barrier an update holds across its restart, is the other such module. The code that
// runs git, npm, and the restart lives in run.ts behind a dynamic import from the update command.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const UPDATE_STATUS_VERSION = 1;
export const UPDATE_STATUS_FILE = 'update-status.json';

/** A heartbeat older than this means no scheduled updater is installed (or it has stopped). */
export const UPDATER_HEARTBEAT_MS = 15 * 60_000;

export type UpdateRequestState = 'pending' | 'picked_up' | 'done' | 'failed' | 'cancelled' | 'expired';

export interface UpdateAvailable {
  /** A release version with nothing after the patch, e.g. "2.1.0"; the tag is "v" + this. */
  version: string;
  /** The tag's annotation, control characters stripped, at most 4000 characters. */
  notes: string;
  /** Whether command-center/src/core/schema.ts changes between the running version and this one. */
  touchesSchema: boolean;
}

export interface UpdateRequestProgress {
  id: string;
  state: UpdateRequestState;
  /** What the panel shows: "Updating", "Updated to v2.1.0", "Rolled back: the build failed". */
  message: string;
  finishedAt: string | null;
}

export interface UpdateResult {
  ok: boolean;
  message: string;
  at: string;
  /** The version that is running after this run, whether it succeeded or rolled back. */
  version: string;
}

export interface UpdateStatus {
  version: typeof UPDATE_STATUS_VERSION;
  /** True when written by `cc update --auto`; a manual `cc update` leaves it false. */
  updaterInstalled: boolean;
  /** Last time the scheduled updater ran at all, even when it had nothing to do. */
  lastRunAt: string | null;
  /** Last time tags were fetched from origin. */
  lastCheckAt: string | null;
  /** The version currently running, as the updater last saw it. Null before the first run. */
  running: string | null;
  /** A newer signed release the updater has seen but not installed, or null. */
  available: UpdateAvailable | null;
  /** The request being worked on, or the last one worked on, or null. */
  request: UpdateRequestProgress | null;
  /** The outcome of the last run that tried to install something, or null. */
  lastResult: UpdateResult | null;
  /** After a failure in --auto mode: no automatic install before this time. */
  backoffUntil: string | null;
  /** --auto only: how many installs in a row have failed. Cleared by a success, or by a `cc update`
   *  run by hand. At UPDATER_STOPPED_AFTER the updater stops and `lastResult` says so (its message
   *  starts with UPDATER_STOPPED_PREFIX). The daemon ignores the count. */
  failures?: number;
  /** --auto only: what stopped the last run before it could do anything. The daemon not answering
   *  on its port is cleared by the next run that reaches it; a check or install that was refused
   *  ("Refused: ...") or failed before a target was chosen stays until the next check, which the
   *  throttle on `lastCheckAt` times (auto.ts, CHECK_PROBLEM_PREFIX). The daemon ignores it. */
  problem?: string | null;
}

/** How many failed installs in a row stop the scheduled updater. */
export const UPDATER_STOPPED_AFTER = 3;

/** The start of `lastResult.message` once the scheduled updater has stopped: the daemon turns
 *  that, with `backoffUntil` null, into the "Automatic updates have stopped" warning. */
export const UPDATER_STOPPED_PREFIX = 'Automatic updates have stopped';

/** Whether the scheduled updater has stopped after too many failures and waits for the owner. */
export function updaterStopped(status: UpdateStatus): boolean {
  return status.backoffUntil === null && status.lastResult?.ok === false && status.lastResult.message.startsWith(UPDATER_STOPPED_PREFIX);
}

export function emptyUpdateStatus(): UpdateStatus {
  return {
    version: UPDATE_STATUS_VERSION,
    updaterInstalled: false,
    lastRunAt: null,
    lastCheckAt: null,
    running: null,
    available: null,
    request: null,
    lastResult: null,
    backoffUntil: null,
  };
}

/** The status file lives next to the database, like the token files and the backups folder. */
export function updateStatusPath(dbPath: string): string {
  return join(dirname(dbPath), UPDATE_STATUS_FILE);
}

/** A missing, unreadable, malformed, or differently versioned file reads as the empty status. */
export function readUpdateStatus(dbPath: string): UpdateStatus {
  const file = updateStatusPath(dbPath);
  if (!existsSync(file)) return emptyUpdateStatus();
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isUpdateStatus(parsed)) return emptyUpdateStatus();
    return { ...emptyUpdateStatus(), ...parsed };
  } catch {
    return emptyUpdateStatus();
  }
}

/** Written whole, through a sibling temp file and a rename, so a reader never sees a torn file. */
export function writeUpdateStatus(dbPath: string, status: UpdateStatus): void {
  const file = updateStatusPath(dbPath);
  mkdirSync(dirname(file), { recursive: true });
  const partial = `${file}.${process.pid}.partial`;
  writeFileSync(partial, JSON.stringify({ ...status, version: UPDATE_STATUS_VERSION }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameSync(partial, file);
}

/** Whether the scheduled updater is installed: its heartbeat is recent. */
export function updaterInstalled(status: UpdateStatus, now = new Date()): boolean {
  if (!status.updaterInstalled || !status.lastRunAt) return false;
  const at = Date.parse(status.lastRunAt);
  return Number.isFinite(at) && now.getTime() - at <= UPDATER_HEARTBEAT_MS;
}

function isUpdateStatus(value: unknown): value is UpdateStatus {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.version === UPDATE_STATUS_VERSION && typeof v.updaterInstalled === 'boolean';
}

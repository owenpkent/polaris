// The write barrier `cc update` holds from the moment it stops the daemon until the update is
// committed or rolled back (docs/update-proposal.md, section 1, steps 7 to 9). The snapshot a
// rollback restores is taken inside that interval, so a write acknowledged while the barrier is
// up could be lost: the barrier makes sure none is. It is a marker file next to the database,
// `data/update-barrier.json`, holding the updater's pid, when it was written, and the version
// being installed. While it is fresh, the daemon answers 503 to every write on /api, the MCP write
// tools return an error, and a CLI command that opens the store refuses (cli.ts); reads keep
// working. A barrier whose pid is not alive, or that is over two hours old, is a crashed update's
// leftover: it is ignored and removed by whoever finds it.
//
// The daemon and the CLI import this module, so it imports nothing but node:fs and node:path,
// like status.ts: the daemon's static import graph stays clear of everything that runs a program
// (invariants.test.ts, group 11).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const UPDATE_BARRIER_FILE = 'update-barrier.json';

/** A barrier older than this is stale whatever its pid says: an update never takes two hours. */
export const BARRIER_MAX_AGE_MS = 2 * 60 * 60_000;

export interface UpdateBarrier {
  /** The `cc update` process that wrote it. */
  pid: number;
  /** When it was written, ISO 8601, by the wall clock: other processes compare it with theirs. */
  startedAt: string;
  /** The version being installed. */
  version: string;
}

export interface BarrierDeps {
  /** The wall clock, in milliseconds since the epoch. */
  now: () => number;
  /** Whether a process with that pid exists. */
  alive: (pid: number) => boolean;
}

/** What a refused write is told, with the moment the update started. */
export function updatingMessage(barrier: UpdateBarrier): string {
  return `Polaris is being updated (started ${barrier.startedAt}). Try again in a minute.`;
}

/** Thrown by `assertNotUpdating`: the one error the CLI prints without a stack. */
export class UpdateInProgressError extends Error {}

/** The barrier file lives next to the database, like the token files and the status file. */
export function barrierPath(dbPath: string): string {
  return join(dirname(dbPath), UPDATE_BARRIER_FILE);
}

/** `process.kill(pid, 0)` sends nothing and says whether the process exists. EPERM means it
 *  exists and belongs to someone else, which is still alive. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Written whole, by this process, stamped with the wall clock, through a sibling temp file and
 *  a rename, so a reader never sees a torn file. */
export function writeBarrier(dbPath: string, version: string): UpdateBarrier {
  const barrier: UpdateBarrier = { pid: process.pid, startedAt: new Date().toISOString(), version };
  const file = barrierPath(dbPath);
  mkdirSync(dirname(file), { recursive: true });
  const partial = `${file}.${process.pid}.partial`;
  writeFileSync(partial, JSON.stringify(barrier, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameSync(partial, file);
  return barrier;
}

export function removeBarrier(dbPath: string): void {
  rmSync(barrierPath(dbPath), { force: true });
}

/** The fresh barrier, or null when there is none. A stale one (its pid gone, over two hours old,
 *  or unreadable) is removed on the way and reads as none. An in-memory database has no folder
 *  for one and reads as none too. */
export function readBarrier(dbPath: string, deps: Partial<BarrierDeps> = {}): UpdateBarrier | null {
  if (dbPath === ':memory:') return null;
  const file = barrierPath(dbPath);
  if (!existsSync(file)) return null;
  const now = deps.now ?? Date.now;
  const alive = deps.alive ?? pidAlive;
  let barrier: UpdateBarrier | null = null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (isBarrier(parsed)) barrier = parsed;
  } catch {
    barrier = null;
  }
  const startedAt = barrier ? Date.parse(barrier.startedAt) : NaN;
  const fresh = barrier !== null && Number.isFinite(startedAt) && now() - startedAt <= BARRIER_MAX_AGE_MS && alive(barrier.pid);
  if (!fresh) {
    rmSync(file, { force: true });
    return null;
  }
  return barrier;
}

/** Throws `UpdateInProgressError` while a fresh barrier exists. The CLI's gate on opening the store. */
export function assertNotUpdating(dbPath: string, deps: Partial<BarrierDeps> = {}): void {
  const barrier = readBarrier(dbPath, deps);
  if (barrier) throw new UpdateInProgressError(updatingMessage(barrier));
}

function isBarrier(value: unknown): value is UpdateBarrier {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return Number.isInteger(v.pid) && (v.pid as number) > 0 && typeof v.startedAt === 'string' && typeof v.version === 'string';
}

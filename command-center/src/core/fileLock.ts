// A lock between processes, held as a file created with 'wx'. The daemon and a CLI command are
// separate processes, and both write the secret file and publish backups, so an in-process guard
// is not enough. A lock older than `staleMs` was left by a process that died and is taken over;
// most sections locked here take milliseconds, so the defaults are generous. The DPAPI secret
// store runs PowerShell under its lock and passes longer ones.
//
// Taking over by age cannot tell a dead holder from a slow one, so each lock file carries its
// holder's own token. A holder checks `held()` right before a write that must not land after a
// takeover, and on release it removes the lock file only while it is still its own.
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export interface FileLockOptions {
  /** How long to wait for another holder before giving up. */
  timeoutMs?: number;
  /** A lock file older than this belongs to a dead process. */
  staleMs?: number;
  /** Named in the error when the wait runs out. */
  what?: string;
}

export interface HeldLock {
  /** False once another holder has taken the lock over as stale. */
  held(): boolean;
}

export class FileLockError extends Error {}

function tryTake(lockFile: string, staleMs: number, owner: string): boolean {
  let fd: number;
  try {
    fd = openSync(lockFile, 'wx', 0o600);
  } catch (e) {
    // EPERM and EACCES: on Windows, a lock file another process is in the middle of deleting.
    if (!['EEXIST', 'EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
    try {
      if (Date.now() - statSync(lockFile).mtimeMs > staleMs) unlinkSync(lockFile);
    } catch { /* the holder released it between our two looks; the next try will take it */ }
    return false;
  }
  let written = false;
  try {
    writeSync(fd, owner);
    written = true;
  } finally {
    closeSync(fd);
    // A lock nobody owns would hold every writer off until it went stale.
    if (!written) try { unlinkSync(lockFile); } catch { /* left for the stale check */ }
  }
  return true;
}

function heldLock(lockFile: string, owner: string): HeldLock {
  return {
    held() {
      try { return readFileSync(lockFile, 'utf8') === owner; } catch { return false; }
    },
  };
}

function release(lockFile: string, lock: HeldLock): void {
  if (!lock.held()) return; // taken over as stale: the file is another holder's now
  try { unlinkSync(lockFile); } catch { /* already gone */ }
}

const newOwner = () => `${process.pid}.${randomBytes(8).toString('hex')}`;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const jitter = () => 5 + Math.random() * 20;

export function withFileLockSync<T>(lockFile: string, fn: (lock: HeldLock) => T, opts: FileLockOptions = {}): T {
  const { timeoutMs = 15_000, staleMs = 10_000, what = lockFile } = opts;
  mkdirSync(dirname(lockFile), { recursive: true });
  const owner = newOwner();
  const deadline = Date.now() + timeoutMs;
  while (!tryTake(lockFile, staleMs, owner)) {
    if (Date.now() > deadline) throw new FileLockError(`${what} is locked by another process (${lockFile}).`);
    sleepSync(jitter());
  }
  const lock = heldLock(lockFile, owner);
  try {
    return fn(lock);
  } finally {
    release(lockFile, lock);
  }
}

export async function withFileLock<T>(lockFile: string, fn: (lock: HeldLock) => T | Promise<T>, opts: FileLockOptions = {}): Promise<T> {
  const { timeoutMs = 15_000, staleMs = 10_000, what = lockFile } = opts;
  mkdirSync(dirname(lockFile), { recursive: true });
  const owner = newOwner();
  const deadline = Date.now() + timeoutMs;
  while (!tryTake(lockFile, staleMs, owner)) {
    if (Date.now() > deadline) throw new FileLockError(`${what} is locked by another process (${lockFile}).`);
    await new Promise((r) => setTimeout(r, jitter()));
  }
  const lock = heldLock(lockFile, owner);
  try {
    return await fn(lock);
  } finally {
    release(lockFile, lock);
  }
}

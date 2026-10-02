// Nightly database backup: one dated copy per day, newest `keep` kept. The copy comes from
// Store.backupTo (SQLite VACUUM INTO), so it is consistent even while the daemon is writing.
// Every copy is opened and checked before it gets its dated name: a backup that cannot be read
// back is worse than none, because it looks like safety.
// Point CC_BACKUP_DIR at a second disk or a synced folder: the default, next to the database,
// only protects against a bad write, not a lost disk.

import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { decryptBuffer, decryptFile, encryptFile, ENCRYPTED_SUFFIX, isEncryptedBackup } from './backupCrypto.ts';
import { withFileLockSync } from '../core/fileLock.ts';
import { inspectDatabaseFile, type DatabaseCounts, type DatabaseInspection, type Store } from '../core/index.ts';

export const DEFAULT_BACKUP_KEEP = 14;
/** Where the backup passphrase lives in the secret store. Set by `cc backup encrypt`. */
export const BACKUP_PASSPHRASE_KEY = 'backup-passphrase';

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest();

const BACKUP_FILE = /^constellation-\d{4}-\d{2}-\d{2}\.db(\.enc)?$/;
const PARTIAL_FILE = /^constellation-\d{4}-\d{2}-\d{2}\.db(\.enc)?\..+\.partial$/;
/** A staging file this old belongs to an attempt that died: a copy takes seconds. A younger one may still be in use. */
const ABANDONED_PARTIAL_MS = 24 * 60 * 60_000;

function removeAbandonedPartials(dir: string, now: Date): void {
  for (const f of readdirSync(dir).filter((name) => PARTIAL_FILE.test(name))) {
    try {
      if (now.getTime() - statSync(join(dir, f)).mtimeMs > ABANDONED_PARTIAL_MS) unlinkSync(join(dir, f));
    } catch { /* its owner just published or removed it */ }
  }
}

/** Where backups go: CC_BACKUP_DIR, or `backups` next to the database. Undefined for an in-memory database with no CC_BACKUP_DIR. */
export function backupDir(dbPath: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.CC_BACKUP_DIR) return env.CC_BACKUP_DIR;
  return dbPath === ':memory:' ? undefined : join(dirname(dbPath), 'backups');
}

/** The newest dated copy in `dir`, or undefined. */
export function newestBackup(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const newest = readdirSync(dir).filter((f) => BACKUP_FILE.test(f)).sort().at(-1);
  return newest && join(dir, newest);
}

export interface BackupResult { file: string; removed: string[] }

export interface BackupOptions {
  /** Set, the published copy is encrypted (`.db.enc`). Unset, it is a plain SQLite file (`.db`). */
  passphrase?: string;
  /** Tests only: a lower scrypt cost. */
  logN?: number;
  /** How long to wait for another attempt's publication before giving up. */
  lockTimeoutMs?: number;
}

/** `today` is 'YYYY-MM-DD'. A second run on the same day replaces that day's copy. */
export function backupDatabase(store: Store, dir: string, today: string, keep: number = DEFAULT_BACKUP_KEEP, now: Date = new Date(), opts: BackupOptions = {}): BackupResult {
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`backup: keep must be a whole number of 1 or more, got ${keep}`);
  mkdirSync(dir, { recursive: true });
  const plainName = `constellation-${today}.db`;
  const file = join(dir, opts.passphrase ? plainName + ENCRYPTED_SUFFIX : plainName);
  // The copy is made and checked on this machine's own disk. `dir` may be a NAS or a synced
  // folder: a readable database must never sit there, even for a moment, when encryption is on,
  // and SQLite writing page by page over a network share is slow and fragile anyway.
  const local = mkdtempSync(join(tmpdir(), 'cc-backup-'));
  // Each attempt publishes through a file of its own. The daemon's nightly run and a `cc sync
  // backup` in another process can overlap, and a fixed name would let one delete or publish the
  // other's copy. A half-written file never carries a dated name.
  const partial = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.partial`;
  try {
    const plain = join(local, plainName);
    const before = store.backupFingerprint();
    store.backupTo(plain);
    const problems = verifyBackup(plain, before, store.backupFingerprint());
    if (problems.length) throw new Error(`backup: the copy failed its check and was deleted: ${problems.join('; ')}`);

    if (opts.passphrase) encryptFile(plain, partial, opts.passphrase, { logN: opts.logN });
    else copyFileSync(plain, partial);
    // Read back what actually landed, through the passphrase if there is one: a share that
    // truncated the file, or a key that cannot open it, must fail here and not on restore day.
    const landed = opts.passphrase ? decryptBuffer(partial, opts.passphrase) : readFileSync(partial);
    if (!sha256(landed).equals(sha256(readFileSync(plain)))) throw new Error('backup: the published copy does not match the checked one and was deleted');
  } catch (e) {
    try { unlinkSync(partial); } catch { /* never created */ }
    rmSync(local, { recursive: true, force: true });
    throw e;
  }
  rmSync(local, { recursive: true, force: true });

  // Publication is one step under a lock shared by both formats of the day: the rename, the
  // removal of the other format's copy of the same day, and retention. Two attempts (the daemon and
  // a `cc sync backup`, possibly with encryption switched between their reads of the secret store)
  // could otherwise each delete the other's finished copy and both report success over an empty folder.
  const lockFile = join(dir, `constellation-${today}.lock`);
  let removed: string[];
  try {
    removed = withFileLockSync(lockFile, () => {
      renameSync(partial, file);
      // One copy per day. Turning encryption on must not leave that day's readable copy beside it.
      const sibling = join(dir, opts.passphrase ? plainName : plainName + ENCRYPTED_SUFFIX);
      try { unlinkSync(sibling); } catch { /* there was none */ }
      removeAbandonedPartials(dir, now);
      const dated = readdirSync(dir).filter((f) => BACKUP_FILE.test(f)).sort();
      const old = dated.slice(0, Math.max(0, dated.length - keep));
      for (const f of old) unlinkSync(join(dir, f));
      return old;
    }, { timeoutMs: opts.lockTimeoutMs ?? 30_000, staleMs: 60_000, what: `The backup folder ${dir}` });
  } catch (e) {
    try { unlinkSync(partial); } catch { /* already published, or never created */ }
    throw e;
  }
  return { file, removed };
}

/** What is wrong with a database file in itself, whatever it is a copy of. */
export function soundnessProblems(found: DatabaseInspection): string[] {
  const problems: string[] = [];
  if (found.integrity.join() !== 'ok') problems.push(`integrity_check: ${found.integrity.slice(0, 3).join(', ')}`);
  if (found.foreignKeyViolations) problems.push(`${found.foreignKeyViolations} foreign key violation(s)`);
  return problems;
}

interface Fingerprint { schemaVersion: number; counts: DatabaseCounts }

/** What is wrong with the copy at `file`, or [] when it is sound. `before` and `after` are the live
 *  database on either side of the copy: another process (the CLI, the stdio MCP server) may write
 *  in between, and the counted tables only grow, so a good copy lies between the two. */
export function verifyBackup(file: string, before: Fingerprint, after: Fingerprint = before): string[] {
  let found;
  try {
    found = inspectDatabaseFile(file);
  } catch (e) {
    return [`cannot be opened (${e instanceof Error ? e.message : String(e)})`];
  }
  const problems = soundnessProblems(found);
  if (found.schemaVersion !== before.schemaVersion) problems.push(`schema version ${found.schemaVersion}, expected ${before.schemaVersion}`);
  for (const table of ['tasks', 'projects', 'events'] as const) {
    const n = found.counts[table];
    if (n < before.counts[table] || n > after.counts[table]) problems.push(`${table}: ${n} rows, expected ${before.counts[table]}${after.counts[table] !== before.counts[table] ? ` to ${after.counts[table]}` : ''}`);
  }
  return problems;
}

/** Inspect a backup, encrypted or not. An encrypted one is decrypted into a temp folder on this
 *  machine, inspected there, and the readable copy removed. */
export function inspectBackup(file: string, passphrase?: string): DatabaseInspection {
  if (!isEncryptedBackup(file)) return inspectDatabaseFile(file);
  if (!passphrase) throw new Error(`${file} is encrypted and no passphrase was given`);
  const local = mkdtempSync(join(tmpdir(), 'cc-backup-check-'));
  try {
    const plain = join(local, 'backup.db');
    decryptFile(file, plain, passphrase);
    return inspectDatabaseFile(plain);
  } finally {
    rmSync(local, { recursive: true, force: true });
  }
}

// SQL driver abstraction. Core only talks to SqlDriver so the same store runs on
// node:sqlite locally and on Durable Object SQLite (ctx.storage.sql) when hosted.

import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MIGRATIONS } from './schema.ts';

export type SqlValue = string | number | null;

export interface SqlDriver {
  all<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): T[];
  get<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): T | undefined;
  run(sql: string, params?: SqlValue[]): { changes: number };
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
  close(): void;
}

export function openNodeDriver(path: string): SqlDriver {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  let depth = 0;
  const driver: SqlDriver = {
    all: (sql, params = []) => db.prepare(sql).all(...params) as never[],
    get: (sql, params = []) => db.prepare(sql).get(...params) as never,
    run: (sql, params = []) => {
      const r = db.prepare(sql).run(...params);
      return { changes: Number(r.changes) };
    },
    exec: (sql) => db.exec(sql),
    transaction: (fn) => {
      // Nested calls join the outer transaction via savepoints.
      const name = `sp${depth}`;
      db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
      depth++;
      try {
        const out = fn();
        depth--;
        db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
        return out;
      } catch (e) {
        depth--;
        db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
        throw e;
      }
    },
    close: () => db.close(),
  };
  migrate(driver);
  return driver;
}

export function migrate(db: SqlDriver): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.get<{ version: number }>('SELECT version FROM schema_version');
  let current = row?.version ?? 0;
  if (!row) db.run('INSERT INTO schema_version (version) VALUES (0)');
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.run('UPDATE schema_version SET version = ?', [i + 1]);
    });
    current = i + 1;
  }
}

export interface DatabaseInspection {
  /** Rows from PRAGMA integrity_check. A sound file gives exactly ['ok']. */
  integrity: string[];
  foreignKeyViolations: number;
  schemaVersion: number;
  counts: DatabaseCounts;
}

/** Tables that only ever grow (tasks and projects are never deleted, events are append-only), so a copy can be compared with the live database. */
export interface DatabaseCounts { tasks: number; projects: number; events: number }

export function countRows(db: Pick<SqlDriver, 'get'>): DatabaseCounts {
  const n = (table: string) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n;
  return { tasks: n('tasks'), projects: n('projects'), events: n('events') };
}

/** Report on a database file without touching it or its folder. SQLite's read-only mode is not
 *  enough for that: opening a WAL-mode file creates `-wal` and `-shm` beside it, and fails outright
 *  in a folder that cannot be written. So the file, with its `-wal` if it has one, is copied to a
 *  temp folder and inspected there. Never migrates. Throws if the file is missing or not a database. */
export function inspectDatabaseFile(path: string): DatabaseInspection {
  const dir = mkdtempSync(join(tmpdir(), 'cc-inspect-'));
  try {
    const copy = join(dir, 'copy.db');
    copyFileSync(path, copy);
    // Pages not yet checkpointed live in the -wal: without it the copy would be an older database.
    if (existsSync(`${path}-wal`)) copyFileSync(`${path}-wal`, `${copy}-wal`);
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      return {
        integrity: (db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]).map((r) => r.integrity_check),
        foreignKeyViolations: db.prepare('PRAGMA foreign_key_check').all().length,
        schemaVersion: (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version,
        counts: countRows({ get: (sql) => db.prepare(sql).get() as never }),
      };
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

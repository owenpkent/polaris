import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openNodeDriver, type SqlDriver } from './db.ts';
import { MIGRATIONS } from './schema.ts';

// sqlite_sequence is SQLite's own bookkeeping table, created implicitly because events.id is
// an AUTOINCREMENT primary key.
const EXPECTED_TABLES = [
  'applied_ops', 'checklists', 'comments', 'dependencies', 'events', 'goal_links', 'goals', 'kv', 'links', 'posts', 'projects',
  'rules', 'schema_version', 'sections', 'source_items', 'sqlite_sequence', 'sync_cursors', 'tasks', 'threads', 'update_requests', 'views',
];

function tableNames(db: SqlDriver): string[] {
  return db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((r) => r.name);
}

function columnNames(db: SqlDriver, table: string): string[] {
  return db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((r) => r.name);
}

// ---- MIGRATIONS array invariants ----

test('MIGRATIONS is a non-empty, append-only list of non-empty SQL strings', () => {
  assert.ok(Array.isArray(MIGRATIONS));
  assert.ok(MIGRATIONS.length > 0);
  for (const m of MIGRATIONS) {
    assert.equal(typeof m, 'string');
    assert.ok(m.trim().length > 0);
  }
});

// ---- fresh :memory: database ----

test('migrations apply cleanly to a fresh :memory: database', () => {
  const db = openNodeDriver(':memory:');
  try {
    assert.deepEqual(tableNames(db), EXPECTED_TABLES);
  } finally {
    db.close();
  }
});

test('schema_version lands at exactly MIGRATIONS.length after a fresh open (versions are strictly increasing and append-only)', () => {
  const db = openNodeDriver(':memory:');
  try {
    const row = db.get<{ version: number }>('SELECT version FROM schema_version');
    assert.equal(row?.version, MIGRATIONS.length);
  } finally {
    db.close();
  }
});

test('calling migrate() again on an already-migrated driver is a no-op (does not re-run CREATE TABLE)', () => {
  const db = openNodeDriver(':memory:');
  try {
    // If migrate() re-ran a completed migration, this would throw "table already exists".
    assert.doesNotThrow(() => migrate(db));
    const row = db.get<{ version: number }>('SELECT version FROM schema_version');
    assert.equal(row?.version, MIGRATIONS.length);
    // Calling it a third time is equally harmless.
    assert.doesNotThrow(() => migrate(db));
  } finally {
    db.close();
  }
});

test('migrate() trusts the stored version counter: rolling it back replays exactly the migrations from that point on', () => {
  const db = openNodeDriver(':memory:');
  try {
    // migrate() reads schema_version and loops from `current` to MIGRATIONS.length, applying
    // each migration's raw SQL. It never re-checks actual table existence, so telling it the
    // version is 0 makes it try migration 0 again (CREATE TABLE ... for tables that already
    // exist), which fails loudly rather than silently succeeding or silently doing nothing.
    db.run('UPDATE schema_version SET version = 0');
    assert.throws(() => migrate(db));
  } finally {
    db.close();
  }
});

// ---- idempotent across process restarts (same file reopened) ----

test('opening the same file twice is idempotent: the second open does not re-run migrations or lose data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-schema-test-'));
  const dbPath = join(dir, 'constellation.db');
  try {
    const first = openNodeDriver(dbPath);
    first.run(
      'INSERT INTO projects (id, slug, name, archived, meta, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)',
      ['p1', 'nimbus', 'Project Nimbus', '{}', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
    );
    const versionAfterFirst = first.get<{ version: number }>('SELECT version FROM schema_version')?.version;
    first.close();

    const second = openNodeDriver(dbPath);
    try {
      const versionAfterSecond = second.get<{ version: number }>('SELECT version FROM schema_version')?.version;
      assert.equal(versionAfterSecond, versionAfterFirst);
      assert.equal(versionAfterSecond, MIGRATIONS.length);
      const project = second.get<{ slug: string }>('SELECT slug FROM projects WHERE id = ?', ['p1']);
      assert.equal(project?.slug, 'nimbus');
      assert.deepEqual(tableNames(second), EXPECTED_TABLES);
    } finally {
      second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reopening the same file a third time still leaves exactly one schema_version row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-schema-test-'));
  const dbPath = join(dir, 'constellation.db');
  try {
    openNodeDriver(dbPath).close();
    openNodeDriver(dbPath).close();
    const third = openNodeDriver(dbPath);
    try {
      const rows = third.all('SELECT version FROM schema_version');
      assert.equal(rows.length, 1);
    } finally {
      third.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- expected tables and key columns ----

test('every expected table exists after migration', () => {
  const db = openNodeDriver(':memory:');
  try {
    const names = new Set(tableNames(db));
    for (const t of EXPECTED_TABLES) assert.ok(names.has(t), `missing table ${t}`);
  } finally {
    db.close();
  }
});

test('tasks has the key columns the Store layer relies on', () => {
  const db = openNodeDriver(':memory:');
  try {
    const cols = new Set(columnNames(db, 'tasks'));
    for (const c of [
      'id', 'project_id', 'section_id', 'parent_id', 'title', 'notes', 'status', 'priority',
      'due_at', 'start_at', 'estimate_minutes', 'recurrence', 'is_milestone', 'position',
      'source_type', 'source_id', 'source_url', 'confidence', 'untrusted_text', 'custom_fields',
      'created_at', 'updated_at', 'completed_at', 'assignee',
    ]) assert.ok(cols.has(c), `tasks missing column ${c}`);
  } finally {
    db.close();
  }
});

test('projects, sections, source_items, dependencies, comments, links, events, rules, views, kv have their key columns', () => {
  const db = openNodeDriver(':memory:');
  try {
    assert.ok(new Set(columnNames(db, 'projects')).has('slug'));
    assert.ok(new Set(columnNames(db, 'sections')).has('project_id'));
    assert.ok(new Set(columnNames(db, 'source_items')).has('content_hash'));
    assert.ok(new Set(columnNames(db, 'dependencies')).has('blocker_id'));
    assert.ok(new Set(columnNames(db, 'dependencies')).has('blocked_id'));
    assert.ok(new Set(columnNames(db, 'comments')).has('body'));
    assert.ok(new Set(columnNames(db, 'links')).has('url'));
    assert.ok(new Set(columnNames(db, 'events')).has('kind'));
    assert.ok(new Set(columnNames(db, 'rules')).has('definition'));
    assert.ok(new Set(columnNames(db, 'views')).has('filter'));
    assert.ok(new Set(columnNames(db, 'kv')).has('value'));
  } finally {
    db.close();
  }
});

test('the tasks.status CHECK constraint rejects a status outside the known set', () => {
  const db = openNodeDriver(':memory:');
  try {
    assert.throws(() => db.run(
      'INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['t1', 'x', 'not-a-real-status', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
    ));
  } finally {
    db.close();
  }
});

test('the dependencies CHECK constraint rejects a task blocking itself', () => {
  const db = openNodeDriver(':memory:');
  try {
    db.run(
      'INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['t1', 'x', 'open', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
    );
    assert.throws(() => db.run('INSERT INTO dependencies (blocker_id, blocked_id) VALUES (?, ?)', ['t1', 't1']));
  } finally {
    db.close();
  }
});

test('projects.slug has a unique constraint', () => {
  const db = openNodeDriver(':memory:');
  try {
    const insert = () => db.run(
      'INSERT INTO projects (id, slug, name, archived, meta, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)',
      [`p-${Math.random()}`, 'dup-slug', 'Name', '{}', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
    );
    insert();
    assert.throws(insert);
  } finally {
    db.close();
  }
});

test('untrusted_text defaults to 0, so a task is trusted only by being created without the flag', () => {
  const db = openNodeDriver(':memory:');
  try {
    db.run(
      'INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['t1', 'x', 'open', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
    );
    const row = db.get<{ untrusted_text: number }>('SELECT untrusted_text FROM tasks WHERE id = ?', ['t1']);
    assert.equal(row?.untrusted_text, 0);
  } finally {
    db.close();
  }
});

test('migration 3 backfills untrusted_text from source_type on a database that predates the column', () => {
  // The real upgrade path for the owner's existing database. Rebuild the pre-migration shape by
  // dropping the column and rewinding the version counter, then let migrate() do its job.
  const db = openNodeDriver(':memory:');
  try {
    db.exec('ALTER TABLE tasks DROP COLUMN untrusted_text');
    db.exec('ALTER TABLE source_items DROP COLUMN gone_resolution');
    db.exec('DROP TABLE applied_ops');
    db.exec('ALTER TABLE tasks DROP COLUMN assignee');
    db.exec('ALTER TABLE events DROP COLUMN actor_name');
    db.exec('ALTER TABLE comments DROP COLUMN author_name');
    db.exec('DROP TABLE checklists');
    db.exec('DROP TABLE update_requests');
    db.exec('DROP TABLE posts');
    db.exec('DROP TABLE threads');
    db.run('UPDATE schema_version SET version = ?', [2]);
    assert.ok(!new Set(columnNames(db, 'tasks')).has('untrusted_text'), 'set up a database without the column');

    const insert = (id: string, sourceType: string | null) => db.run(
      `INSERT INTO tasks (id, title, status, source_type, source_id, created_at, updated_at)
       VALUES (?, ?, 'inbox', ?, ?, ?, ?)`,
      [id, `title ${id}`, sourceType, sourceType ? `${id}-src` : null,
        '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
    );
    for (const source of ['github', 'gmail', 'gdrive', 'gcal']) insert(`ext-${source}`, source);
    insert('own-todo', 'todo_md');
    insert('own-none', null);

    migrate(db);

    assert.equal(db.get<{ version: number }>('SELECT version FROM schema_version')?.version, MIGRATIONS.length);
    const flagOf = (id: string) =>
      db.get<{ untrusted_text: number }>('SELECT untrusted_text FROM tasks WHERE id = ?', [id])?.untrusted_text;
    for (const source of ['github', 'gmail', 'gdrive', 'gcal']) {
      assert.equal(flagOf(`ext-${source}`), 1, `${source} rows should come out marked`);
    }
    assert.equal(flagOf('own-todo'), 0, "the owner's own sources are not third-party text");
    assert.equal(flagOf('own-none'), 0, 'and neither is a task the owner typed in');
  } finally {
    db.close();
  }
});

test('tasks.priority defaults to "none" when omitted', () => {
  const db = openNodeDriver(':memory:');
  try {
    db.run(
      'INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['t1', 'x', 'open', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
    );
    const row = db.get<{ priority: string }>('SELECT priority FROM tasks WHERE id = ?', ['t1']);
    assert.equal(row?.priority, 'none');
  } finally {
    db.close();
  }
});

test('tasks.assignee is NULL when omitted, so a task starts unclaimed', () => {
  const db = openNodeDriver(':memory:');
  try {
    db.run(
      'INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['t1', 'x', 'open', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
    );
    const row = db.get<{ assignee: string | null }>('SELECT assignee FROM tasks WHERE id = ?', ['t1']);
    assert.equal(row?.assignee, null);
  } finally {
    db.close();
  }
});

test('events.actor_name and comments.author_name are NULL when omitted', () => {
  const db = openNodeDriver(':memory:');
  try {
    db.run('INSERT INTO events (at, kind, task_id, actor, payload) VALUES (?, ?, ?, ?, ?)',
      ['2026-09-01T00:00:00.000Z', 'task.created', null, 'human', '{}']);
    const event = db.get<{ actor_name: string | null }>('SELECT actor_name FROM events ORDER BY id DESC LIMIT 1');
    assert.equal(event?.actor_name, null);

    db.run(
      'INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['t1', 'x', 'open', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
    );
    db.run('INSERT INTO comments (id, task_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)',
      ['c1', 't1', 'human', 'hello', '2026-09-01T00:00:00.000Z']);
    const comment = db.get<{ author_name: string | null }>('SELECT author_name FROM comments WHERE id = ?', ['c1']);
    assert.equal(comment?.author_name, null);
  } finally {
    db.close();
  }
});

test('migration 7 adds events.actor_name and comments.author_name to a database that predates them, leaving existing rows NULL', () => {
  const db = openNodeDriver(':memory:');
  try {
    db.exec('ALTER TABLE events DROP COLUMN actor_name');
    db.exec('ALTER TABLE comments DROP COLUMN author_name');
    db.exec('DROP TABLE checklists');
    db.exec('DROP TABLE update_requests');
    db.exec('DROP TABLE posts');
    db.exec('DROP TABLE threads');
    db.run('UPDATE schema_version SET version = ?', [6]);
    assert.ok(!new Set(columnNames(db, 'events')).has('actor_name'), 'set up a database without the column');
    assert.ok(!new Set(columnNames(db, 'comments')).has('author_name'), 'set up a database without the column');

    db.run(
      'INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['old', 'made before the column existed', 'open', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
    );
    db.run('INSERT INTO events (at, kind, task_id, actor, payload) VALUES (?, ?, ?, ?, ?)',
      ['2026-09-01T00:00:00.000Z', 'task.created', 'old', 'agent', '{}']);
    db.run('INSERT INTO comments (id, task_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)',
      ['c-old', 'old', 'agent', 'before the column existed', '2026-09-01T00:00:00.000Z']);

    migrate(db);

    assert.equal(db.get<{ version: number }>('SELECT version FROM schema_version')?.version, MIGRATIONS.length);
    assert.ok(new Set(columnNames(db, 'events')).has('actor_name'));
    assert.ok(new Set(columnNames(db, 'comments')).has('author_name'));
    const event = db.get<{ actor_name: string | null; actor: string }>('SELECT actor_name, actor FROM events WHERE task_id = ?', ['old']);
    assert.equal(event?.actor_name, null, 'a migrated row cannot know a name it was never given');
    assert.equal(event?.actor, 'agent', 'the migration only appends a column, it never touches an existing one');
    const comment = db.get<{ author_name: string | null }>('SELECT author_name FROM comments WHERE id = ?', ['c-old']);
    assert.equal(comment?.author_name, null);
  } finally {
    db.close();
  }
});

test('migration 6 adds tasks.assignee to a database that predates it and leaves existing rows unclaimed', () => {
  const db = openNodeDriver(':memory:');
  try {
    db.exec('ALTER TABLE tasks DROP COLUMN assignee');
    db.exec('ALTER TABLE events DROP COLUMN actor_name');
    db.exec('ALTER TABLE comments DROP COLUMN author_name');
    db.exec('DROP TABLE checklists');
    db.exec('DROP TABLE update_requests');
    db.exec('DROP TABLE posts');
    db.exec('DROP TABLE threads');
    db.run('UPDATE schema_version SET version = ?', [5]);
    assert.ok(!new Set(columnNames(db, 'tasks')).has('assignee'), 'set up a database without the column');
    db.run(
      'INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['old', 'made before the column existed', 'open', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
    );

    migrate(db);

    assert.equal(db.get<{ version: number }>('SELECT version FROM schema_version')?.version, MIGRATIONS.length);
    assert.ok(new Set(columnNames(db, 'tasks')).has('assignee'));
    assert.equal(db.get<{ assignee: string | null }>('SELECT assignee FROM tasks WHERE id = ?', ['old'])?.assignee, null);
    // The other columns are untouched: the migration only appends.
    const row = db.get<{ title: string; status: string; untrusted_text: number }>('SELECT title, status, untrusted_text FROM tasks WHERE id = ?', ['old']);
    assert.deepEqual({ ...row }, { title: 'made before the column existed', status: 'open', untrusted_text: 0 });
  } finally {
    db.close();
  }
});

test('migration 12 adds the checklists table to a database that predates it, leaving every task as it was', () => {
  const db = openNodeDriver(':memory:');
  try {
    db.exec('DROP TABLE checklists');
    db.run('UPDATE schema_version SET version = ?', [11]);
    db.run(
      'INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['old', 'made before checklists existed', 'open', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
    );

    migrate(db);

    assert.equal(db.get<{ version: number }>('SELECT version FROM schema_version')?.version, MIGRATIONS.length);
    assert.deepEqual(columnNames(db, 'checklists'), ['id', 'name', 'notes', 'items', 'position', 'created_at', 'updated_at']);
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM checklists')?.n, 0);
    const row = db.get<{ title: string; status: string }>('SELECT title, status FROM tasks WHERE id = ?', ['old']);
    assert.deepEqual({ ...row }, { title: 'made before checklists existed', status: 'open' });
  } finally {
    db.close();
  }
});

test('checklists.items and notes default to empty, so a bare row reads as a checklist with nothing in it', () => {
  const db = openNodeDriver(':memory:');
  try {
    db.run('INSERT INTO checklists (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
      ['cl1', 'Bare', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
    const row = db.get<{ items: string; notes: string; position: number }>('SELECT items, notes, position FROM checklists WHERE id = ?', ['cl1']);
    assert.deepEqual({ ...row }, { items: '[]', notes: '', position: 0 });
  } finally {
    db.close();
  }
});

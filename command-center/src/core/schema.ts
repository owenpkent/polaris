// Append-only migrations. Never edit a shipped migration; add a new one.

export const MIGRATIONS: string[] = [
  /* 1: initial task graph */ `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    category TEXT,
    type TEXT,
    description TEXT,
    status TEXT,
    path TEXT,
    github TEXT,
    todo_file TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    meta TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE sections (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    position REAL NOT NULL,
    UNIQUE (project_id, name)
  );

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    section_id TEXT REFERENCES sections(id) ON DELETE SET NULL,
    parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('inbox','open','in_progress','waiting','done','dropped')),
    priority TEXT NOT NULL DEFAULT 'none' CHECK (priority IN ('none','low','medium','high','urgent')),
    due_at TEXT,
    start_at TEXT,
    estimate_minutes INTEGER,
    recurrence TEXT,
    is_milestone INTEGER NOT NULL DEFAULT 0,
    position REAL NOT NULL DEFAULT 0,
    source_type TEXT,
    source_id TEXT,
    source_url TEXT,
    confidence REAL,
    custom_fields TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE UNIQUE INDEX tasks_source ON tasks(source_type, source_id) WHERE source_type IS NOT NULL;
  CREATE INDEX tasks_project ON tasks(project_id, status);
  CREATE INDEX tasks_status_due ON tasks(status, due_at);
  CREATE INDEX tasks_parent ON tasks(parent_id);

  CREATE TABLE source_items (
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    content_hash TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','gone','rejected')),
    snapshot TEXT NOT NULL DEFAULT '{}',
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (source_type, source_id)
  );

  CREATE TABLE sync_cursors (
    source TEXT PRIMARY KEY,
    cursor TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE dependencies (
    blocker_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    blocked_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (blocker_id, blocked_id),
    CHECK (blocker_id <> blocked_id)
  );

  CREATE TABLE comments (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    author TEXT NOT NULL CHECK (author IN ('human','agent','system')),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX comments_task ON comments(task_id);

  CREATE TABLE links (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    title TEXT,
    kind TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX links_task ON links(task_id);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    task_id TEXT,
    actor TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX events_task ON events(task_id);

  CREATE TABLE rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    definition TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE views (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    filter TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // 2: goals (initiatives/teammates-and-goals.md). A goal links to projects and tasks; status is
  // always set by hand, and progress is either typed in or counted from linked work.
  `
  CREATE TABLE goals (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    parent_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
    period_label TEXT,
    starts_on TEXT,
    ends_on TEXT,
    status TEXT NOT NULL DEFAULT 'on_track' CHECK (status IN ('on_track','at_risk','off_track','achieved','dropped')),
    status_note TEXT NOT NULL DEFAULT '',
    status_updated_at TEXT,
    progress_mode TEXT NOT NULL DEFAULT 'tasks' CHECK (progress_mode IN ('manual','tasks')),
    current_value REAL,
    target_value REAL,
    unit TEXT,
    position REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX goals_parent ON goals(parent_id);

  CREATE TABLE goal_links (
    goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    CHECK ((project_id IS NULL) <> (task_id IS NULL))
  );
  CREATE UNIQUE INDEX goal_links_project ON goal_links(goal_id, project_id) WHERE project_id IS NOT NULL;
  CREATE UNIQUE INDEX goal_links_task ON goal_links(goal_id, task_id) WHERE task_id IS NOT NULL;
  `,
  // 3: untrusted_text. Whether a task's title and notes were written by a third party used to be
  // re-derived from source_type by every reader, which meant anything built FROM an untrusted task
  // (a rule's follow-up, the next occurrence of a recurrence) silently came out trusted, because it
  // carries no source of its own. Storing it makes the answer travel with the task. Backfilled from
  // source_type, which was the whole rule until now.
  `
  ALTER TABLE tasks ADD COLUMN untrusted_text INTEGER NOT NULL DEFAULT 0;
  UPDATE tasks SET untrusted_text = 1 WHERE source_type IN ('github','gmail','gdrive','gcal');
  `,
  // 4: source_items.gone_resolution. Records what markSourceGone actually DID to the task, not
  // what it was asked to do: 'complete' or 'drop' when it closed the task itself, NULL when it
  // left the task alone ('keep', or a resolution that did not apply). upsertFromSource revives a
  // closed task only when this system was the one that closed it, so a gmail thread rotating out
  // of the sync window and back can no longer reopen work the human finished.
  // Existing rows stay NULL on purpose: we cannot know who closed them, and not reviving is the
  // safe direction.
  `
  ALTER TABLE source_items ADD COLUMN gone_resolution TEXT;
  `,
  // 5: applied_ops. One row per offline edit a dashboard replayed through POST /api/outbox
  // (initiatives/offline-clone.md). op_id makes a retried batch apply nothing twice. edited_at is
  // when the edit was made on the device, and the event id range says which events it produced,
  // so a later merge can weigh this change by when it was made rather than by when it arrived.
  `
  CREATE TABLE applied_ops (
    op_id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    task_id TEXT,
    edited_at TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    first_event_id INTEGER NOT NULL,
    last_event_id INTEGER NOT NULL,
    result TEXT NOT NULL
  );
  CREATE INDEX applied_ops_task ON applied_ops(task_id);
  `,
  // 6: tasks.assignee (initiatives/teammates-and-goals.md, Teammates Step 1). Who a task is handed
  // to: NULL means nobody has claimed it, and until teammates exist that means the owner. A plain name
  // for now, not a reference, because the teammate runtime that would own the list does not exist
  // yet. Existing rows stay NULL, which is the only true answer for them.
  `
  ALTER TABLE tasks ADD COLUMN assignee TEXT;
  `,
  // 7: events.actor_name, comments.author_name. An MCP connection may declare a name for itself
  // (--agent-name over stdio, X-Agent-Name over HTTP), which rides beside the actor it already
  // recorded, so history can read "agent scribe" instead of just "agent". NULL when no name was
  // declared, which is every row before this migration and most human/system/rule writes after
  // it. The actor enum itself (human/agent/system/rule) does not change: the name is data on the
  // row, self-declared by the connection, never an identity or a permission.
  `
  ALTER TABLE events ADD COLUMN actor_name TEXT;
  ALTER TABLE comments ADD COLUMN author_name TEXT;
  `,
];

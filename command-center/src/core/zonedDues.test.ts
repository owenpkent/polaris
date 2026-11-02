// Rows written before a zoned due was stored as local time (dueAt.ts) are brought into that form
// by migration 13 (schema.ts), so the server reads them as the dashboard shows them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './index.ts';
import { MIGRATIONS, localizeZonedDues } from './schema.ts';
import { runView } from '../automation/views.ts';

test('a database from before the migration: its zoned dues become local time on upgrade, and the views agree', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-zoned-dues-'));
  const path = join(dir, 'cc.db');
  const first = openStore(path, { timezone: 'America/Chicago' });
  const evening = first.createTask({ title: 'Evening in Chicago' });
  const midnight = first.createTask({ title: 'Midnight UTC is a day' });
  const floating = first.createTask({ title: 'Already local', dueAt: '2026-10-20T09:00' });
  // The rows as an older store left them: the moment, with its zone.
  first.db.run('UPDATE tasks SET due_at = ? WHERE id = ?', ['2026-10-20T04:30:00.000Z', evening.id]);
  first.db.run('UPDATE tasks SET due_at = ? WHERE id = ?', ['2026-10-21T00:00:00.000Z', midnight.id]);
  // The version just before migration 13, so it and whatever came after it run on open.
  first.db.run('UPDATE schema_version SET version = ?', [MIGRATIONS.indexOf(localizeZonedDues)]);
  first.db.close();

  const store = openStore(path, { timezone: 'America/Chicago' });
  // Closed before the folder goes: Windows will not remove an open database.
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(store.db.get<{ version: number }>('SELECT version FROM schema_version')?.version, MIGRATIONS.length, 'the version moved with the data');
  assert.equal(store.requireTask(evening.id).dueAt, '2026-10-19T23:30', 'the evening before, as the dashboard shows it');
  assert.equal(store.requireTask(midnight.id).dueAt, '2026-10-21', 'midnight UTC is the date, as a write stores it');
  assert.equal(store.requireTask(floating.id).dueAt, '2026-10-20T09:00', 'a local value is left alone');
  const overdue = runView(store, 'overdue', '2026-10-20').tasks.map((x) => x.id);
  assert.ok(overdue.includes(evening.id), 'overdue on the 20th for the server, as the dashboard groups it');
  assert.ok(!overdue.includes(midnight.id));
  assert.ok(store.searchTasks({ dueAfter: '2026-10-20T04:30:00.000Z' }).some((x) => x.id === evening.id), 'the value it was written with still finds it: the lower bound is inclusive');
  assert.ok(store.searchTasks({ dueBefore: '2026-10-20T04:30:00.000Z' }).every((x) => x.id !== evening.id), 'and the exclusive upper bound leaves it out');
});

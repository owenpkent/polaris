import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeApp } from '../http/test-support.ts';
import { commands } from './checklistCommands.ts';

const cmd = (name: string) => commands.find((c) => c.name === name)!;

function harness(t: { after: (fn: () => void) => void }) {
  const app = fakeApp();
  t.after(() => app.close());
  const out: string[] = [];
  const ctx = { openApp: () => ({ ...app, close: () => undefined }), stdout: (s: string) => out.push(s), stderr: () => undefined };
  return { app, out, ctx };
}

test('checklist add, list, and show: the owner makes a checklist from the command line and reads it back', async (t) => {
  const { app, out, ctx } = harness(t);

  assert.equal(await cmd('checklist list').run([], ctx), 0);
  assert.equal(out.at(-1), 'No checklists yet.');

  assert.equal(await cmd('checklist add').run(['Packing:', 'weekend', 'trip', '--items', 'Passport; Charger;; Toothbrush', '--notes', 'Check the forecast.'], ctx), 0);
  const [c] = app.store.listChecklists();
  assert.equal(c.name, 'Packing: weekend trip');
  assert.deepEqual(c.items, ['Passport', 'Charger', 'Toothbrush']);
  assert.equal(c.notes, 'Check the forecast.');
  assert.equal(out.at(-1), `${c.id}  Packing: weekend trip  (3 items)`);
  assert.equal(app.store.eventsSince(0).at(-1)?.actor, 'human');

  assert.equal(await cmd('checklist list').run([], ctx), 0);
  assert.equal(out.at(-1), `${c.id}  Packing: weekend trip  (3 items)`);
  assert.equal(await cmd('checklist list').run(['--json'], ctx), 0);
  assert.deepEqual(JSON.parse(out.at(-1)!).map((x: { id: string }) => x.id), [c.id]);

  assert.equal(await cmd('checklist show').run(['packing:', 'WEEKEND', 'trip'], ctx), 0);
  assert.equal(out.at(-1), `Packing: weekend trip (${c.id})\n\nCheck the forecast.\n\n  1. Passport\n  2. Charger\n  3. Toothbrush`);

  assert.throws(() => cmd('checklist add').run(['--items', 'a'], ctx), /name is required/);
  assert.throws(() => cmd('checklist show').run(['Nothing'], ctx), /No checklist matches "Nothing"/);
  assert.throws(() => cmd('checklist show').run([], ctx), /id or name is required/);
});

test('checklist add with no items makes an empty checklist, and show says so', async (t) => {
  const { app, out, ctx } = harness(t);
  assert.equal(await cmd('checklist add').run(['Kitchen'], ctx), 0);
  const [c] = app.store.listChecklists();
  assert.deepEqual(c.items, []);
  assert.match(out.at(-1)!, /\(0 items\)$/);
  assert.equal(await cmd('checklist show').run([c.id], ctx), 0);
  assert.match(out.at(-1)!, /No items yet\.$/);
});

test('checklist start: a fresh task with the items as subtasks, in a project and with a due date, and the template unchanged', async (t) => {
  const { app, out, ctx } = harness(t);
  const project = app.store.createProject({ name: 'Home' });
  const c = app.store.createChecklist({ name: 'Clean the kitchen', items: ['Dishes', 'Floor'] });

  assert.equal(await cmd('checklist start').run(['Clean', 'the', 'kitchen', '--project', 'Home', '--due', '2026-09-13', '--title', 'Kitchen, Sunday'], ctx), 0);
  const [task] = app.store.searchTasks({ parentId: null });
  assert.equal(task.title, 'Kitchen, Sunday');
  assert.equal(task.projectId, project.id);
  assert.equal(task.dueAt, '2026-09-13');
  assert.deepEqual(app.store.subtasks(task.id).map((s) => s.title), ['Dishes', 'Floor']);
  const lines = out.at(-1)!.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^\[ \] t_[0-9a-z]+ Kitchen, Sunday \(Home\) due 2026-09-13$/);
  assert.match(lines[1], /^  \[ \] t_[0-9a-z]+ Dishes \(Home\)$/);
  assert.deepEqual(app.store.getChecklist(c.id)!.items, ['Dishes', 'Floor']);
  for (const e of app.store.eventsSince(0).filter((ev) => ev.kind === 'task.created')) assert.equal(e.actor, 'human');

  assert.equal(await cmd('checklist start').run([c.id], ctx), 0);
  assert.equal(app.store.searchTasks({ parentId: null }).length, 2);

  assert.throws(() => cmd('checklist start').run([c.id, '--project', 'Nowhere'], ctx), /No project matches "Nowhere"/);
  assert.throws(() => cmd('checklist start').run(['Nothing'], ctx), /No checklist matches/);
  assert.equal(app.store.searchTasks({ parentId: null }).length, 2);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_TOKENS, api, fakeApp, withServer } from './test-support.ts';

test('checklists: create, read, update, and delete over REST', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    assert.deepEqual((await api(base, 'GET', '/api/checklists')).json, { checklists: [] });

    const created = await api(base, 'POST', '/api/checklists', { name: '  Clean the kitchen ', items: ['Dishes', ' ', 'Counters'] });
    assert.equal(created.status, 201);
    const id = created.json.checklist.id as string;
    assert.equal(created.json.checklist.name, 'Clean the kitchen');
    assert.deepEqual(created.json.checklist.items, ['Dishes', 'Counters']);
    assert.equal(created.json.checklist.notes, '');

    const one = await api(base, 'GET', `/api/checklists/${id}`);
    assert.equal(one.status, 200);
    assert.deepEqual(one.json.checklist, created.json.checklist);

    const patched = await api(base, 'PATCH', `/api/checklists/${id}`, { notes: 'Every Sunday.', items: ['Counters', 'Dishes', 'Floor'] });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.checklist.name, 'Clean the kitchen');
    assert.equal(patched.json.checklist.notes, 'Every Sunday.');
    assert.deepEqual(patched.json.checklist.items, ['Counters', 'Dishes', 'Floor']);

    const list = await api(base, 'GET', '/api/checklists');
    assert.deepEqual(list.json.checklists.map((c: { id: string }) => c.id), [id]);

    assert.equal((await api(base, 'DELETE', `/api/checklists/${id}`)).status, 204);
    assert.equal((await api(base, 'GET', `/api/checklists/${id}`)).status, 404);
    assert.equal((await api(base, 'DELETE', `/api/checklists/${id}`)).status, 404);
    assert.equal((await api(base, 'PATCH', `/api/checklists/${id}`, { name: 'x' })).status, 404);
  });
});

test('checklists: invalid bodies are 400 with nothing written', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const existing = app.store.createChecklist({ name: 'Kitchen', items: ['Dishes'] });
  const before = app.store.lastEventId();
  await withServer(app, {}, async (base) => {
    for (const body of [{}, { name: '   ' }, { name: 'x', items: 'Dishes' }, { name: 'x', extra: true }, { name: 'x', items: [1] }]) {
      const res = await api(base, 'POST', '/api/checklists', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.json.error.code, 'ValidationError');
    }
    const tooMany = await api(base, 'POST', '/api/checklists', { name: 'Big', items: Array.from({ length: 201 }, (_, i) => `item ${i}`) });
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.json.error.message, /at most 200 items/);
    assert.equal((await api(base, 'PATCH', `/api/checklists/${existing.id}`, {})).status, 400);
    assert.equal((await api(base, 'PATCH', `/api/checklists/${existing.id}`, { name: '' })).status, 400);
  });
  assert.equal(app.store.lastEventId(), before);
  assert.equal(app.store.listChecklists().length, 1);
});

test('checklists: start creates an open task with ordered subtasks, as the human, and can be done twice', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const project = app.store.createProject({ name: 'Home' });
  const checklist = app.store.createChecklist({ name: 'Packing: weekend trip', items: ['Passport', 'Charger', 'Toothbrush'] });
  await withServer(app, {}, async (base) => {
    const start = app.store.lastEventId();
    const res = await api(base, 'POST', `/api/checklists/${checklist.id}/start`, { projectId: project.id, dueAt: '2026-09-14' });
    assert.equal(res.status, 201);
    assert.equal(res.json.task.title, 'Packing: weekend trip');
    assert.equal(res.json.task.status, 'open');
    assert.equal(res.json.task.projectId, project.id);
    assert.equal(res.json.task.dueAt, '2026-09-14');
    assert.deepEqual(res.json.subtasks.map((s: { title: string }) => s.title), ['Passport', 'Charger', 'Toothbrush']);
    const events = app.store.eventsSince(start);
    assert.deepEqual(events.map((e) => [e.kind, e.actor]), Array(4).fill(['task.created', 'human']));

    // The task reads back like any other, subtasks in order, and the template is untouched.
    const detail = await api(base, 'GET', `/api/tasks/${res.json.task.id}`);
    assert.deepEqual(detail.json.subtasks.map((s: { title: string }) => s.title), ['Passport', 'Charger', 'Toothbrush']);
    assert.deepEqual((await api(base, 'GET', `/api/checklists/${checklist.id}`)).json.checklist, checklist);

    const again = await api(base, 'POST', `/api/checklists/${checklist.id}/start`, { title: 'Packing: Lisbon' });
    assert.equal(again.status, 201);
    assert.equal(again.json.task.title, 'Packing: Lisbon');
    assert.equal(again.json.task.projectId, null);

    // Without a body at all, too.
    assert.equal((await api(base, 'POST', `/api/checklists/${checklist.id}/start`)).status, 201);
  });
});

test('checklists: a start that cannot complete creates nothing', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const checklist = app.store.createChecklist({ name: 'Kitchen', items: ['Dishes'] });
  const empty = app.store.createChecklist({ name: 'Empty' });
  const tasks = app.store.countTasks({});
  await withServer(app, {}, async (base) => {
    assert.equal((await api(base, 'POST', `/api/checklists/${checklist.id}/start`, { projectId: 'p_missing000' })).status, 404);
    assert.equal((await api(base, 'POST', `/api/checklists/${checklist.id}/start`, { dueAt: 'soon' })).status, 400);
    assert.equal((await api(base, 'POST', `/api/checklists/${checklist.id}/start`, { status: 'done' })).status, 400, 'a started task is always open');
    assert.equal((await api(base, 'POST', `/api/checklists/${empty.id}/start`, {})).status, 400);
    assert.equal((await api(base, 'POST', '/api/checklists/cl_missing00/start', {})).status, 404);
  });
  assert.equal(app.store.countTasks({}), tasks);
});

test('checklists: deleting one over REST leaves the tasks started from it', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const checklist = app.store.createChecklist({ name: 'Kitchen', items: ['Dishes', 'Floor'] });
  const { task } = app.store.startChecklist(checklist.id);
  await withServer(app, {}, async (base) => {
    assert.equal((await api(base, 'DELETE', `/api/checklists/${checklist.id}`)).status, 204);
    const detail = await api(base, 'GET', `/api/tasks/${task.id}`);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.json.subtasks.map((s: { title: string }) => s.title), ['Dishes', 'Floor']);
  });
});

test('checklists: save as checklist makes a template from a task, and refuses third-party text', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const task = app.store.createTask({ title: 'Move flat' });
  app.store.createTask({ title: 'Book van', parentId: task.id });
  app.store.createTask({ title: 'Hand back keys', parentId: task.id });
  const bare = app.store.createTask({ title: 'Alone' });
  const issue = app.store.upsertFromSource({ sourceType: 'github', sourceId: 'o/r#1', title: 'Release', contentHash: 'h' }).task;
  app.store.acceptInboxItem(issue.id);
  app.store.createTask({ title: 'Tag', parentId: issue.id });
  await withServer(app, {}, async (base) => {
    const saved = await api(base, 'POST', `/api/tasks/${task.id}/save-as-checklist`, {});
    assert.equal(saved.status, 201);
    assert.equal(saved.json.checklist.name, 'Move flat');
    assert.deepEqual(saved.json.checklist.items, ['Book van', 'Hand back keys']);
    const named = await api(base, 'POST', `/api/tasks/${task.id}/save-as-checklist`, { name: 'Moving house' });
    assert.equal(named.json.checklist.name, 'Moving house');

    assert.equal((await api(base, 'POST', `/api/tasks/${bare.id}/save-as-checklist`, {})).status, 400);
    const refused = await api(base, 'POST', `/api/tasks/${issue.id}/save-as-checklist`, {});
    assert.equal(refused.status, 400);
    assert.match(refused.json.error.message, /third party/);
    assert.equal((await api(base, 'POST', '/api/tasks/t_missing000/save-as-checklist', {})).status, 404);
  });
  assert.equal(app.store.listChecklists().length, 2);
  assert.deepEqual(app.store.eventsSince(0).filter((e) => e.kind === 'checklist.created').map((e) => e.actor), ['human', 'human']);
});

test('checklists: the MCP tokens cannot reach the checklist routes', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const checklist = app.store.createChecklist({ name: 'Kitchen', items: ['Dishes'] });
  await withServer(app, {}, async (base) => {
    for (const token of [TEST_TOKENS.mcp, TEST_TOKENS.mcpReadonly]) {
      for (const [method, path] of [['GET', '/api/checklists'], ['POST', `/api/checklists/${checklist.id}/start`], ['DELETE', `/api/checklists/${checklist.id}`]]) {
        const res = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
        assert.equal(res.status, 401, `${method} ${path}`);
      }
    }
  });
  assert.equal(app.store.countTasks({}), 0);
  assert.equal(app.store.listChecklists().length, 1);
});

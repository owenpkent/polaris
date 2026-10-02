import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, fakeApp, withServer } from './test-support.ts';

test('goals: create, read, update, and delete over REST', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const empty = await api(base, 'GET', '/api/goals');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json, { goals: [], total: 0, vision: '' });

    const created = await api(base, 'POST', '/api/goals', { title: '  Ship the installer  ', periodLabel: '2026 Q4', endsOn: '2026-12-31' });
    assert.equal(created.status, 201);
    const id = created.json.goal.id as string;
    assert.equal(created.json.goal.title, 'Ship the installer');
    assert.equal(created.json.goal.status, 'on_track');
    assert.deepEqual(created.json.goal.progress, { mode: 'tasks', done: 0, total: 0, percent: null, openTasks: 0 });
    assert.deepEqual(created.json.linkedProjects, []);
    assert.deepEqual(created.json.openTasks, []);

    const patched = await api(base, 'PATCH', `/api/goals/${id}`, { status: 'at_risk', statusNote: 'Certificate is late' });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.goal.status, 'at_risk');
    assert.equal(patched.json.goal.statusNote, 'Certificate is late');

    const one = await api(base, 'GET', `/api/goals/${id}`);
    assert.equal(one.json.goal.id, id);

    const list = await api(base, 'GET', '/api/goals');
    assert.deepEqual(list.json.goals.map((g: { id: string }) => g.id), [id]);

    const deleted = await api(base, 'DELETE', `/api/goals/${id}`);
    assert.equal(deleted.status, 204);
    assert.equal((await api(base, 'GET', `/api/goals/${id}`)).status, 404);
    assert.equal((await api(base, 'DELETE', `/api/goals/${id}`)).status, 404);
  });
});

test('goals: writes over REST are recorded as the human actor', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const start = app.store.lastEventId();
    const created = await api(base, 'POST', '/api/goals', { title: 'x' });
    await api(base, 'PATCH', `/api/goals/${created.json.goal.id}`, { status: 'achieved' });
    const events = app.store.eventsSince(start);
    assert.deepEqual(events.map((e) => [e.kind, e.actor]), [['goal.created', 'human'], ['goal.updated', 'human']]);
  });
});

test('goals: closed goals are hidden from the list unless includeClosed is set', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  app.store.createGoal({ title: 'open' });
  app.store.createGoal({ title: 'finished', status: 'achieved' });
  await withServer(app, {}, async (base) => {
    const open = await api(base, 'GET', '/api/goals');
    assert.deepEqual(open.json.goals.map((g: { title: string }) => g.title), ['open']);
    // total counts closed goals too, even when they are hidden from the list.
    assert.equal(open.json.total, 2);
    const all = await api(base, 'GET', '/api/goals?includeClosed=1');
    assert.deepEqual(all.json.goals.map((g: { title: string }) => g.title), ['open', 'finished']);
  });
});

test('goals: invalid bodies are 400, with nothing created', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const bad = [
      {},
      { title: '   ' },
      { title: 'x', status: 'winning' },
      { title: 'x', progressMode: 'vibes' },
      { title: 'x', endsOn: '31/12/2026' },
      { title: 'x', targetValue: 'a lot' },
      { title: 'x', surprise: true },
      { title: 'x', startsOn: '2026-12-31', endsOn: '2026-01-01' },
      { title: 'x', parentId: 'g_missing' },
    ];
    for (const body of bad) {
      const res = await api(base, 'POST', '/api/goals', body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(app.store.listGoals({ includeClosed: true }).length, 0);
    assert.equal((await api(base, 'PATCH', '/api/goals/g_missing', { title: 'x' })).status, 404);
  });
});

test('goals: a goal cannot be moved under its own sub-goal', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const parent = app.store.createGoal({ title: 'parent' });
  const child = app.store.createGoal({ title: 'child', parentId: parent.id });
  await withServer(app, {}, async (base) => {
    const res = await api(base, 'PATCH', `/api/goals/${parent.id}`, { parentId: child.id });
    assert.equal(res.status, 400);
    assert.equal(app.store.getGoal(parent.id)?.parentId, null);
  });
});

test('goals: link and unlink a project (by slug) and a task, with names and open tasks in the payload', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const project = app.store.upsertProject({ slug: 'octavium', name: 'Octavium' });
  const milestone = app.store.createTask({ title: 'Signed release', projectId: project.id, isMilestone: true });
  const chore = app.store.createTask({ title: 'Fix a typo', projectId: project.id });
  const loose = app.store.createTask({ title: 'Buy the certificate' });
  const goal = app.store.createGoal({ title: 'Ship the installer' });

  await withServer(app, {}, async (base) => {
    const linkedProject = await api(base, 'POST', `/api/goals/${goal.id}/links`, { project: 'octavium' });
    assert.equal(linkedProject.status, 201);
    assert.deepEqual(linkedProject.json.linkedProjects, [{ id: project.id, slug: 'octavium', name: 'Octavium' }]);

    const linkedTask = await api(base, 'POST', `/api/goals/${goal.id}/links`, { taskId: loose.id });
    assert.deepEqual(linkedTask.json.linkedTasks.map((x: { id: string }) => x.id), [loose.id]);
    // Counted: the project milestone and the linked task. Open work also includes the typo fix.
    assert.deepEqual(linkedTask.json.goal.progress, { mode: 'tasks', done: 0, total: 2, percent: 0, openTasks: 3 });
    assert.deepEqual(
      linkedTask.json.openTasks.map((x: { id: string }) => x.id).sort(),
      [milestone.id, chore.id, loose.id].sort(),
    );

    // Linking the same project again changes nothing.
    await api(base, 'POST', `/api/goals/${goal.id}/links`, { project: project.id });
    assert.equal(app.store.goalLinks(goal.id).length, 2);

    const unlinked = await api(base, 'POST', `/api/goals/${goal.id}/unlink`, { project: 'octavium' });
    assert.equal(unlinked.status, 200);
    assert.deepEqual(unlinked.json.linkedProjects, []);
    assert.deepEqual(unlinked.json.goal.progress, { mode: 'tasks', done: 0, total: 1, percent: 0, openTasks: 1 });
  });
});

test('goals: link bodies need exactly one target, and unknown targets are 404', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const goal = app.store.createGoal({ title: 'x' });
  const task = app.store.createTask({ title: 't' });
  await withServer(app, {}, async (base) => {
    assert.equal((await api(base, 'POST', `/api/goals/${goal.id}/links`, {})).status, 400);
    assert.equal((await api(base, 'POST', `/api/goals/${goal.id}/links`, { project: 'p', taskId: task.id })).status, 400);
    assert.equal((await api(base, 'POST', `/api/goals/${goal.id}/links`, { project: 'no-such-project' })).status, 404);
    assert.equal((await api(base, 'POST', `/api/goals/${goal.id}/links`, { taskId: 't_missing' })).status, 404);
    assert.equal((await api(base, 'POST', '/api/goals/g_missing/links', { taskId: task.id })).status, 404);
    assert.equal((await api(base, 'POST', '/api/goals/g_missing/unlink', { taskId: task.id })).status, 404);
    assert.equal(app.store.goalLinks(goal.id).length, 0);
  });
});

test('goals: the vision statement is saved and returned with the list', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const saved = await api(base, 'PATCH', '/api/goal-vision', { text: 'Ship open tools people can use with one hand.' });
    assert.equal(saved.status, 200);
    const list = await api(base, 'GET', '/api/goals');
    assert.equal(list.json.vision, 'Ship open tools people can use with one hand.');
    assert.equal((await api(base, 'PATCH', '/api/goal-vision', { text: 42 })).status, 400);
    assert.equal((await api(base, 'PATCH', '/api/goal-vision', { text: 'x'.repeat(4001) })).status, 400);
  });
});

test('goals: every goal route needs the bearer token', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const goal = app.store.createGoal({ title: 'x' });
  await withServer(app, {}, async (base) => {
    const attempts: [string, string][] = [
      ['GET', '/api/goals'], ['POST', '/api/goals'], ['GET', `/api/goals/${goal.id}`], ['PATCH', `/api/goals/${goal.id}`],
      ['DELETE', `/api/goals/${goal.id}`], ['POST', `/api/goals/${goal.id}/links`], ['POST', `/api/goals/${goal.id}/unlink`],
      ['PATCH', '/api/goal-vision'],
    ];
    for (const [method, path] of attempts) {
      const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
    assert.ok(app.store.getGoal(goal.id), 'an unauthenticated DELETE must not remove the goal');
  });
});

test('goals: the list carries each goal\'s linked work, and a task names the goals linked to it', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const project = app.store.upsertProject({ slug: 'octavium', name: 'Octavium' });
  const inProject = app.store.createTask({ title: 'Signed release', projectId: project.id });
  const loose = app.store.createTask({ title: 'Buy the certificate' });
  const done = app.store.createTask({ title: 'Already done' });
  app.store.completeTask(done.id);
  const parent = app.store.createGoal({ title: 'Ship the installer' });
  const child = app.store.createGoal({ title: 'Sign it', parentId: parent.id });
  const closedChild = app.store.createGoal({ title: 'Notarize it', parentId: parent.id, status: 'achieved' });
  const other = app.store.createGoal({ title: 'Something else' });
  app.store.linkGoal(parent.id, { projectId: project.id });
  app.store.linkGoal(child.id, { taskId: loose.id });
  app.store.linkGoal(child.id, { taskId: done.id });
  app.store.linkGoal(closedChild.id, { taskId: done.id });
  app.store.linkGoal(other.id, { taskId: loose.id });

  await withServer(app, {}, async (base) => {
    const list = await api(base, 'GET', '/api/goals');
    const work = (id: string): { projectIds: string[]; taskIds: string[] } => {
      const { linkedWork } = list.json.goals.find((g: { id: string }) => g.id === id);
      return { projectIds: [...linkedWork.projectIds].sort(), taskIds: [...linkedWork.taskIds].sort() };
    };
    // The parent carries its own project and its sub-goals' tasks, the closed sub-goal's too. The
    // dashboard decides from its task list which of these are open, so a done task is listed here.
    assert.deepEqual(work(parent.id), { projectIds: [project.id], taskIds: [loose.id, done.id].sort() });
    assert.deepEqual(work(child.id), { projectIds: [], taskIds: [loose.id, done.id].sort() });
    assert.ok(!list.json.goals.some((g: { id: string }) => g.id === closedChild.id), 'a closed goal is not listed');
    // A task in the project is reached through the project, not listed by id.
    assert.ok(!work(parent.id).taskIds.includes(inProject.id));

    const detail = await api(base, 'GET', `/api/tasks/${loose.id}`);
    assert.deepEqual(detail.json.goals.map((g: { title: string }) => g.title), ['Sign it', 'Something else']);
    // Reached only through its project, so not listed on the task.
    assert.deepEqual((await api(base, 'GET', `/api/tasks/${inProject.id}`)).json.goals, []);
  });
});

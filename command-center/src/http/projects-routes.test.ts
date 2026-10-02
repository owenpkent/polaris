import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, fakeApp, withServer } from './test-support.ts';

test('projects: create, edit, and archive over REST, with no repo needed', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const created = await api(base, 'POST', '/api/projects', { name: '  Household admin  ', type: 'Personal', description: '# Notes\n\nBills and forms.' });
    assert.equal(created.status, 201);
    assert.equal(created.json.project.name, 'Household admin');
    assert.equal(created.json.project.slug, 'household-admin');
    assert.equal(created.json.project.github, null);
    assert.equal(created.json.project.path, null);

    const patched = await api(base, 'PATCH', '/api/projects/household-admin', { status: 'Active', description: null });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.project.status, 'Active');
    assert.equal(patched.json.project.description, null);
    assert.equal(patched.json.project.type, 'Personal', 'a field left out of the patch is untouched');

    const renamed = await api(base, 'PATCH', '/api/projects/household-admin', { name: 'Home admin' });
    assert.equal(renamed.json.project.name, 'Home admin');
    assert.equal(renamed.json.project.slug, 'household-admin', 'the slug never changes, so links and source ids stay valid');

    const archived = await api(base, 'PATCH', '/api/projects/household-admin', { archived: true });
    assert.equal(archived.json.project.archived, true);
    const visible = await api(base, 'GET', '/api/projects');
    assert.deepEqual(visible.json.projects, []);
    const all = await api(base, 'GET', '/api/projects?includeArchived=1');
    assert.deepEqual(all.json.projects.map((p: { slug: string }) => p.slug), ['household-admin']);
  });
});

test('projects: a task can be filed under a project made by hand', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    await api(base, 'POST', '/api/projects', { name: 'Garden' });
    const task = await api(base, 'POST', '/api/tasks', { title: 'Order seeds', project: 'garden' });
    assert.equal(task.status, 201);
    const project = await api(base, 'GET', '/api/projects/garden');
    assert.deepEqual(project.json.tasks.map((x: { title: string }) => x.title), ['Order seeds']);
  });
});

test('projects: the GitHub repo is normalized to the URL form the sync maps from', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const short = await api(base, 'POST', '/api/projects', { name: 'Short form', github: 'example-org/sample-repo' });
    assert.equal(short.json.project.github, 'https://github.com/example-org/sample-repo');
    const ssh = await api(base, 'POST', '/api/projects', { name: 'Ssh form', github: 'git@github.com:example-org/sample-repo.git' });
    assert.equal(ssh.json.project.github, 'https://github.com/example-org/sample-repo');
    const cleared = await api(base, 'PATCH', '/api/projects/short-form', { github: null });
    assert.equal(cleared.json.project.github, null);
    assert.equal((await api(base, 'POST', '/api/projects', { name: 'Elsewhere', github: 'https://gitlab.com/a/b' })).status, 400);
  });
});

test('projects: bad input is refused', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    assert.equal((await api(base, 'POST', '/api/projects', { name: '   ' })).status, 400);
    assert.equal((await api(base, 'POST', '/api/projects', { name: '!!!' })).status, 400, 'a name with no letter or digit has no slug');
    assert.equal((await api(base, 'POST', '/api/projects', { name: 'Garden' })).status, 201);
    assert.equal((await api(base, 'POST', '/api/projects', { name: 'garden' })).status, 400, 'same slug as an existing project');
    assert.equal((await api(base, 'PATCH', '/api/projects/garden', { name: '' })).status, 400);
    assert.equal((await api(base, 'PATCH', '/api/projects/nowhere', { status: 'x' })).status, 404);
    // path, todoFile, meta, and slug belong to the importers and the store, not to this route.
    for (const field of ['path', 'todoFile', 'meta', 'slug']) {
      assert.equal((await api(base, 'PATCH', '/api/projects/garden', { [field]: 'x' })).status, 400, field);
    }
    assert.equal((await api(base, 'DELETE', '/api/projects/garden')).status, 405, 'there is no delete route');
  });
});

test('projects: writes over REST are recorded as the human actor', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const start = app.store.lastEventId();
    await api(base, 'POST', '/api/projects', { name: 'Garden' });
    await api(base, 'PATCH', '/api/projects/garden', { status: 'Active' });
    assert.deepEqual(app.store.eventsSince(start).map((e) => [e.kind, e.actor]), [['project.upserted', 'human'], ['project.upserted', 'human']]);
  });
});

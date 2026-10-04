import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_TOKEN, api, fakeApp, withServer } from './test-support.ts';

test('GET /api/health reports counts for the seeded store', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  app.store.createTask({ title: 'inbox item', status: 'inbox' }, 'human');
  app.store.createTask({ title: 'overdue item', dueAt: '2020-01-01' }, 'human');
  await withServer(app, {}, async (base) => {
    const { status, json } = await api(base, 'GET', '/api/health');
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.today, '2026-09-12');
    assert.equal(json.counts.inbox, 1);
    assert.equal(json.counts.overdue, 1);
    assert.equal(typeof json.version, 'string');
  });
});

test('GET/PATCH /api/settings/agent: fallback, round trip, 400 on invalid', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const initial = await api(base, 'GET', '/api/settings/agent');
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.json, { defaultAgentName: 'claude-code' });

    const saved = await api(base, 'PATCH', '/api/settings/agent', { defaultAgentName: 'scribe' });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json, { defaultAgentName: 'scribe' });

    const reread = await api(base, 'GET', '/api/settings/agent');
    assert.deepEqual(reread.json, { defaultAgentName: 'scribe' });

    assert.equal((await api(base, 'PATCH', '/api/settings/agent', { defaultAgentName: '' })).status, 400);
    assert.equal((await api(base, 'PATCH', '/api/settings/agent', { defaultAgentName: 'x'.repeat(41) })).status, 400);
    assert.equal((await api(base, 'PATCH', '/api/settings/agent', { defaultAgentName: '<script>' })).status, 400);
    assert.equal((await api(base, 'PATCH', '/api/settings/agent', { defaultAgentName: 42 })).status, 400);
    // A rejected PATCH must not clobber the last good value.
    assert.deepEqual((await api(base, 'GET', '/api/settings/agent')).json, { defaultAgentName: 'scribe' });
  });
});

test('GET /api/projects returns counts per project', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const project = app.store.upsertProject({ slug: 'nimbus', name: 'Project Nimbus' });
  app.store.createTask({ title: 'open task', projectId: project.id }, 'human');
  app.store.createTask({ title: 'inbox task', projectId: project.id, status: 'inbox' }, 'human');
  await withServer(app, {}, async (base) => {
    const { status, json } = await api(base, 'GET', '/api/projects');
    assert.equal(status, 200);
    const row = json.projects.find((p: { id: string }) => p.id === project.id);
    assert.equal(row.counts.open, 1);
    assert.equal(row.counts.inbox, 1);
  });
});

test('GET /api/projects/:ref resolves by slug, name, or id and lists sections/tasks in position order', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const project = app.store.upsertProject({ slug: 'nimbus', name: 'Project Nimbus' });
  const section = app.store.ensureSection(project.id, 'Backlog');
  const first = app.store.createTask({ title: 'first', projectId: project.id, sectionId: section.id }, 'human');
  app.store.createTask({ title: 'second', projectId: project.id, sectionId: section.id }, 'human');
  const dropped = app.store.createTask({ title: 'dropped one', projectId: project.id }, 'human');
  app.store.updateTask(dropped.id, { status: 'dropped' }, 'human');

  await withServer(app, {}, async (base) => {
    for (const ref of ['nimbus', 'Project Nimbus', project.id]) {
      const { status, json } = await api(base, 'GET', `/api/projects/${encodeURIComponent(ref)}`);
      assert.equal(status, 200, ref);
      assert.equal(json.project.id, project.id);
      assert.equal(json.sections.length, 1);
      assert.equal(json.sections[0].id, section.id);
      const titles = json.tasks.map((t: { id: string; title: string }) => t.title);
      assert.ok(!titles.includes('dropped one'));
      assert.equal(json.tasks[0].id, first.id);
    }
    const missing = await api(base, 'GET', '/api/projects/does-not-exist');
    assert.equal(missing.status, 404);
  });
});

test('POST /api/tasks creates a task, resolving a project ref and creating a section', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const project = app.store.upsertProject({ slug: 'nimbus', name: 'Project Nimbus' });
  const blocker = app.store.createTask({ title: 'blocker' }, 'human');
  await withServer(app, {}, async (base) => {
    const { status, json } = await api(base, 'POST', '/api/tasks', {
      title: 'New task', project: 'nimbus', section: 'Backlog', priority: 'high', blockedBy: [blocker.id],
    });
    assert.equal(status, 201);
    assert.equal(json.task.title, 'New task');
    assert.equal(json.task.projectId, project.id);
    assert.equal(json.task.priority, 'high');
    const section = app.store.listSections(project.id).find((s) => s.name === 'Backlog');
    assert.ok(section);
    assert.equal(json.task.sectionId, section!.id);
    assert.equal(app.store.blockersOf(json.task.id).length, 1);
  });
});

test('GET /api/tasks filters by status/project/text and rejects an invalid enum value', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const project = app.store.upsertProject({ slug: 'nimbus', name: 'Project Nimbus' });
  app.store.createTask({ title: 'alpha widget', projectId: project.id, status: 'open' }, 'human');
  app.store.createTask({ title: 'beta gadget', status: 'inbox' }, 'human');
  await withServer(app, {}, async (base) => {
    const byProject = await api(base, 'GET', `/api/tasks?project=nimbus`);
    assert.equal(byProject.json.tasks.length, 1);
    assert.equal(byProject.json.total, 1);

    const byText = await api(base, 'GET', `/api/tasks?text=widget`);
    assert.equal(byText.json.tasks.length, 1);
    assert.equal(byText.json.tasks[0].title, 'alpha widget');

    const byStatus = await api(base, 'GET', `/api/tasks?status=inbox`);
    assert.equal(byStatus.json.tasks.length, 1);

    const bad = await api(base, 'GET', `/api/tasks?status=not-a-status`);
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'ValidationError');
  });
});

test('GET /api/tasks/:id returns the full detail shape', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const blocker = app.store.createTask({ title: 'blocker' }, 'human');
  const task = app.store.createTask({ title: 'child' }, 'human');
  app.store.addDependency(blocker.id, task.id, 'human');
  app.store.addComment(task.id, 'a comment', 'human');
  app.store.addLink(task.id, 'https://example.com', 'Example', 'doc');
  await withServer(app, {}, async (base) => {
    const { status, json } = await api(base, 'GET', `/api/tasks/${task.id}`);
    assert.equal(status, 200);
    assert.equal(json.task.id, task.id);
    assert.equal(json.blockers.length, 1);
    assert.equal(json.blockers[0].id, blocker.id);
    assert.equal(json.comments.length, 1);
    assert.equal(json.links.length, 1);
    assert.ok(json.history.length >= 1);
    assert.deepEqual(json.subtasks, []);
  });
});

test('PATCH /api/tasks/:id updates fields', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const task = app.store.createTask({ title: 'before' }, 'human');
  await withServer(app, {}, async (base) => {
    const { status, json } = await api(base, 'PATCH', `/api/tasks/${task.id}`, { title: 'after', priority: 'urgent' });
    assert.equal(status, 200);
    assert.equal(json.task.title, 'after');
    assert.equal(json.task.priority, 'urgent');
  });
});

test('complete/reopen round trip, including the next occurrence of a recurring task', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const task = app.store.createTask({ title: 'weekly sync', dueAt: '2026-09-10', recurrence: 'FREQ=WEEKLY' }, 'human');
  await withServer(app, {}, async (base) => {
    const completed = await api(base, 'POST', `/api/tasks/${task.id}/complete`);
    assert.equal(completed.status, 200);
    assert.equal(completed.json.task.status, 'done');
    assert.ok(completed.json.next);
    assert.equal(completed.json.next.dueAt, '2026-09-17');

    const reopened = await api(base, 'POST', `/api/tasks/${task.id}/reopen`);
    assert.equal(reopened.status, 200);
    assert.equal(reopened.json.task.status, 'open');
  });
});

test('POST /api/tasks/:id/restore puts back a history entry, and the history says which can be', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const task = app.store.createTask({ title: 'Before' }, 'human');
  app.store.updateTask(task.id, { title: 'After' }, 'human');
  await withServer(app, {}, async (base) => {
    const detail = await api(base, 'GET', `/api/tasks/${task.id}`);
    const entries = detail.json.history as { id: number; kind: string; restore: Record<string, unknown> | null }[];
    assert.equal(entries.find((e) => e.kind === 'task.created')?.restore, null);
    const edit = entries.find((e) => e.kind === 'task.updated')!;
    assert.deepEqual(edit.restore, { title: 'Before' });

    const restored = await api(base, 'POST', `/api/tasks/${task.id}/restore`, { eventId: edit.id });
    assert.equal(restored.status, 200);
    assert.equal(restored.json.task.title, 'Before');
    const refused = await api(base, 'POST', `/api/tasks/${task.id}/restore`, { eventId: entries[0].id });
    assert.equal(refused.status, 400);
  });
});

test('POST /api/tasks/:id/move moves a task between projects and sections', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const projectA = app.store.upsertProject({ slug: 'a', name: 'Project A' });
  const projectB = app.store.upsertProject({ slug: 'b', name: 'Project B' });
  const task = app.store.createTask({ title: 'movable', projectId: projectA.id }, 'human');
  await withServer(app, {}, async (base) => {
    const { status, json } = await api(base, 'POST', `/api/tasks/${task.id}/move`, { project: 'b', section: 'Doing' });
    assert.equal(status, 200);
    assert.equal(json.task.projectId, projectB.id);
    const section = app.store.listSections(projectB.id).find((s) => s.name === 'Doing');
    assert.equal(json.task.sectionId, section!.id);
  });
});

test('comments and dependencies endpoints', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const a = app.store.createTask({ title: 'a' }, 'human');
  const b = app.store.createTask({ title: 'b' }, 'human');
  await withServer(app, {}, async (base) => {
    const commented = await api(base, 'POST', `/api/tasks/${a.id}/comments`, { body: 'hello' });
    assert.equal(commented.status, 201);
    assert.equal(commented.json.comment.body, 'hello');

    const added = await api(base, 'POST', `/api/tasks/${b.id}/dependencies`, { blockerId: a.id });
    assert.equal(added.status, 201);
    assert.equal(app.store.blockersOf(b.id).length, 1);

    const removeRes = await fetch(`${base}/api/tasks/${b.id}/dependencies/${a.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.equal(removeRes.status, 204);
    assert.equal(app.store.blockersOf(b.id).length, 0);
  });
});

test('inbox: list, accept, reject', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const project = app.store.upsertProject({ slug: 'nimbus', name: 'Project Nimbus' });
  const accepted = app.store.createTask({ title: 'to accept', status: 'inbox' }, 'system');
  const rejected = app.store.createTask({ title: 'to reject', status: 'inbox' }, 'system');
  await withServer(app, {}, async (base) => {
    const list = await api(base, 'GET', '/api/inbox');
    assert.equal(list.json.tasks.length, 2);

    const acceptRes = await api(base, 'POST', `/api/inbox/${accepted.id}/accept`, { project: 'nimbus', priority: 'high' });
    assert.equal(acceptRes.status, 200);
    assert.equal(acceptRes.json.task.status, 'open');
    assert.equal(acceptRes.json.task.projectId, project.id);

    const rejectRes = await api(base, 'POST', `/api/inbox/${rejected.id}/reject`, { reason: 'not needed' });
    assert.equal(rejectRes.status, 200);
    assert.equal(rejectRes.json.task.status, 'dropped');
  });
});

test('views: list and run a builtin view, 404 for an unknown view', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  app.store.createTask({ title: 'due today', dueAt: '2026-09-12' }, 'human');
  await withServer(app, {}, async (base) => {
    const list = await api(base, 'GET', '/api/views');
    assert.ok(list.json.views.some((v: { name: string; builtin: boolean }) => v.name === 'today' && v.builtin));

    const view = await api(base, 'GET', '/api/views/today');
    assert.equal(view.status, 200);
    assert.equal(view.json.view.name, 'today');
    assert.ok(view.json.tasks.some((t: { title: string }) => t.title === 'due today'));

    const missing = await api(base, 'GET', '/api/views/not-a-real-view');
    assert.equal(missing.status, 404);
  });
});

test('views: ready and blocked are listed, and blocked carries each task\'s blockers', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const free = app.store.createTask({ title: 'free' }, 'human');
  const blocker = app.store.createTask({ title: 'blocker' }, 'human');
  const held = app.store.createTask({ title: 'held' }, 'human');
  app.store.addDependency(blocker.id, held.id);
  await withServer(app, {}, async (base) => {
    const list = await api(base, 'GET', '/api/views');
    const names = list.json.views.filter((v: { builtin: boolean }) => v.builtin).map((v: { name: string }) => v.name);
    assert.ok(names.includes('ready') && names.includes('blocked'));

    const ready = await api(base, 'GET', '/api/views/ready');
    assert.equal(ready.status, 200);
    const readyIds = ready.json.tasks.map((x: { id: string }) => x.id);
    assert.ok(readyIds.includes(free.id) && readyIds.includes(blocker.id) && !readyIds.includes(held.id));
    assert.equal(ready.json.blockers, undefined);

    const blocked = await api(base, 'GET', '/api/views/blocked');
    assert.equal(blocked.status, 200);
    assert.deepEqual(blocked.json.tasks.map((x: { id: string }) => x.id), [held.id]);
    assert.deepEqual(blocked.json.blockers[held.id].map((b: { id: string }) => b.id), [blocker.id]);
  });
});

test('rules: create (disabled by default), enable via PATCH, run dry, then delete', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const definition = {
    trigger: { type: 'schedule', condition: 'overdue' },
    conditions: [],
    actions: [{ type: 'notify', message: 'overdue: {title}' }],
  };
  await withServer(app, {}, async (base) => {
    const created = await api(base, 'POST', '/api/rules', { name: 'notify overdue', definition });
    assert.equal(created.status, 201);
    assert.equal(created.json.rule.enabled, false);
    const ruleId = created.json.rule.id;

    const list = await api(base, 'GET', '/api/rules');
    assert.ok(list.json.rules.some((r: { id: string }) => r.id === ruleId));

    const enabled = await api(base, 'PATCH', `/api/rules/${ruleId}`, { enabled: true });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.json.rule.enabled, true);

    app.store.createTask({ title: 'late task', dueAt: '2020-01-01' }, 'human');
    const ran = await api(base, 'POST', '/api/rules/run', { ruleId, dryRun: true });
    assert.equal(ran.status, 200);
    assert.equal(ran.json.dryRun, true);
    assert.ok(ran.json.fired.length >= 1);

    const invalid = await api(base, 'POST', '/api/rules', { name: 'bad', definition: { trigger: { type: 'nope' } } });
    assert.equal(invalid.status, 400);

    const deleted = await fetch(`${base}/api/rules/${ruleId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.equal(deleted.status, 204);
    assert.equal(app.store.getRule(ruleId), undefined);
  });
});

test('a human can enable a rule at creation, unlike the MCP tool', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const definition = { trigger: { type: 'schedule', condition: 'overdue' }, conditions: [], actions: [{ type: 'notify', message: 'hi' }] };
  await withServer(app, {}, async (base) => {
    const created = await api(base, 'POST', '/api/rules', { name: 'r', definition, enabled: true });
    assert.equal(created.json.rule.enabled, true);
  });
});

test('GET /api/digest builds a digest for today', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  app.store.createTask({ title: 'due today', dueAt: '2026-09-12' }, 'human');
  await withServer(app, {}, async (base) => {
    const { status, json } = await api(base, 'GET', '/api/digest');
    assert.equal(status, 200);
    assert.equal(json.date, '2026-09-12');
    assert.match(json.markdown, /Command Center Digest/);
  });
});

test('GET /api/events polls forward with a stable lastId when there is nothing new', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const task = app.store.createTask({ title: 'x' }, 'human');
  await withServer(app, {}, async (base) => {
    const first = await api(base, 'GET', '/api/events?after=0');
    assert.ok(first.json.events.length >= 1);
    const lastId = first.json.lastId;
    assert.equal(lastId, app.store.lastEventId());

    const second = await api(base, 'GET', `/api/events?after=${lastId}`);
    assert.equal(second.json.events.length, 0);
    assert.equal(second.json.lastId, lastId);

    app.store.addComment(task.id, 'more', 'human');
    const third = await api(base, 'GET', `/api/events?after=${lastId}`);
    assert.ok(third.json.events.length >= 1);
    assert.ok(third.json.lastId > lastId);
  });
});

test('GET /api/events reports headId, the newest event, even when the page is capped', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const task = app.store.createTask({ title: 'x' }, 'human');
  app.store.addComment(task.id, 'one', 'human');
  app.store.addComment(task.id, 'two', 'human');
  await withServer(app, {}, async (base) => {
    const capped = await api(base, 'GET', '/api/events?limit=1');
    assert.equal(capped.json.events.length, 1);
    assert.ok(capped.json.lastId < app.store.lastEventId());
    assert.equal(capped.json.headId, app.store.lastEventId());

    const empty = await api(base, 'GET', `/api/events?after=${capped.json.headId}&limit=1`);
    assert.equal(empty.json.events.length, 0);
    assert.equal(empty.json.headId, capped.json.headId);
  });
});

test('sync: no jobs configured reports an empty status and 404s any job name', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const status = await api(base, 'GET', '/api/sync');
    assert.deepEqual(status.json.jobs, {});

    const trigger = await api(base, 'POST', '/api/sync/github');
    assert.equal(trigger.status, 404);
  });
});

test('sync: the status carries warnings for a failing job and a backup that has gone quiet, and none when all is well', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const fresh = new Date().toISOString();
  const healthy = { import: { lastRunAt: fresh, lastError: null, running: false }, backup: { lastRunAt: fresh, lastError: null, running: false } };
  await withServer(app, { getJobStatus: () => healthy }, async (base) => {
    const status = await api(base, 'GET', '/api/sync');
    assert.deepEqual(status.json.warnings, []);
  });
  const troubled = {
    github: { lastRunAt: fresh, lastError: 'rate limited\nsecond line', running: false },
    backup: { lastRunAt: '2026-01-01T03:15:00Z', lastError: null, running: false },
  };
  await withServer(app, { getJobStatus: () => troubled }, async (base) => {
    const status = await api(base, 'GET', '/api/sync');
    assert.deepEqual(Object.keys(status.json.jobs), ['github', 'backup']);
    assert.deepEqual(status.json.warnings.map((w: { job: string }) => w.job), ['github', 'backup']);
    assert.equal(status.json.warnings[0].message, 'The github job is failing: rate limited');
    assert.match(status.json.warnings[1].message, /backup is \d+ day\(s\) old/);
  });
});

test('sync: with no jobs configured the warnings are an empty list, not missing', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    assert.deepEqual((await api(base, 'GET', '/api/sync')).json.warnings, []);
  });
});

test('sync: triggers a configured job in the background and 202s immediately, 409s if already running', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  let running = false;
  let resolveJob: () => void = () => {};
  const jobPromise = new Promise<void>((r) => { resolveJob = r; });
  const jobs = {
    github: async () => {
      running = true;
      await jobPromise;
      running = false;
    },
  };
  await withServer(app, { jobs, getJobStatus: () => ({ github: { lastRunAt: null, lastError: null, running } }) }, async (base) => {
    const first = await api(base, 'POST', '/api/sync/github');
    assert.equal(first.status, 202);
    assert.equal(first.json.started, true);

    // give the fire-and-forget job a tick to actually start
    await new Promise((r) => setTimeout(r, 10));
    const second = await api(base, 'POST', '/api/sync/github');
    assert.equal(second.status, 409);

    resolveJob();
    await new Promise((r) => setTimeout(r, 10));
  });
});

// ---- bounds and atomicity on the write paths ----

test('GET /api/events refuses a negative or zero limit rather than serialising the whole table', async (t) => {
  // SQLite reads LIMIT -1 as "no limit", and events only ever grow.
  const app = fakeApp();
  t.after(() => app.close());
  for (let i = 0; i < 12; i++) app.store.createTask({ title: `task ${i}` }, 'human');
  await withServer(app, {}, async (base) => {
    for (const bad of ['-1', '0']) {
      const { status, json } = await api(base, 'GET', `/api/events?limit=${bad}`);
      assert.equal(status, 400, `limit=${bad} should be refused`);
      assert.equal(json.error.code, 'ValidationError');
    }
    assert.equal((await api(base, 'GET', '/api/events?after=-1')).status, 400);

    // An absurdly large limit is accepted but clamped by the store, not honoured.
    const { status, json } = await api(base, 'GET', '/api/events?limit=100000');
    assert.equal(status, 200);
    assert.ok(json.events.length <= 1000, `got ${json.events.length} events`);
  });
});

test('POST /api/sync/:job does not treat inherited Object properties as registered jobs', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, { jobs: {} }, async (base) => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const { status, json } = await api(base, 'POST', `/api/sync/${name}`);
      assert.equal(status, 404, `${name} should be a plain 404, not a 500`);
      assert.equal(json.error.message, `job not found: ${name}`);
    }
  });
});

test('a malformed percent escape in a path parameter is a 400, not a server error', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const { status, json } = await api(base, 'GET', '/api/tasks/%E0%A4%A');
    assert.equal(status, 400);
    assert.equal(json.error.code, 'ValidationError');
  });
});

test('POST /api/tasks with an unknown blocker creates nothing at all', async (t) => {
  // The task used to be committed before blockedBy was resolved, so a caller told the
  // create had failed still had a task, and a retry produced a second one.
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const { status } = await api(base, 'POST', '/api/tasks', { title: 'partial', blockedBy: ['does-not-exist'] });
    assert.equal(status, 404);
    assert.deepEqual(app.store.searchTasks({ status: ['open'] }).map((t2) => t2.title), []);
  });
});

test('POST /api/tasks with a good blocker still creates the task and the dependency', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const blocker = app.store.createTask({ title: 'blocker' }, 'human');
  await withServer(app, {}, async (base) => {
    const { status, json } = await api(base, 'POST', '/api/tasks', { title: 'blocked', blockedBy: [blocker.id] });
    assert.equal(status, 201);
    assert.deepEqual(app.store.blockersOf(json.task.id).map((b) => b.id), [blocker.id]);
  });
});

test('POST /api/outbox replays offline edits once, and refuses an op kind that is not on the list', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const task = app.store.createTask({ title: 'Edited on the train' }, 'human');
  await withServer(app, {}, async (base) => {
    const batch = {
      deviceId: 'device-rest-test',
      ops: [
        { opId: 'rest_op_00000001', kind: 'create_task', taskId: 't_resttest01', at: '2026-09-12T11:00:00.000Z', base: null, body: { title: 'Made offline' } },
        { opId: 'rest_op_00000002', kind: 'update_task', taskId: task.id, at: '2026-09-12T11:00:00.000Z', base: task.updatedAt, body: { priority: 'high' } },
        { opId: 'rest_op_00000003', kind: 'move_task', taskId: task.id, at: '2026-09-12T11:00:00.000Z', base: task.updatedAt, body: { section: 'no such section' } },
      ],
    };
    const first = await api(base, 'POST', '/api/outbox', batch);
    assert.equal(first.status, 200);
    assert.deepEqual(first.json.results.map((r: { status: string }) => r.status), ['applied', 'applied', 'rejected']);
    assert.equal(typeof first.json.headId, 'number');
    assert.equal(app.store.requireTask(task.id).priority, 'high');
    assert.equal(app.store.requireTask('t_resttest01').title, 'Made offline');

    const again = await api(base, 'POST', '/api/outbox', batch);
    assert.deepEqual(again.json.results.map((r: { status: string }) => r.status), ['duplicate', 'duplicate', 'duplicate']);
    assert.equal(app.store.searchTasks({ text: 'Made offline' }).length, 1);

    const forbidden = await api(base, 'POST', '/api/outbox', {
      deviceId: 'device-rest-test',
      ops: [{ opId: 'rest_op_00000004', kind: 'accept_inbox_item', taskId: task.id, at: '2026-09-12T11:00:00.000Z', base: null, body: {} }],
    });
    assert.equal(forbidden.status, 400);
  });
});

test('a create or comment whose answer was lost is not applied again by the replay', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const task = app.store.createTask({ title: 'Commented on' }, 'human');
  await withServer(app, {}, async (base) => {
    const ident = { deviceId: 'device-rest-test' };
    // The server commits both. The dashboard never sees the answers, so it queues the same ops.
    const created = await api(base, 'POST', '/api/tasks', { title: 'Submitted once', id: 't_lostanswer', opId: 'lost_op_00000001', ...ident });
    assert.equal(created.status, 201);
    assert.equal(created.json.task.id, 't_lostanswer');
    const commented = await api(base, 'POST', `/api/tasks/${task.id}/comments`, { body: 'Said once', opId: 'lost_op_00000002', ...ident });
    assert.equal(commented.status, 201);

    const replay = await api(base, 'POST', '/api/outbox', {
      ...ident,
      ops: [
        { opId: 'lost_op_00000001', kind: 'create_task', taskId: 't_lostanswer', at: '2026-09-21T11:00:00.000Z', base: null, body: { title: 'Submitted once' } },
        { opId: 'lost_op_00000002', kind: 'add_comment', taskId: task.id, at: '2026-09-21T11:00:00.000Z', base: task.updatedAt, body: { body: 'Said once' } },
      ],
    });
    assert.deepEqual(replay.json.results.map((r: { status: string }) => r.status), ['duplicate', 'duplicate']);
    assert.equal(app.store.searchTasks({ text: 'Submitted once' }).length, 1);
    assert.equal(app.store.listComments(task.id).length, 1);

    // The same online request sent twice answers with what was saved the first time.
    const again = await api(base, 'POST', '/api/tasks', { title: 'Submitted once', id: 't_lostanswer', opId: 'lost_op_00000001', ...ident });
    assert.equal(again.json.task.id, 't_lostanswer');
    const commentAgain = await api(base, 'POST', `/api/tasks/${task.id}/comments`, { body: 'Said once', opId: 'lost_op_00000002', ...ident });
    assert.equal(commentAgain.json.comment.id, commented.json.comment.id);
    assert.equal(app.store.searchTasks({ text: 'Submitted once' }).length, 1);
    assert.equal(app.store.listComments(task.id).length, 1);

    // A create that fails leaves no op behind, so the corrected request can use the id again.
    const bad = await api(base, 'POST', '/api/tasks', { title: 'Bad blocker', opId: 'lost_op_00000003', blockedBy: ['t_nosuchtask'], ...ident });
    assert.notEqual(bad.status, 201);
    assert.equal(app.store.getAppliedOp('lost_op_00000003'), null);

    const taken = await api(base, 'POST', '/api/tasks', { title: 'Same id, no op', id: 't_lostanswer' });
    assert.equal(taken.status, 400);
  });
});

test('assignee travels through POST, PATCH, and GET /api/tasks like the other editable fields', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  app.store.createTask({ title: 'left alone' }, 'human');
  await withServer(app, {}, async (base) => {
    const created = await api(base, 'POST', '/api/tasks', { title: 'Draft the digest', assignee: 'scribe' });
    assert.equal(created.status, 201);
    assert.equal(created.json.task.assignee, 'scribe');

    const byName = await api(base, 'GET', '/api/tasks?assignee=scribe');
    assert.deepEqual(byName.json.tasks.map((x: { id: string }) => x.id), [created.json.task.id]);
    const unassigned = await api(base, 'GET', '/api/tasks?unassigned=true');
    assert.deepEqual(unassigned.json.tasks.map((x: { title: string }) => x.title), ['left alone']);
    const assigned = await api(base, 'GET', '/api/tasks?unassigned=false');
    assert.deepEqual(assigned.json.tasks.map((x: { title: string }) => x.title), ['Draft the digest']);
    const bad = await api(base, 'GET', '/api/tasks?unassigned=maybe');
    assert.equal(bad.status, 400);

    const renamed = await api(base, 'PATCH', `/api/tasks/${created.json.task.id}`, { assignee: 'reviewer' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.json.task.assignee, 'reviewer');
    const cleared = await api(base, 'PATCH', `/api/tasks/${created.json.task.id}`, { assignee: null });
    assert.equal(cleared.json.task.assignee, null);
    const fetched = await api(base, 'GET', `/api/tasks/${created.json.task.id}`);
    assert.equal(fetched.json.task.assignee, null);
    const tooLong = await api(base, 'PATCH', `/api/tasks/${created.json.task.id}`, { assignee: 'x'.repeat(201) });
    assert.equal(tooLong.status, 400);
  });
});

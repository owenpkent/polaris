import { test } from 'node:test';
import { TOOL_CATALOG } from './catalog.ts';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { App } from '../app.ts';
import { openStore } from '../core/index.ts';
import { createMcpServer } from './server.ts';

// A CallToolResult content block, narrowed to the text variant we always return.
interface TextResult { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, unknown> }

function fakeApp(): App {
  let tick = 0;
  const store = openStore(':memory:', {
    now: () => new Date(Date.UTC(2026, 8, 12, 12, 0, tick++)).toISOString(),
    nextOccurrence: (_r, prev) => {
      const d = new Date(`${prev.slice(0, 10)}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 7);
      return d.toISOString().slice(0, 10);
    },
  });
  return {
    config: { repoRoot: '', dbPath: ':memory:', timezone: 'UTC', dashboardDir: '' },
    store,
    today: () => '2026-09-12',
    close: () => store.db.close(),
  };
}

async function connected(app: App, opts: { readonly?: boolean } = {}): Promise<{ client: Client; app: App }> {
  const server = createMcpServer(app, opts);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, app };
}

test('tools list: readonly hides write tools', async (t) => {
  const full = await connected(fakeApp());
  const ro = await connected(fakeApp(), { readonly: true });
  const fullNames = (await full.client.listTools()).tools.map((x) => x.name).sort();
  const roNames = (await ro.client.listTools()).tools.map((x) => x.name).sort();
  // The served tools are exactly the catalog, and the read-only server is exactly its read-only half.
  assert.deepEqual(fullNames, TOOL_CATALOG.map((e) => e.name).sort());
  assert.deepEqual(roNames, TOOL_CATALOG.filter((e) => e.readonly).map((e) => e.name).sort());
  assert.ok(fullNames.includes('create_task'));
  assert.ok(!roNames.includes('create_task'));
  assert.ok(!roNames.includes('update_task'));
  assert.ok(roNames.includes('search_tasks'));
  t.after(() => { full.app.close(); ro.app.close(); });
});

test('create -> search -> update -> complete flow', async (t) => {
  const { client, app } = await connected(fakeApp());
  t.after(() => app.close());
  app.store.upsertProject({ slug: 'nimbus', name: 'Project Nimbus' });

  const created = await client.callTool({ name: 'create_task', arguments: { title: 'Ship installer', project: 'Project Nimbus', priority: 'high' } }) as unknown as TextResult;
  assert.equal(created.isError, undefined);
  const taskId = (created.structuredContent!.task as { id: string }).id;
  assert.ok(taskId);

  const found = await client.callTool({ name: 'search_tasks', arguments: { text: 'installer' } }) as unknown as TextResult;
  const foundTasks = found.structuredContent!.tasks as { id: string }[];
  assert.equal(foundTasks.length, 1);
  assert.equal(foundTasks[0].id, taskId);

  const updated = await client.callTool({ name: 'update_task', arguments: { task_id: taskId, status: 'in_progress', add_comment: 'started' } }) as unknown as TextResult;
  assert.equal((updated.structuredContent!.task as { status: string }).status, 'in_progress');

  const completed = await client.callTool({ name: 'complete_task', arguments: { task_id: taskId } }) as unknown as TextResult;
  assert.equal((completed.structuredContent!.task as { status: string }).status, 'done');

  const detail = await client.callTool({ name: 'get_task', arguments: { task_id: taskId } }) as unknown as TextResult;
  assert.equal((detail.structuredContent!.comments as unknown[]).length, 1);
});

test('project lookup by name resolves for create_task and list_sections', async (t) => {
  const { client, app } = await connected(fakeApp());
  t.after(() => app.close());
  app.store.upsertProject({ slug: 'octavium', name: 'Octavium' });

  const created = await client.callTool({ name: 'create_task', arguments: { title: 'Do a thing', project: 'Octavium', section: 'Backlog' } }) as unknown as TextResult;
  assert.equal(created.isError, undefined);

  const sections = await client.callTool({ name: 'list_sections', arguments: { project: 'octavium' } }) as unknown as TextResult;
  const names = (sections.structuredContent!.sections as { name: string }[]).map((s) => s.name);
  assert.deepEqual(names, ['Backlog']);
});

test('move_task changes project and section, creating a named section', async (t) => {
  const { client, app } = await connected(fakeApp());
  t.after(() => app.close());
  const a = app.store.upsertProject({ slug: 'proj-a', name: 'Proj A' });
  app.store.upsertProject({ slug: 'proj-b', name: 'Proj B' });
  const task = app.store.createTask({ title: 'Movable', projectId: a.id });

  const moved = await client.callTool({ name: 'move_task', arguments: { task_id: task.id, project: 'proj-b', section: 'Later' } }) as unknown as TextResult;
  const t2 = moved.structuredContent!.task as { projectId: string; sectionId: string };
  const b = app.store.findProject('proj-b')!;
  assert.equal(t2.projectId, b.id);
  const section = app.store.listSections(b.id).find((s) => s.id === t2.sectionId);
  assert.equal(section?.name, 'Later');
});

test('inbox accept and reject, item created via upsertFromSource', async (t) => {
  const { client, app } = await connected(fakeApp());
  t.after(() => app.close());

  const r1 = app.store.upsertFromSource({ sourceType: 'gmail', sourceId: 'thread-1', title: 'Send the cut', dueAt: '2026-09-20', contentHash: 'h1' });
  assert.equal(r1.action, 'created');
  assert.equal(r1.task.status, 'inbox');

  const inbox = await client.callTool({ name: 'list_inbox', arguments: {} }) as unknown as TextResult;
  const inboxTasks = inbox.structuredContent!.tasks as { id: string; sourceType: string }[];
  assert.equal(inboxTasks.length, 1);
  assert.equal(inboxTasks[0].sourceType, 'gmail');

  const accepted = await client.callTool({ name: 'accept_inbox_item', arguments: { task_id: r1.task.id, priority: 'high' } }) as unknown as TextResult;
  const acceptedTask = accepted.structuredContent!.task as { status: string; priority: string };
  assert.equal(acceptedTask.status, 'open');
  assert.equal(acceptedTask.priority, 'high');

  const r2 = app.store.upsertFromSource({ sourceType: 'gmail', sourceId: 'thread-2', title: 'Unwanted', contentHash: 'h2' });
  const rejected = await client.callTool({ name: 'reject_inbox_item', arguments: { task_id: r2.task.id, reason: 'not needed' } }) as unknown as TextResult;
  assert.equal((rejected.structuredContent!.task as { status: string }).status, 'dropped');
});

test('error mapping: bad task id and bad date are isError, not a thrown exception', async (t) => {
  const { client, app } = await connected(fakeApp());
  t.after(() => app.close());

  const badId = await client.callTool({ name: 'get_task', arguments: { task_id: 'does-not-exist' } }) as unknown as TextResult;
  assert.equal(badId.isError, true);
  assert.match(badId.content[0].text, /not found/i);

  const badDate = await client.callTool({ name: 'create_task', arguments: { title: 'x', due_at: 'friday' } }) as unknown as TextResult;
  assert.equal(badDate.isError, true);
  assert.match(badDate.content[0].text, /invalid/i);
});

test('create_rule always saves disabled', async (t) => {
  const { client, app } = await connected(fakeApp());
  t.after(() => app.close());
  const definition = {
    trigger: { type: 'schedule', condition: 'overdue' },
    conditions: [{ field: 'priority', op: 'eq', value: 'high' }],
    actions: [{ type: 'notify', message: 'Overdue: {title}' }],
  };
  const res = await client.callTool({ name: 'create_rule', arguments: { name: 'flag overdue', definition } }) as unknown as TextResult;
  assert.equal(res.isError, undefined);
  const rule = res.structuredContent!.rule as { enabled: boolean; id: string };
  assert.equal(rule.enabled, false);
  assert.match(res.content[0].text, /rules enable/);
});

test('create_rule rejects an invalid definition', async (t) => {
  const { client, app } = await connected(fakeApp());
  t.after(() => app.close());
  const res = await client.callTool({ name: 'create_rule', arguments: { name: 'bad', definition: { trigger: 'schedule' } } }) as unknown as TextResult;
  assert.equal(res.isError, true);
  assert.equal(app.store.listRules().length, 0);
});

test('get_view returns the built-in today view', async (t) => {
  const { client, app } = await connected(fakeApp());
  t.after(() => app.close());
  const res = await client.callTool({ name: 'get_view', arguments: { name: 'today' } }) as unknown as TextResult;
  assert.equal(res.isError, undefined);
});

test('get_view ready and blocked: ready omits the held task, blocked lists it with its blockers', async (t) => {
  const { client, app } = await connected(fakeApp());
  t.after(() => app.close());
  const free = app.store.createTask({ title: 'Free to start' });
  const blocker = app.store.createTask({ title: 'Must finish first' });
  const held = app.store.createTask({ title: 'Held back' });
  app.store.addDependency(blocker.id, held.id);

  const ready = await client.callTool({ name: 'get_view', arguments: { name: 'ready' } }) as unknown as TextResult;
  assert.equal(ready.isError, undefined);
  const readyIds = (ready.structuredContent!.tasks as { id: string }[]).map((x) => x.id);
  assert.ok(readyIds.includes(free.id));
  assert.ok(readyIds.includes(blocker.id), 'the open blocker itself is ready');
  assert.ok(!readyIds.includes(held.id));
  assert.equal(ready.structuredContent!.blockers, undefined);

  const blocked = await client.callTool({ name: 'get_view', arguments: { name: 'blocked' } }) as unknown as TextResult;
  assert.equal(blocked.isError, undefined);
  assert.deepEqual((blocked.structuredContent!.tasks as { id: string }[]).map((x) => x.id), [held.id]);
  const blockers = blocked.structuredContent!.blockers as Record<string, { id: string; title: string }[]>;
  assert.deepEqual(blockers[held.id].map((b) => b.title), ['Must finish first']);
  assert.match(blocked.content[0].text, /"Held back" \{[^}]+\}\n    blocked by:\n    - \[open\/none\] "Must finish first"/);
});

test('create_task resolves a project from github_repo when project is not given', async (t) => {
  const { client, app } = await connected(fakeApp());
  t.after(() => app.close());
  app.store.upsertProject({ slug: 'nimbus', name: 'Project Nimbus', github: 'https://github.com/example-org/Nimbus' });

  const created = await client.callTool({
    name: 'create_task',
    arguments: { title: 'Fix the thing', github_repo: 'git@github.com:example-org/nimbus.git' },
  }) as unknown as TextResult;
  assert.equal(created.isError, undefined);
  const task = created.structuredContent!.task as { projectId: string };
  const project = app.store.findProject('nimbus')!;
  assert.equal(task.projectId, project.id);
});

test('create_task with a github_repo no project is tracked for returns a tool error, not a thrown exception', async (t) => {
  const { client, app } = await connected(fakeApp());
  t.after(() => app.close());
  app.store.upsertProject({ slug: 'nimbus', name: 'Project Nimbus', github: 'https://github.com/example-org/Nimbus' });

  const res = await client.callTool({
    name: 'create_task',
    arguments: { title: 'Fix the thing', github_repo: 'example-org/unrelated' },
  }) as unknown as TextResult;
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /No project is tracked for github_repo "example-org\/unrelated"/);
  assert.equal(app.store.countTasks(), 0);
});

test('create_task prefers an explicit project over github_repo', async (t) => {
  const { client, app } = await connected(fakeApp());
  t.after(() => app.close());
  app.store.upsertProject({ slug: 'nimbus', name: 'Project Nimbus', github: 'https://github.com/example-org/Nimbus' });
  const other = app.store.upsertProject({ slug: 'octavium', name: 'Octavium' });

  const created = await client.callTool({
    name: 'create_task',
    arguments: { title: 'x', project: 'octavium', github_repo: 'example-org/Nimbus' },
  }) as unknown as TextResult;
  const task = created.structuredContent!.task as { projectId: string };
  assert.equal(task.projectId, other.id);
});

test('run_rule refuses a non-dry run on a disabled rule but allows a dry run', async (t) => {
  const { client, app } = await connected(fakeApp());
  t.after(() => app.close());
  const rule = app.store.saveRule({ name: 'test rule', enabled: false, definition: {} });
  const res = await client.callTool({ name: 'run_rule', arguments: { rule_id: rule.id, dry_run: false } }) as unknown as TextResult;
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /disabled/i);

  const dry = await client.callTool({ name: 'run_rule', arguments: { rule_id: rule.id } }) as unknown as TextResult;
  assert.equal(dry.isError, undefined);
});

// ---- a failed write tool leaves nothing behind ----
// An agent that sees isError will normally retry, so a partial write is worse over MCP
// than over REST: every attempt would leave another orphan or re-apply a live patch.

test('create_task with an unknown blocker creates no task, so a retry cannot pile up orphans', async (t) => {
  const { client, app } = await connected(fakeApp());
  t.after(() => app.close());

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await client.callTool({
      name: 'create_task', arguments: { title: 'mcp partial', blocked_by: ['nope'] },
    }) as unknown as TextResult;
    assert.equal(res.isError, true, 'the tool should report the unknown blocker');
  }
  assert.deepEqual(app.store.searchTasks({ status: ['open'] }).map((t2) => t2.title), []);
});

test('update_task rolls the whole patch back when one of its extras fails', async (t) => {
  const { client, app } = await connected(fakeApp());
  t.after(() => app.close());
  const task = app.store.createTask({ title: 'orig' }, 'human');

  const res = await client.callTool({
    name: 'update_task', arguments: { task_id: task.id, title: 'renamed', add_blocker: 'nope' },
  }) as unknown as TextResult;
  assert.equal(res.isError, true);
  // The agent was told the update failed, so the title must not be live.
  assert.equal(app.store.requireTask(task.id).title, 'orig');
  assert.equal(app.store.listComments(task.id).length, 0);
});

test('update_task still applies the patch and the extras together when they all succeed', async (t) => {
  const { client, app } = await connected(fakeApp());
  t.after(() => app.close());
  const task = app.store.createTask({ title: 'orig' }, 'human');
  const blocker = app.store.createTask({ title: 'blocker' }, 'human');

  const res = await client.callTool({
    name: 'update_task',
    arguments: { task_id: task.id, title: 'renamed', add_comment: 'note', add_blocker: blocker.id },
  }) as unknown as TextResult;
  assert.equal(res.isError, undefined);
  assert.equal(app.store.requireTask(task.id).title, 'renamed');
  assert.deepEqual(app.store.listComments(task.id).map((c) => c.body), ['note']);
  assert.deepEqual(app.store.blockersOf(task.id).map((b) => b.id), [blocker.id]);
});

test('assignee: create_task and update_task set and clear it, search_tasks filters by name or unassigned, get_task shows it', async (t) => {
  const { client, app } = await connected(fakeApp());
  t.after(() => app.close());

  const mine = await client.callTool({ name: 'create_task', arguments: { title: 'Nobody yet' } }) as unknown as TextResult;
  assert.equal((mine.structuredContent!.task as { assignee: string | null }).assignee, null);
  const created = await client.callTool({ name: 'create_task', arguments: { title: 'Draft the digest', assignee: 'scribe' } }) as unknown as TextResult;
  assert.equal(created.isError, undefined);
  const task = created.structuredContent!.task as { id: string; assignee: string | null };
  assert.equal(task.assignee, 'scribe');

  const byName = await client.callTool({ name: 'search_tasks', arguments: { assignee: 'scribe' } }) as unknown as TextResult;
  assert.deepEqual((byName.structuredContent!.tasks as { id: string }[]).map((x) => x.id), [task.id]);
  assert.match(byName.content[0].text, /assignee:"scribe"/);
  const other = await client.callTool({ name: 'search_tasks', arguments: { assignee: 'Scribe' } }) as unknown as TextResult;
  assert.equal((other.structuredContent!.tasks as unknown[]).length, 0, 'exact match');
  const unclaimed = await client.callTool({ name: 'search_tasks', arguments: { unassigned: true } }) as unknown as TextResult;
  assert.deepEqual((unclaimed.structuredContent!.tasks as { title: string }[]).map((x) => x.title), ['Nobody yet']);
  const claimed = await client.callTool({ name: 'search_tasks', arguments: { unassigned: false } }) as unknown as TextResult;
  assert.deepEqual((claimed.structuredContent!.tasks as { title: string }[]).map((x) => x.title), ['Draft the digest']);

  const detail = await client.callTool({ name: 'get_task', arguments: { task_id: task.id } }) as unknown as TextResult;
  assert.equal((detail.structuredContent!.task as { assignee: string | null }).assignee, 'scribe');
  assert.match(detail.content[0].text, /assignee:"scribe"/);

  const reassigned = await client.callTool({ name: 'update_task', arguments: { task_id: task.id, assignee: 'reviewer' } }) as unknown as TextResult;
  assert.equal((reassigned.structuredContent!.task as { assignee: string | null }).assignee, 'reviewer');
  const cleared = await client.callTool({ name: 'update_task', arguments: { task_id: task.id, assignee: null } }) as unknown as TextResult;
  assert.equal((cleared.structuredContent!.task as { assignee: string | null }).assignee, null);
  const after = await client.callTool({ name: 'get_task', arguments: { task_id: task.id } }) as unknown as TextResult;
  assert.match(after.content[0].text, / unassigned/);
  const history = (after.structuredContent!.history as { kind: string; payload: { changes?: Record<string, unknown> } }[])
    .filter((e) => e.kind === 'task.updated').map((e) => e.payload.changes);
  assert.deepEqual(history, [{ assignee: ['scribe', 'reviewer'] }, { assignee: ['reviewer', null] }], 'history keeps each reassignment');
});

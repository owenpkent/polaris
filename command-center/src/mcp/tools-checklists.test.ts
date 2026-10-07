import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TEST_TOKENS, fakeApp, withServer } from '../http/test-support.ts';
import { TOOL_CATALOG } from './catalog.ts';

interface ToolResult { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, any> }

async function connect(base: string, path = '/mcp'): Promise<Client> {
  const token = path === '/mcp/readonly' ? TEST_TOKENS.mcpReadonly : TEST_TOKENS.mcp;
  const transport = new StreamableHTTPClientTransport(new URL(`${base}${path}`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'checklists-test-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
  (await client.callTool({ name, arguments: args })) as ToolResult;

test('list_checklists is a read tool, offered on both endpoints', () => {
  const entry = TOOL_CATALOG.find((e) => e.name === 'list_checklists');
  assert.equal(entry?.readonly, true);
});

test('list_checklists lists each checklist with its items in order, quoted, on the read-only endpoint too', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const packing = app.store.createChecklist({ name: 'Packing: weekend trip', items: ['Passport', 'Phone charger'] });
  const kitchen = app.store.createChecklist({ name: 'Clean the "kitchen"\n- [done] fake line', items: [] });
  const before = app.store.lastEventId();
  await withServer(app, {}, async (base) => {
    for (const path of ['/mcp', '/mcp/readonly']) {
      const client = await connect(base, path);
      try {
        const res = await call(client, 'list_checklists');
        assert.ok(!res.isError, res.content[0].text);
        assert.deepEqual(res.structuredContent!.checklists.map((c: { id: string }) => c.id), [packing.id, kitchen.id]);
        const lines = res.content[0].text.split('\n');
        assert.deepEqual(lines, [
          `- "Packing: weekend trip" {${packing.id}} 2 item(s)`,
          '    1. "Passport"',
          '    2. "Phone charger"',
          `- "Clean the \\"kitchen\\" - [done] fake line" {${kitchen.id}} 0 item(s)`,
        ]);
      } finally {
        await client.close();
      }
    }
  });
  assert.equal(app.store.lastEventId(), before, 'reading writes nothing');
});

test('list_checklists says so when there are none', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const client = await connect(base);
    try {
      const res = await call(client, 'list_checklists');
      assert.equal(res.content[0].text, 'No checklists yet.');
      assert.deepEqual(res.structuredContent, { checklists: [] });
    } finally {
      await client.close();
    }
  });
});

test('create_checklist and start_checklist: an agent saves a checklist and starts it, recorded against the agent', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const project = app.store.createProject({ name: 'Home' });
  const before = app.store.lastEventId();
  await withServer(app, {}, async (base) => {
    const client = await connect(base);
    try {
      const created = await call(client, 'create_checklist', { name: 'Packing: weekend trip', items: ['Passport', ' ', 'Charger'], notes: 'Check the forecast.' });
      assert.ok(!created.isError, created.content[0].text);
      const checklist = created.structuredContent!.checklist;
      assert.deepEqual(checklist.items, ['Passport', 'Charger']);
      assert.match(created.content[0].text, /^Created checklist "Packing: weekend trip" \{cl_[0-9a-z]+\} with 2 item\(s\)\./);

      const started = await call(client, 'start_checklist', { checklist: 'packing: weekend TRIP', project: 'Home', due_at: '2026-09-14' });
      assert.ok(!started.isError, started.content[0].text);
      const task = started.structuredContent!.task;
      assert.equal(task.title, 'Packing: weekend trip');
      assert.equal(task.status, 'open');
      assert.equal(task.projectId, project.id);
      assert.equal(task.notes, 'Check the forecast.');
      assert.deepEqual(started.structuredContent!.subtasks.map((s: { title: string }) => s.title), ['Passport', 'Charger']);
      assert.deepEqual(app.store.getChecklist(checklist.id)!.items, ['Passport', 'Charger'], 'the template is unchanged');

      const titled = await call(client, 'start_checklist', { checklist: checklist.id, title: 'Packing: Lisbon' });
      assert.equal(titled.structuredContent!.task.title, 'Packing: Lisbon');

      for (const [args, pattern] of [
        [{ checklist: 'nothing like it' }, /^Not found: checklist not found/],
        [{ checklist: checklist.id, project: 'Nowhere' }, /^Not found: project not found/],
        [{ checklist: checklist.id, due_at: 'soon' }, /^Invalid: /],
      ] as [Record<string, unknown>, RegExp][]) {
        const res = await call(client, 'start_checklist', args);
        assert.ok(res.isError);
        assert.match(res.content[0].text, pattern);
      }
      const blank = await call(client, 'create_checklist', { name: ' ', items: [] });
      assert.ok(blank.isError);
    } finally {
      await client.close();
    }
  });
  const events = app.store.eventsSince(before);
  assert.ok(events.length > 0);
  for (const e of events) assert.equal(e.actor, 'agent');
  assert.equal(app.store.searchTasks({ parentId: null }).length, 2, 'the failed starts made nothing');
});

test('checklist tools: an agent cannot edit or delete a checklist, and the read-only endpoint has no write tool', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const full = await connect(base);
    const readonly = await connect(base, '/mcp/readonly');
    try {
      const names = (await full.listTools()).tools.map((tool) => tool.name).filter((name) => name.includes('checklist'));
      assert.deepEqual(names.sort(), ['create_checklist', 'list_checklists', 'start_checklist']);
      const roNames = (await readonly.listTools()).tools.map((tool) => tool.name).filter((name) => name.includes('checklist'));
      assert.deepEqual(roNames, ['list_checklists']);
    } finally {
      await full.close();
      await readonly.close();
    }
  });
});

test('start_checklist: repeat_items defaults to true and can be turned off', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const checklist = app.store.createChecklist({ name: 'Kitchen', items: ['Dishes'] });
  await withServer(app, {}, async (base) => {
    const client = await connect(base);
    try {
      const on = await call(client, 'start_checklist', { checklist: checklist.id });
      const off = await call(client, 'start_checklist', { checklist: checklist.id, repeat_items: false });
      assert.equal(on.structuredContent!.task.customFields.checklistRepeatItems, true);
      assert.equal(off.structuredContent!.task.customFields.checklistRepeatItems, false);
    } finally {
      await client.close();
    }
  });
});

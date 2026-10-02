import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TEST_TOKENS, fakeApp, withServer } from '../http/test-support.ts';

interface ToolResult { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, any> }

async function connect(base: string, path = '/mcp'): Promise<Client> {
  const token = path === '/mcp/readonly' ? TEST_TOKENS.mcpReadonly : TEST_TOKENS.mcp;
  const transport = new StreamableHTTPClientTransport(new URL(`${base}${path}`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'projects-test-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
  (await client.callTool({ name, arguments: args })) as ToolResult;

test('project tools: an agent can create a project and put a task in it, recorded against the agent', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const start = app.store.lastEventId();

  await withServer(app, {}, async (base) => {
    const client = await connect(base);
    try {
      const created = await call(client, 'create_project', { name: 'Garden', description: 'Beds and seeds.', github: 'example-org/garden' });
      assert.ok(!created.isError, created.content[0].text);
      assert.equal(created.structuredContent!.project.slug, 'garden');
      assert.equal(created.structuredContent!.project.github, 'https://github.com/example-org/garden');

      const task = await call(client, 'create_task', { title: 'Order seeds', project: 'Garden' });
      assert.ok(!task.isError, task.content[0].text);
      assert.equal(app.store.searchTasks({ projectId: created.structuredContent!.project.id }).length, 1);

      const duplicate = await call(client, 'create_project', { name: 'garden' });
      assert.ok(duplicate.isError);
      assert.match(duplicate.content[0].text, /^Invalid: /);
    } finally {
      await client.close();
    }
  });

  const events = app.store.eventsSince(start).filter((e) => e.kind === 'project.upserted');
  assert.equal(events.length, 1);
  assert.equal(events[0].actor, 'agent');
});

test('project tools: there is no tool that renames, edits, or archives a project', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const client = await connect(base);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name).filter((name) => name.includes('project'));
      assert.deepEqual(names.sort(), ['create_project', 'list_projects']);
      // archived is a real field over REST, but the tool's input does not accept it.
      await call(client, 'create_project', { name: 'Hidden', archived: true }).catch(() => undefined);
      assert.deepEqual(app.store.listProjects({ includeArchived: true }).filter((p) => p.archived), []);
    } finally {
      await client.close();
    }
  });
});

test('project tools: the read-only endpoint does not offer them', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const client = await connect(base, '/mcp/readonly');
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      assert.ok(names.includes('list_projects'));
      assert.ok(!names.includes('create_project'));
    } finally {
      await client.close();
    }
  });
});

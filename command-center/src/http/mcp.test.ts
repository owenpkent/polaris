import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { App } from '../app.ts';
import { TEST_TOKENS, fakeApp, withServer } from './test-support.ts';

interface TextResult { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, unknown> }

async function connectClient(base: string, path = '/mcp'): Promise<Client> {
  // /mcp/readonly and /mcp are gated by different tokens (see ApiTokens in types.ts).
  const token = path === '/mcp/readonly' ? TEST_TOKENS.mcpReadonly : TEST_TOKENS.mcp;
  const transport = new StreamableHTTPClientTransport(new URL(`${base}${path}`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'http-test-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

test('MCP over HTTP: lists tools and calls create_task', async (t) => {
  const app: App = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    app.store.upsertProject({ slug: 'nimbus', name: 'Project Nimbus' });
    const client = await connectClient(base);
    try {
      const tools = await client.listTools();
      assert.ok(tools.tools.some((tool) => tool.name === 'create_task'));
      assert.ok(tools.tools.some((tool) => tool.name === 'search_tasks'));

      const created = await client.callTool({
        name: 'create_task',
        arguments: { title: 'Ship it', project: 'Project Nimbus' },
      }) as unknown as TextResult;
      assert.equal(created.isError, undefined);
      const task = created.structuredContent!.task as { id: string; title: string };
      assert.equal(task.title, 'Ship it');

      const stored = app.store.requireTask(task.id);
      assert.equal(stored.title, 'Ship it');
    } finally {
      await client.close();
    }
  });
});

test('MCP over HTTP: the readonly path hides write tools', async (t) => {
  const app: App = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const client = await connectClient(base, '/mcp/readonly');
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      assert.ok(names.includes('search_tasks'));
      assert.ok(!names.includes('create_task'));
      assert.ok(!names.includes('update_task'));
    } finally {
      await client.close();
    }
  });
});

test('MCP over HTTP: readonlyMcp option makes the default /mcp path readonly too', async (t) => {
  const app: App = fakeApp();
  t.after(() => app.close());
  await withServer(app, { readonlyMcp: true }, async (base) => {
    const client = await connectClient(base, '/mcp');
    try {
      const tools = await client.listTools();
      assert.ok(!tools.tools.some((tool) => tool.name === 'create_task'));
    } finally {
      await client.close();
    }
  });
});

test('MCP over HTTP: a request without a bearer token is rejected before reaching the MCP layer', async (t) => {
  const app: App = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
    const client = new Client({ name: 'unauthorized-client', version: '0.0.0' }, { capabilities: {} });
    await assert.rejects(client.connect(transport));
  });
});

async function connectNamedClient(base: string, agentName: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TEST_TOKENS.mcp}`, 'X-Agent-Name': agentName } },
  });
  const client = new Client({ name: 'http-named-test-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

test('MCP over HTTP: a valid X-Agent-Name header is recorded beside the actor', async (t) => {
  const app: App = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const client = await connectNamedClient(base, 'scribe');
    try {
      const created = await client.callTool({ name: 'create_task', arguments: { title: 'Named over HTTP' } }) as unknown as TextResult;
      assert.equal(created.isError, undefined);
      const taskId = (created.structuredContent!.task as { id: string }).id;
      const event = app.store.taskHistory(taskId).find((e) => e.kind === 'task.created');
      assert.equal(event?.actor, 'agent');
      assert.equal(event?.actorName, 'scribe');
    } finally {
      await client.close();
    }
  });
});

test('MCP over HTTP: an invalid X-Agent-Name header is ignored, recorded as null, not a 400', async (t) => {
  const app: App = fakeApp();
  t.after(() => app.close());
  await withServer(app, {}, async (base) => {
    const client = await connectNamedClient(base, '<script>');
    try {
      const created = await client.callTool({ name: 'create_task', arguments: { title: 'Invalid name over HTTP' } }) as unknown as TextResult;
      assert.equal(created.isError, undefined);
      const taskId = (created.structuredContent!.task as { id: string }).id;
      const event = app.store.taskHistory(taskId).find((e) => e.kind === 'task.created');
      assert.equal(event?.actor, 'agent');
      assert.equal(event?.actorName, null);
    } finally {
      await client.close();
    }
  });
});

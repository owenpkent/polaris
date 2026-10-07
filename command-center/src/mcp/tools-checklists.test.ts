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

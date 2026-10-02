import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { App } from '../app.ts';
import { openStore } from '../core/index.ts';
import { createMcpServer } from './server.ts';

function fakeApp(): App {
  const store = openStore(':memory:', { now: () => '2026-09-12T12:00:00.000Z' });
  return {
    config: { repoRoot: '', dbPath: ':memory:', timezone: 'UTC', dashboardDir: '' },
    store,
    today: () => '2026-09-12',
    close: () => store.db.close(),
  };
}

async function connected(app: App): Promise<Client> {
  const server = createMcpServer(app);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Resource contents are text or blob; every resource here is markdown text. */
function asText(content: { text: string } | { blob: string }): string {
  return 'text' in content ? content.text : '';
}

test('agenda/today resource lists due-today, overdue, and inbox count', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const p = app.store.upsertProject({ slug: 'nimbus', name: 'Nimbus' });
  app.store.createTask({ title: 'Due today', projectId: p.id, dueAt: '2026-09-12' });
  app.store.createTask({ title: 'Overdue thing', projectId: p.id, dueAt: '2026-09-01' });
  app.store.upsertFromSource({ sourceType: 'gmail', sourceId: 't1', title: 'Inbox item', contentHash: 'h' });

  const client = await connected(app);
  const res = await client.readResource({ uri: 'polaris://agenda/today' });
  const text = asText(res.contents[0]);
  assert.match(text, /Agenda for 2026-09-12/);
  assert.match(text, /Due today/);
  assert.match(text, /Overdue thing/);
  assert.match(text, /1 item\(s\) awaiting triage/);
});

test('projects/{slug} resource summarizes sections, open tasks, and recent completions', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const p = app.store.upsertProject({ slug: 'octavium', name: 'Octavium', description: 'A test project.' });
  const section = app.store.ensureSection(p.id, 'Backlog');
  app.store.createTask({ title: 'In backlog', projectId: p.id, sectionId: section.id });
  app.store.createTask({ title: 'No section task', projectId: p.id });
  const done = app.store.createTask({ title: 'Finished thing', projectId: p.id });
  app.store.completeTask(done.id);

  const client = await connected(app);
  const res = await client.readResource({ uri: 'polaris://projects/octavium' });
  const text = asText(res.contents[0]);
  assert.match(text, /Octavium/);
  assert.match(text, /Backlog/);
  assert.match(text, /In backlog/);
  assert.match(text, /No section task/);
  assert.match(text, /Finished thing/);
});

test('projects/{slug} resource errors on an unknown project', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const client = await connected(app);
  await assert.rejects(client.readResource({ uri: 'polaris://projects/does-not-exist' }));
});

test('digest/today resource returns a non-empty digest', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const client = await connected(app);
  const res = await client.readResource({ uri: 'polaris://digest/today' });
  assert.ok(asText(res.contents[0]).length > 0);
});

test('daily_review prompt walks the agenda and inbox with A/B/C choices', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const client = await connected(app);
  const res = await client.getPrompt({ name: 'daily_review' });
  assert.equal(res.messages.length, 1);
  const text = (res.messages[0].content as { text: string }).text;
  assert.match(text, /list_inbox/);
  assert.match(text, /A\)/);
  assert.match(text, /focus tasks/);
});

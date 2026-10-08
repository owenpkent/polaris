// MCP tools for reusable checklists. A checklist is a template: starting it makes an ordinary
// open task with one subtask per item. The list tool is in the read-only set, like every other
// read tool. The writes use actor 'agent', the same trust level the task tools have, and are only
// registered on the write endpoint. An agent cannot edit or delete a checklist: that stays with
// the owner in the dashboard and the CLI.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { App } from '../app.ts';
import { NotFoundError, type ActorInput, type Checklist, type Store } from '../core/index.ts';
import { TOOL_CATALOG } from './catalog.ts';
import { taskRef } from './format.ts';
import { guard, ok, resolveProject } from './shared.ts';

const desc = (name: string): string => TOOL_CATALOG.find((t) => t.name === name)?.description ?? name;

/** One checklist on one line, then its items. Names and items are JSON-quoted, like task titles, so neither can imitate structure. */
export function checklistText(c: Checklist): string {
  const head = `- ${JSON.stringify(c.name)} {${c.id}} ${c.items.length} item(s)`;
  return [head, ...c.items.map((item, i) => `    ${i + 1}. ${JSON.stringify(item)}`)].join('\n');
}

export function registerChecklistReadTools(server: McpServer, app: App): void {
  server.registerTool('list_checklists', {
    description: desc('list_checklists'),
    annotations: { readOnlyHint: true },
    inputSchema: {},
  }, () => guard(() => {
    const checklists = app.store.listChecklists();
    return ok(checklists.length ? checklists.map(checklistText).join('\n') : 'No checklists yet.', { checklists });
  }));
}

function resolveChecklist(store: Store, ref: string): Checklist {
  const c = store.findChecklist(ref);
  if (!c) throw new NotFoundError(`checklist not found: ${ref}`);
  return c;
}

export function registerChecklistWriteTools(server: McpServer, app: App, actor: ActorInput): void {
  server.registerTool('create_checklist', {
    description: desc('create_checklist'),
    inputSchema: {
      name: z.string().min(1).max(200),
      items: z.array(z.string().max(500)).max(200).describe('Item titles, in order. Blank ones are dropped.'),
      notes: z.string().max(20000).optional().describe('Copied to the notes of every task started from it.'),
    },
  }, (args) => guard(() => {
    const checklist = app.store.createChecklist({ name: args.name, items: args.items, notes: args.notes }, actor);
    return ok(`Created checklist ${JSON.stringify(checklist.name)} {${checklist.id}} with ${checklist.items.length} item(s). Start it with start_checklist.`, { checklist });
  }));

  server.registerTool('start_checklist', {
    description: desc('start_checklist'),
    inputSchema: {
      checklist: z.string().min(1).describe('Checklist id or name.'),
      title: z.string().max(500).optional().describe('Title of the new task. Defaults to the checklist name.'),
      project: z.string().optional().describe('Project id, slug, or name.'),
      due_at: z.string().optional().describe('YYYY-MM-DD or ISO datetime.'),
      repeat_items: z.boolean().optional().describe('If the task is later made to repeat, bring the items back as fresh subtasks each time. Defaults to true.'),
    },
  }, (args) => guard(() => {
    const checklist = resolveChecklist(app.store, args.checklist);
    const projectId = args.project ? resolveProject(app.store, args.project).id : null;
    const { task, subtasks } = app.store.startChecklist(checklist.id, { title: args.title ?? null, projectId, dueAt: args.due_at ?? null, repeatItems: args.repeat_items ?? true }, actor);
    return ok(`Started ${JSON.stringify(checklist.name)}: task ${taskRef(task)} with ${subtasks.length} subtask(s).`, { task, subtasks });
  }));
}

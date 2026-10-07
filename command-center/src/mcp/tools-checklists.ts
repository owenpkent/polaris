// MCP tools for reusable checklists. A checklist is a template: starting it makes an ordinary
// open task with one subtask per item. The list tool is in the read-only set, like every other
// read tool.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { App } from '../app.ts';
import type { Checklist } from '../core/index.ts';
import { TOOL_CATALOG } from './catalog.ts';
import { guard, ok } from './shared.ts';

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

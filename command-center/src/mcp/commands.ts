import type { Command } from '../cli-types.ts';
import { TOOL_CATALOG } from './catalog.ts';
import { runStdioServer } from './run-stdio.ts';

export const commands: Command[] = [
  {
    name: 'mcp',
    summary: 'Run the Polaris MCP server over stdio.',
    usage: 'npm run cc -- mcp [--readonly]',
    run: async (args, ctx) => {
      const app = ctx.openApp();
      try {
        await runStdioServer(app, { readonly: args.includes('--readonly') }, ctx.stderr);
      } finally {
        app.close();
      }
      return 0;
    },
  },
  {
    name: 'mcp tools',
    summary: 'List the MCP tool surface (read/write, one-line description).',
    usage: 'npm run cc -- mcp tools [--readonly]',
    run: (args, ctx) => {
      const readonly = args.includes('--readonly');
      const rows = TOOL_CATALOG.filter((t) => !readonly || t.readonly);
      const width = Math.max(...rows.map((t) => t.name.length));
      for (const t of rows) ctx.stdout(`${t.name.padEnd(width)}  ${t.readonly ? '[read] ' : '[write]'}  ${t.description}`);
      return 0;
    },
  },
];

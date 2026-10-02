// Shared stdio-transport runner, used by both the `mcp` CLI command and the standalone
// src/mcp/stdio.ts entry point so the two never drift.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { App } from '../app.ts';
import { createMcpServer, type CreateMcpServerOptions } from './server.ts';

/** Connects an MCP server to stdio and resolves when the process is asked to stop
 * (SIGINT/SIGTERM) or the transport closes. Never writes to stdout: that is reserved
 * for the JSON-RPC protocol traffic StdioServerTransport itself owns. */
export async function runStdioServer(app: App, opts: CreateMcpServerOptions = {}, log: (s: string) => void = (s) => process.stderr.write(`${s}\n`)): Promise<void> {
  const server = createMcpServer(app, opts);
  const transport = new StdioServerTransport();
  log(`polaris mcp server starting (readonly=${!!opts.readonly}, db=${app.config.dbPath})`);
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
  await server.close();
}

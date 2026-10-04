// Mounts the MCP server on Streamable HTTP in stateless mode: a fresh McpServer + transport per
// request, so JSON-RPC message ids never collide across independent HTTP calls (the SDK itself
// refuses to reuse a stateless transport across requests). Both are closed when the response ends.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { App } from '../app.ts';
import { normalizeAgentName } from '../core/agentName.ts';
import { createMcpServer } from '../mcp/server.ts';
import { sendError } from './errors.ts';

export type McpRequestHandler = (req: IncomingMessage, res: ServerResponse, parsedBody?: unknown) => Promise<void>;

export function createMcpHandler(app: App, opts: { readonly: boolean }): McpRequestHandler {
  return async (req, res, parsedBody) => {
    // An invalid header value is ignored, never a 400: the connection still works, just unnamed.
    const agentName = normalizeAgentName(req.headers['x-agent-name']) ?? undefined;
    const server = createMcpServer(app, { readonly: opts.readonly, agentName });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (e) {
      if (!res.headersSent) {
        sendError(res, 500, 'InternalError', e instanceof Error ? e.message : 'MCP request failed');
      } else {
        res.end();
      }
    }
  };
}

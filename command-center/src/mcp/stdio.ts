#!/usr/bin/env node
// Standalone entry point: node src/mcp/stdio.ts [--readonly] [--agent-name <name>]
// Opens the app the normal way (openApp -> config + store) and serves MCP over stdio.
// Nothing here writes to stdout; only stderr, so stdout stays clean for the protocol.
import { openApp } from '../app.ts';
import { normalizeAgentName } from '../core/agentName.ts';
import { runStdioServer } from './run-stdio.ts';

const readonly = process.argv.includes('--readonly');
const agentNameFlagIndex = process.argv.indexOf('--agent-name');
// An invalid name is ignored, never a startup error: it is recorded as null, not refused.
const agentName = agentNameFlagIndex === -1 ? undefined : normalizeAgentName(process.argv[agentNameFlagIndex + 1]) ?? undefined;
const app = openApp();

runStdioServer(app, { readonly, agentName }).then(
  () => { app.close(); },
  (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    app.close();
    process.exitCode = 1;
  },
);

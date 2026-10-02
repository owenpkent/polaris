#!/usr/bin/env node
// Standalone entry point: node src/mcp/stdio.ts [--readonly]
// Opens the app the normal way (openApp -> config + store) and serves MCP over stdio.
// Nothing here writes to stdout; only stderr, so stdout stays clean for the protocol.
import { openApp } from '../app.ts';
import { runStdioServer } from './run-stdio.ts';

const readonly = process.argv.includes('--readonly');
const app = openApp();

runStdioServer(app, { readonly }).then(
  () => { app.close(); },
  (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    app.close();
    process.exitCode = 1;
  },
);

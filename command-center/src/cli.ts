#!/usr/bin/env node
// Command Center CLI. Each module contributes commands from its own commands.ts.
import { openApp } from './app.ts';
import type { Command } from './cli-types.ts';
import { loadConfig } from './config.ts';
import { assertNotUpdating, UpdateInProgressError } from './update/barrier.ts';
import { commands as importer } from './importer/commands.ts';
import { commands as mcp } from './mcp/commands.ts';
import { commands as github } from './ingest/github/commands.ts';
import { commands as automation } from './automation/commands.ts';
import { commands as tasks } from './tasks/commands.ts';
import { commands as checklists } from './tasks/checklistCommands.ts';
import { commands as http } from './http/commands.ts';
import { commands as daemon } from './daemon/commands.ts';
import { commands as update } from './update/commands.ts';

const all: Command[] = [...tasks, ...checklists, ...importer, ...daemon, ...update, ...github, ...automation, ...http, ...mcp];

function help(): string {
  const w = Math.max(...all.map((c) => c.name.length));
  return ['Usage: npm run cc -- <command> [options]', '', ...all.map((c) => `  ${c.name.padEnd(w)}  ${c.summary}`)].join('\n');
}

async function main(argv: string[]): Promise<number> {
  const sorted = [...all].sort((a, b) => b.name.split(' ').length - a.name.split(' ').length);
  const cmd = sorted.find((c) => c.name.split(' ').every((part, i) => argv[i] === part));
  if (!cmd || argv.includes('--help') && argv.length === 1) {
    process.stdout.write(help() + '\n');
    return cmd || argv.length === 0 || argv[0] === '--help' ? 0 : 1;
  }
  const rest = argv.slice(cmd.name.split(' ').length);
  if (rest.includes('--help')) {
    process.stdout.write(`${cmd.name}: ${cmd.summary}\n${cmd.usage ?? ''}\n`);
    return 0;
  }
  // While `cc update` holds its write barrier (update/barrier.ts) the store is not opened: a
  // write made now could be lost to the update's rollback. The daemon is the exception (it is
  // what the update restarts, and it refuses writes itself); `cc update`, `cc backup check`, and
  // `cc backup decrypt` never open the store through here, so they are not affected.
  const openAppUnlessUpdating = () => {
    if (!cmd.runsDuringUpdate) assertNotUpdating(loadConfig().dbPath);
    return openApp();
  };
  return cmd.run(rest, { openApp: openAppUnlessUpdating, stdout: (s) => process.stdout.write(s + '\n'), stderr: (s) => process.stderr.write(s + '\n') });
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
  process.stderr.write(`${err instanceof UpdateInProgressError ? err.message : err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});

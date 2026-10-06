#!/usr/bin/env node
// Command Center CLI. Each module contributes commands from its own commands.ts.
import { openApp } from './app.ts';
import type { Command } from './cli-types.ts';
import { commands as importer } from './importer/commands.ts';
import { commands as mcp } from './mcp/commands.ts';
import { commands as github } from './ingest/github/commands.ts';
import { commands as automation } from './automation/commands.ts';
import { commands as tasks } from './tasks/commands.ts';
import { commands as http } from './http/commands.ts';
import { commands as daemon } from './daemon/commands.ts';
import { commands as update } from './update/commands.ts';

const all: Command[] = [...tasks, ...importer, ...daemon, ...update, ...github, ...automation, ...http, ...mcp];

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
  return cmd.run(rest, { openApp, stdout: (s) => process.stdout.write(s + '\n'), stderr: (s) => process.stderr.write(s + '\n') });
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});

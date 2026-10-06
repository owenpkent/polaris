// `cc update` (docs/update-proposal.md, section 1). This module only parses the flags and reads
// the config: the steps that run git, npm, the build, and the restart are in run.ts, loaded here by
// a dynamic import so that the daemon, which imports every command module's neighbours through
// cli.ts, never has that code in its static import graph (invariants.test.ts, group 11). This file
// imports nothing that starts a program.
import { parseFlags, type Command } from '../cli-types.ts';
import { loadConfig } from '../config.ts';

export const DEFAULT_PORT = 8788;

export interface UpdateArgs {
  checkOnly: boolean;
  yes: boolean;
  port: number;
}

/** --check, --yes, --port <n>. Throws on a port that is not a port. */
export function parseUpdateArgs(args: string[]): UpdateArgs {
  const flags = parseFlags(args);
  const unknown = Object.keys(flags).filter((k) => !['_', 'check', 'yes', 'port'].includes(k));
  if (unknown.length) throw new Error(`Unknown option --${unknown[0]}. Options: --check, --yes, --port <n>.`);
  if (flags._.length) throw new Error(`cc update takes no arguments, got "${flags._[0]}".`);
  let port = DEFAULT_PORT;
  if (flags.port !== undefined) {
    port = Number(flags.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port must be a port number, got "${String(flags.port)}".`);
  }
  return { checkOnly: Boolean(flags.check), yes: Boolean(flags.yes), port };
}

const updateCommand: Command = {
  name: 'update',
  summary: 'Update this install to origin/main: snapshot the database, check out, npm ci, test, build, restart the daemon, health-check, and roll back on failure. --check only reports.',
  usage: 'update [--check] [--yes] [--port 8788]    restart method from CC_UPDATE_RESTART (task, systemd:<unit>, systemd-user:<unit>, manual) or detected',
  async run(args, ctx) {
    let parsed: UpdateArgs;
    try {
      parsed = parseUpdateArgs(args);
    } catch (e) {
      ctx.stderr(e instanceof Error ? e.message : String(e));
      return 1;
    }
    const config = (ctx.config ?? loadConfig)();
    // Loaded here and not at the top: see the note at the top of this file and of run.ts.
    const run = await import('./run.ts');
    return run.runUpdate({
      repoRoot: config.repoRoot,
      dbPath: config.dbPath,
      dashboardDir: config.dashboardDir,
      port: parsed.port,
      checkOnly: parsed.checkOnly,
      yes: parsed.yes,
      restartSpec: config.updateRestart,
      stdout: ctx.stdout,
      stderr: ctx.stderr,
    }, ctx.secrets ? { ...run.defaultDeps(), secrets: ctx.secrets } : undefined);
  },
};

export const commands: Command[] = [updateCommand];

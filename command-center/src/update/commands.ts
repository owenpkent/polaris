// `cc update` (docs/update-proposal.md, sections 1 and 2). This module only parses the flags and
// reads the config: the steps that run git, npm, the build, and the restart are in run.ts, loaded
// here by a dynamic import so that the daemon, which imports every command module's neighbours
// through cli.ts, never has that code in its static import graph (invariants.test.ts, group 11).
// This file imports nothing that starts a program.
import { parseFlags, type Command } from '../cli-types.ts';
import { loadConfig } from '../config.ts';
import { parseReleaseTarget } from './releases.ts';

export const DEFAULT_PORT = 8788;

export type UpdateArgsTarget = { kind: 'main' } | { kind: 'release' } | { kind: 'to'; version: string };

export interface UpdateArgs {
  target: UpdateArgsTarget;
  checkOnly: boolean;
  trustSigners: boolean;
  /** The scheduled updater's mode (auto.ts): stands alone, with --port. */
  auto: boolean;
  yes: boolean;
  port: number;
}

const OPTIONS = '--release, --to <vX.Y.Z>, --check, --trust-signers, --auto, --yes, --port <n>';

/** --release, --to <version>, --check, --trust-signers, --auto, --yes, --port <n>. Throws on anything else. */
export function parseUpdateArgs(args: string[]): UpdateArgs {
  const flags = parseFlags(args);
  const unknown = Object.keys(flags).filter((k) => !['_', 'release', 'to', 'check', 'trust-signers', 'auto', 'yes', 'port'].includes(k));
  if (unknown.length) throw new Error(`Unknown option --${unknown[0]}. Options: ${OPTIONS}.`);
  if (flags._.length) throw new Error(`cc update takes no arguments, got "${flags._[0]}". A release is named with --to ${flags._[0]}.`);
  let port = DEFAULT_PORT;
  if (flags.port !== undefined) {
    port = Number(flags.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port must be a port number, got "${String(flags.port)}".`);
  }
  let target: UpdateArgsTarget = { kind: 'main' };
  if (flags.to !== undefined) {
    const version = typeof flags.to === 'string' ? parseReleaseTarget(flags.to) : null;
    if (version === null) throw new Error(`--to needs a release version like v2.1.0, got "${typeof flags.to === 'string' ? flags.to : ''}".`);
    if (flags.release) throw new Error('--to names the release; --release picks the newest. Use one of them.');
    target = { kind: 'to', version };
  } else if (flags.release) {
    target = { kind: 'release' };
  }
  const trustSigners = Boolean(flags['trust-signers']);
  if (trustSigners && (flags.check || target.kind !== 'main')) throw new Error('--trust-signers stands alone (with --yes to skip the question).');
  const auto = Boolean(flags.auto);
  if (auto && (flags.check || flags.yes || trustSigners || target.kind !== 'main')) throw new Error('--auto stands alone (with --port): it decides for itself what to install, and never asks.');
  return { target, checkOnly: Boolean(flags.check), trustSigners, auto, yes: Boolean(flags.yes), port };
}

const updateCommand: Command = {
  name: 'update',
  summary: 'Update this install: snapshot the database, check out origin/main (or a signed release with --release or --to), npm ci, test, build, restart the daemon, health-check, and roll back on failure. --check only reports; --trust-signers reviews the pinned release keys; --auto is the scheduled updater (signed releases only, the quiet window, the dashboard\'s requests).',
  usage: 'update [--release | --to vX.Y.Z] [--check] [--trust-signers] [--auto] [--yes] [--port 8788]    restart method from CC_UPDATE_RESTART (task, systemd:<unit>, systemd-user:<unit>, manual) or detected; --auto checks daily at CC_UPDATE_AT (04:00)',
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
    if (parsed.auto) {
      const auto = await import('./auto.ts');
      return auto.runAuto({
        repoRoot: config.repoRoot,
        dbPath: config.dbPath,
        dashboardDir: config.dashboardDir,
        port: parsed.port,
        timezone: config.timezone,
        updateAt: config.updateAt,
        restartSpec: config.updateRestart,
        stdout: ctx.stdout,
        stderr: ctx.stderr,
      }, ctx.secrets ? { ...auto.defaultDeps(), secrets: ctx.secrets } : undefined);
    }
    const run = await import('./run.ts');
    const deps = ctx.secrets ? { ...run.defaultDeps(), secrets: ctx.secrets } : undefined;
    if (parsed.trustSigners) {
      return run.runTrustSigners({ repoRoot: config.repoRoot, dbPath: config.dbPath, yes: parsed.yes, stdout: ctx.stdout, stderr: ctx.stderr }, deps);
    }
    return run.runUpdate({
      repoRoot: config.repoRoot,
      dbPath: config.dbPath,
      dashboardDir: config.dashboardDir,
      port: parsed.port,
      target: parsed.target,
      checkOnly: parsed.checkOnly,
      yes: parsed.yes,
      restartSpec: config.updateRestart,
      stdout: ctx.stdout,
      stderr: ctx.stderr,
    }, deps);
  },
};

export const commands: Command[] = [updateCommand];

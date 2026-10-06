// `cc update`, the steps of docs/update-proposal.md section 1 in order: refuse, fetch and show,
// snapshot, check out, install, test and build, restart, health check, roll back on any failure
// after the checkout moved, and log every step. This module runs git, npm, the tests, the build,
// and the restart, which the daemon never does: it is reached only through the dynamic import in
// commands.ts, so the daemon's static import graph never includes it (invariants.test.ts, group 11).
//
// Every import here is static and at the top. Node loads these modules before the first step, so
// the process keeps running the old code after the checkout has moved; a lazy import taken after
// that point would load the new code into the old process. run.test.ts checks that none is here.
//
// Every program runs through one injected Exec, and the clock, fetch, sleep, the port probe, the
// secret store, and the confirmation prompt are injected too, so the whole flow runs in a test
// with a scripted runner and nothing real started.
import { existsSync, mkdirSync, appendFileSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { inspectDatabaseFile, openStore } from '../core/index.ts';
import { MIGRATIONS } from '../core/schema.ts';
import { BACKUP_PASSPHRASE_KEY, backupDir, restoreDatabaseFile, snapshotDatabase, snapshotName } from '../daemon/backup.ts';
import { resolveTokens } from '../http/token.ts';
import { defaultSecretStore, type SecretStore } from '../ingest/secrets.ts';
import { npmProgram, realExec, type Exec } from './exec.ts';
import { git, LOCKFILES, SCHEMA_FILE } from './git.ts';
import { waitForHealthy } from './health.ts';
import { canRestart, describeRestart, detectRestart, parseRestartSpec, realPortListening, restartDaemon, restartProblem, type RestartMethod } from './restart.ts';
import { readUpdateStatus, writeUpdateStatus } from './status.ts';
import { isNewerVersion, isVersion, packageVersion } from './version.ts';

export const UPDATE_LOG_FILE = 'update.log';
const HEALTH_TIMEOUT_MS = 90_000;

export interface UpdateOptions {
  repoRoot: string;
  dbPath: string;
  /** The live dashboard folder, `dist` (config.dashboardDir). The build goes to `<it>.next` and the old one is kept as `<it>.prev`. */
  dashboardDir: string;
  port: number;
  /** Fetch and report only: nothing is installed. */
  checkOnly: boolean;
  /** Skip the confirmation. */
  yes: boolean;
  /** CC_UPDATE_RESTART, or undefined to detect the restart method. */
  restartSpec?: string;
  remote?: string;
  branch?: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export interface UpdateDeps {
  exec: Exec;
  fetch: typeof fetch;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  portListening: (port: number) => Promise<boolean>;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  secrets: SecretStore;
  confirm: (question: string) => Promise<boolean>;
}

export function defaultDeps(): UpdateDeps {
  return {
    exec: realExec(),
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    portListening: realPortListening,
    platform: process.platform,
    env: process.env,
    secrets: defaultSecretStore(),
    confirm: confirmOnTerminal,
  };
}

/** The update log, data/update.log: appended, timestamped, and echoed to the console. */
export function updateLogPath(dbPath: string): string {
  return join(dirname(dbPath), UPDATE_LOG_FILE);
}

class UpdateError extends Error {}
/** A refusal: nothing has been changed, and the message says why. */
class Refused extends Error {}

/** Runs the update and returns the exit code: 0 done or nothing to do, 1 refused or rolled back,
 *  2 rolled back and that failed too. */
export async function runUpdate(opts: UpdateOptions, deps: UpdateDeps = defaultDeps()): Promise<number> {
  const remote = opts.remote ?? 'origin';
  const branch = opts.branch ?? 'main';
  const target = `${remote}/${branch}`;
  const logFile = updateLogPath(opts.dbPath);
  mkdirSync(dirname(logFile), { recursive: true });
  const log = (line: string, to: 'stdout' | 'stderr' = 'stdout') => {
    appendFileSync(logFile, `${deps.now().toISOString()} ${line}\n`);
    (to === 'stderr' ? opts.stderr : opts.stdout)(line);
  };
  const repo = git(deps.exec, opts.repoRoot);
  const npm = npmProgram('npm', deps.platform);
  const npx = npmProgram('npx', deps.platform);
  const program = async (what: string, cmd: string, args: string[], cwd: string): Promise<void> => {
    log(`> ${what}`);
    const r = await deps.exec(cmd, args, { cwd, env: deps.env, onOutput: (line) => appendFileSync(logFile, `    ${line}\n`) });
    if (r.code !== 0) {
      const tail = `${r.stdout}\n${r.stderr}`.split('\n').filter(Boolean).slice(-15);
      for (const line of tail) opts.stderr(`    ${line}`);
      throw new UpdateError(`${what} failed (exit ${r.code}); the full output is in ${logFile}`);
    }
  };
  const distNext = `${opts.dashboardDir}.next`;
  const distPrev = `${opts.dashboardDir}.prev`;

  log(`cc update: ${opts.repoRoot} against ${target}${opts.checkOnly ? ' (--check)' : ''}`);
  let moved = false;
  let previousSha = '';
  let running = '';
  let snapshot: string | undefined;
  let passphrase: string | undefined;
  let method: RestartMethod = { kind: 'manual' };
  let restartAttempted = false;
  let swapped = false;
  const schemaBefore = MIGRATIONS.length;

  try {
    // 1. Refuse: nothing below may run on a tree that carries work, or stands anywhere but main.
    const dirty = await repo.statusLines();
    if (dirty.length) throw new Refused(`the working tree has uncommitted changes (${dirty.length} path${dirty.length === 1 ? '' : 's'}; see git status). Commit or stash them, or update a deploy checkout.`);
    const onBranch = await repo.branch();
    if (onBranch !== branch) {
      const tag = onBranch === null ? await repo.tagAtHead() : null;
      if (tag) throw new Refused(`the checkout is on the release tag ${tag}. Updating from a tag to ${branch} is not what cc update does; cc update --release will move between releases.`);
      throw new Refused(onBranch === null ? `HEAD is detached and not on a release tag. Check out ${branch} first.` : `the checkout is on ${onBranch}, not ${branch}.`);
    }
    running = packageVersion(readFileSync(join(opts.repoRoot, 'package.json'), 'utf8')) ?? '';
    if (!isVersion(running)) throw new Refused(`package.json's version "${running}" is not MAJOR.MINOR.PATCH, so nothing can be newer than it.`);
    method = opts.restartSpec !== undefined ? parseRestartSpec(opts.restartSpec) : await detectRestart(deps.exec, deps.platform);
    log(`Restart: ${describeRestart(method)}`);
    if (!opts.checkOnly) {
      const problem = await restartProblem(method, deps.exec);
      if (problem) throw new Refused(`the daemon could not be restarted afterwards: ${problem}`);
    }

    // 2. Fetch and show what changes.
    await repo.fetch(remote);
    const { ahead, behind } = await repo.aheadBehind(target);
    if (ahead > 0) throw new Refused(`${ahead} local commit${ahead === 1 ? ' is' : 's are'} not on ${target}. An update must not throw work away: push or move them first.`);
    previousSha = await repo.revParse('HEAD');
    const targetSha = await repo.revParse(target);
    const targetVersion = packageVersion((await repo.showFile(target, 'package.json')) ?? '');
    log(`Running ${running} at ${previousSha.slice(0, 7)}; ${target} is ${targetVersion ?? 'no version'} at ${targetSha.slice(0, 7)}, ${behind} commit${behind === 1 ? '' : 's'} ahead.`);
    if (behind === 0) { log('Already up to date. Nothing installed.'); return 0; }
    for (const line of await repo.logLines('HEAD', target)) log(`  ${line}`);
    const changed = await repo.changedFiles('HEAD', target, [SCHEMA_FILE, ...LOCKFILES]);
    const touchesSchema = changed.includes(SCHEMA_FILE);
    const lockfiles = changed.filter((f) => LOCKFILES.includes(f));
    log(touchesSchema ? 'The schema changes: a snapshot of the database is taken first, and a rollback restores it.' : 'The schema does not change.');
    log(lockfiles.length ? `Dependencies change (${lockfiles.join(', ')}): npm ci --ignore-scripts runs from the new lockfiles.` : 'Dependencies do not change.');
    if (targetVersion === null || !isVersion(targetVersion)) throw new Refused(`package.json on ${target} has no MAJOR.MINOR.PATCH version. Nothing installed.`);
    if (!isNewerVersion(targetVersion, running)) throw new Refused(`${target} is ${targetVersion}, which is not newer than the running ${running}. Nothing installed.`);
    if (opts.checkOnly) { log(`${targetVersion} is available. Run cc update to install it.`); return 0; }
    if (!opts.yes && !(await deps.confirm(`Update ${running} to ${targetVersion} and restart the daemon? [y/N] `))) { log('Not updating. Pass --yes to update without the question.'); return 0; }

    // 3. Snapshot, live, while the checkout is still on the old code.
    if (existsSync(opts.dbPath)) {
      passphrase = await deps.secrets.get(BACKUP_PASSPHRASE_KEY);
      const dir = backupDir(opts.dbPath, deps.env)!;
      const store = openStore(opts.dbPath);
      try {
        snapshot = snapshotDatabase(store, dir, snapshotName(running, deps.now()), { passphrase }).file;
      } finally {
        store.db.close();
      }
      log(`Snapshot ${snapshot}${passphrase ? ' (encrypted)' : ''}`);
    } else {
      log(`No database at ${opts.dbPath}: nothing to snapshot.`);
    }

    // 4. Check out. From here on any failure rolls back.
    await repo.fastForward(target);
    moved = true;
    log(`Checked out ${targetSha.slice(0, 7)} (${target}).`);
    const installedVersion = packageVersion(readFileSync(join(opts.repoRoot, 'package.json'), 'utf8'));
    if (installedVersion !== targetVersion) throw new UpdateError(`the checkout says version ${installedVersion ?? 'none'}, not ${targetVersion}`);

    // 5. Install from the lockfiles. Install scripts are skipped except esbuild's, which fetches
    // the binary the build needs; installScripts.test.ts pins that list.
    await program('npm ci --ignore-scripts', npm, ['ci', '--ignore-scripts'], opts.repoRoot);
    await program('npm ci --ignore-scripts (command-center)', npm, ['ci', '--ignore-scripts'], join(opts.repoRoot, 'command-center'));
    await program('npm rebuild esbuild', npm, ['rebuild', 'esbuild'], opts.repoRoot);

    // 6. Test, then build beside the live dashboard, which stays as it is until the restart.
    await program('npm run test:fast', npm, ['run', 'test:fast'], opts.repoRoot);
    rmSync(distNext, { recursive: true, force: true });
    await program('vite build', npx, ['vite', 'build', '--outDir', distNext, '--emptyOutDir'], opts.repoRoot);
    if (!existsSync(join(distNext, 'index.html'))) throw new UpdateError(`the build left no index.html in ${distNext}`);

    // 7. Restart, swapping the dashboard in while nothing serves it.
    log(`Restarting the daemon: ${describeRestart(method)}`);
    restartAttempted = true;
    await restartDaemon(method, { port: opts.port, between: () => { swapDist(opts.dashboardDir, distNext, distPrev); swapped = true; } }, restartDeps());

    // 8. Health: our daemon, holding our token, on the new version.
    const health = await waitForHealthy({ port: opts.port, apiToken: resolveTokens(opts.dbPath, deps.env).api, expectedVersion: targetVersion }, HEALTH_TIMEOUT_MS, healthDeps());
    if (!health.ok) throw new UpdateError(`the health check failed: ${health.reason}`);
    log(`Updated to ${targetVersion}. The daemon is up on port ${opts.port}.`);
    recordResult(true, `Updated to ${targetVersion}`, targetVersion);
    return 0;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof Refused) { log(`Refused: ${message}`, 'stderr'); return 1; }
    if (!moved) { log(`Failed before anything changed: ${message}`, 'stderr'); return 1; }

    // 9. Roll back: the previous commit, its dependencies, the previous dashboard, and, when the
    // new code migrated the database, the snapshot.
    log(`FAILED: ${message}`, 'stderr');
    log(`Rolling back to ${running} at ${previousSha.slice(0, 7)}.`);
    try {
      await repo.resetHard(previousSha);
      await program('npm ci --ignore-scripts (rollback)', npm, ['ci', '--ignore-scripts'], opts.repoRoot);
      await program('npm ci --ignore-scripts (command-center, rollback)', npm, ['ci', '--ignore-scripts'], join(opts.repoRoot, 'command-center'));
      await program('npm rebuild esbuild (rollback)', npm, ['rebuild', 'esbuild'], opts.repoRoot);
      const migrated = existsSync(opts.dbPath) && inspectDatabaseFile(opts.dbPath).schemaVersion > schemaBefore;
      if (migrated && !snapshot) throw new UpdateError(`the database is at a schema newer than ${running} knows and there is no snapshot to restore`);
      if (!restartAttempted) {
        // The daemon never stopped and still runs the old code on the old dashboard.
        rmSync(distNext, { recursive: true, force: true });
        if (migrated) throw new UpdateError('the database was migrated although the daemon was never restarted');
        log(`Rolled back. The daemon was not restarted and runs ${running} as before.`);
      } else {
        if (!canRestart(method)) log('The daemon has to be stopped and started once more by hand to finish the rollback.', 'stderr');
        await restartDaemon(method, {
          port: opts.port,
          between: () => {
            if (swapped) restoreDist(opts.dashboardDir, distPrev);
            else rmSync(distNext, { recursive: true, force: true });
            if (migrated) {
              restoreDatabaseFile(snapshot!, opts.dbPath, passphrase);
              log(`Restored the database from ${snapshot}.`);
            }
          },
        }, restartDeps());
        const health = await waitForHealthy({ port: opts.port, apiToken: resolveTokens(opts.dbPath, deps.env).api, expectedVersion: running }, HEALTH_TIMEOUT_MS, healthDeps());
        if (!health.ok) throw new UpdateError(`the health check after the rollback failed: ${health.reason}`);
        log(`Rolled back. The daemon is up on port ${opts.port} running ${running}.`);
      }
      recordResult(false, `Rolled back: ${message}`, running);
      return 1;
    } catch (e2) {
      const why = e2 instanceof Error ? e2.message : String(e2);
      log(`ROLLBACK FAILED: ${why}`, 'stderr');
      log(`The previous commit is ${previousSha}. ${snapshot ? `The database snapshot is ${snapshot}.` : 'There is no database snapshot.'}`, 'stderr');
      log(`To finish by hand: stop the daemon, git reset --hard ${previousSha}, npm ci --ignore-scripts in both package folders, npm rebuild esbuild, put ${distPrev} back as ${opts.dashboardDir}${snapshot ? `, restore ${snapshot} over ${opts.dbPath} if the schema moved` : ''}, then start the daemon.`, 'stderr');
      recordResult(false, `Rolled back, and that failed: ${why}`, null);
      return 2;
    }
  }

  function restartDeps() {
    return { exec: deps.exec, portListening: deps.portListening, sleep: deps.sleep, now: () => deps.now().getTime(), say: (line: string) => log(line) };
  }
  function healthDeps() {
    return { fetch: deps.fetch, sleep: deps.sleep, now: () => deps.now().getTime() };
  }
  /** The status file (status.ts): a manual run leaves `updaterInstalled` false; --auto (phase C) sets it. */
  function recordResult(ok: boolean, message: string, version: string | null): void {
    const at = deps.now().toISOString();
    writeUpdateStatus(opts.dbPath, {
      ...readUpdateStatus(opts.dbPath),
      updaterInstalled: false,
      running: version,
      lastResult: { ok, message, at, version: version ?? '' },
    });
  }
}

/** `dist` becomes `dist.prev` (replacing an older one) and `dist.next` becomes `dist`. */
function swapDist(dist: string, next: string, prev: string): void {
  rmSync(prev, { recursive: true, force: true });
  if (existsSync(dist)) renameSync(dist, prev);
  renameSync(next, dist);
}

/** The reverse: the new `dist` goes, and `dist.prev` comes back if there was one. */
function restoreDist(dist: string, prev: string): void {
  rmSync(dist, { recursive: true, force: true });
  if (existsSync(prev)) renameSync(prev, dist);
}

function confirmOnTerminal(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(/^y(es)?$/i.test(answer.trim())); }));
}

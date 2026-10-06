// `cc update`, the steps of docs/update-proposal.md section 1 in order: refuse, fetch and show,
// snapshot, check out, install, test and build, restart, health check, roll back on any failure
// after the checkout moved, and log every step. The target is `origin/main` (the pre-release
// world) or a signed release tag (`--release`, `--to`), verified against the pinned signers
// (signers.ts) before anything moves. This module runs git, npm, the tests, the build, and the
// restart, which the daemon never does: it is reached only through the dynamic import in
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
import { git, LOCKFILES, SCHEMA_FILE, type Git } from './git.ts';
import { waitForHealthy } from './health.ts';
import { releaseTag, releaseTags, sanitizeNotes, type ReleaseTag } from './releases.ts';
import { canRestart, describeRestart, detectRestart, parseRestartSpec, realPortListening, restartDaemon, restartProblem, type RestartMethod } from './restart.ts';
import { RELEASE_SIGNERS_FILE, committedSignersPath, describeSigners, parseAllowedSigners, pinSigners, pinnedSignersPath, readSignersFile, sameSigners, SignersError, type Signer } from './signers.ts';
import { readUpdateStatus, writeUpdateStatus } from './status.ts';
import { compareVersions, isNewerVersion, isVersion, packageVersion, parseVersion } from './version.ts';

export const UPDATE_LOG_FILE = 'update.log';
const HEALTH_TIMEOUT_MS = 90_000;

/** What `cc update` moves to: `origin/main`, the newest verified release, or one named release. */
export type UpdateTarget = { kind: 'main' } | { kind: 'release' } | { kind: 'to'; version: string };

export interface UpdateOptions {
  repoRoot: string;
  dbPath: string;
  /** The live dashboard folder, `dist` (config.dashboardDir). The build goes to `<it>.next` and the old one is kept as `<it>.prev`. */
  dashboardDir: string;
  port: number;
  /** Defaults to `origin/main`. */
  target?: UpdateTarget;
  /** Fetch and report only, for `origin/main` and for the releases: nothing is installed. */
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

type Log = (line: string, to?: 'stdout' | 'stderr') => void;

/** What an update would install, worked out before anything moves. */
interface Plan {
  /** `origin/main`, or the tag. */
  ref: string;
  sha: string;
  version: string;
  /** The tag for a release; null for `origin/main`. */
  tag: string | null;
  /** The release notes, sanitised; null for `origin/main`. */
  notes: string | null;
  touchesSchema: boolean;
  lockfiles: string[];
}

interface Considered {
  plan: Plan | null;
  /** Why there is no plan, when there is none. */
  reason?: string;
  /** True when the reason is "nothing is newer", which is not a fault. */
  nothingNewer?: boolean;
}

/** Runs the update and returns the exit code: 0 done or nothing to do, 1 refused or rolled back,
 *  2 rolled back and that failed too. */
export async function runUpdate(opts: UpdateOptions, deps: UpdateDeps = defaultDeps()): Promise<number> {
  const remote = opts.remote ?? 'origin';
  const branch = opts.branch ?? 'main';
  const branchRef = `${remote}/${branch}`;
  const target = opts.target ?? { kind: 'main' };
  const wantsRelease = target.kind !== 'main';
  const log = openLog(opts, deps);
  const repo = git(deps.exec, opts.repoRoot);
  const npm = npmProgram('npm', deps.platform);
  const npx = npmProgram('npx', deps.platform);
  const program = async (what: string, cmd: string, args: string[], cwd: string): Promise<void> => {
    log(`> ${what}`);
    const r = await deps.exec(cmd, args, { cwd, env: deps.env, onOutput: (line) => appendFileSync(updateLogPath(opts.dbPath), `    ${line}\n`) });
    if (r.code !== 0) {
      const tail = `${r.stdout}\n${r.stderr}`.split('\n').filter(Boolean).slice(-15);
      for (const line of tail) opts.stderr(`    ${line}`);
      throw new UpdateError(`${what} failed (exit ${r.code}); the full output is in ${updateLogPath(opts.dbPath)}`);
    }
  };
  const distNext = `${opts.dashboardDir}.next`;
  const distPrev = `${opts.dashboardDir}.prev`;

  const what = target.kind === 'main' ? branchRef : target.kind === 'release' ? 'the newest signed release' : releaseTag(target.version);
  log(`cc update: ${opts.repoRoot} against ${what}${opts.checkOnly ? ' (--check)' : ''}`);
  let moved = false;
  let depsTouched = false;
  let previousSha = '';
  let startTag: string | null = null;
  let running = '';
  let plan: Plan | null = null;
  let snapshot: string | undefined;
  let passphrase: string | undefined;
  let method: RestartMethod = { kind: 'manual' };
  let restartAttempted = false;
  let swapped = false;
  const schemaBefore = MIGRATIONS.length;

  try {
    // 1. Refuse: nothing below may run on a tree that carries work, or stands anywhere but main
    // or a release tag.
    const dirty = await repo.statusLines();
    if (dirty.length) throw new Refused(`the working tree has uncommitted changes (${dirty.length} path${dirty.length === 1 ? '' : 's'}; see git status). Commit or stash them, or update a deploy checkout.`);
    const onBranch = await repo.branch();
    if (onBranch !== branch) {
      const tag = onBranch === null ? await repo.tagAtHead() : null;
      if (!tag) throw new Refused(onBranch === null ? `HEAD is detached and not on a release tag. Check out ${branch} first.` : `the checkout is on ${onBranch}, not ${branch}.`);
      if (!wantsRelease && !opts.checkOnly) throw new Refused(`the checkout is on the release tag ${tag}. Updating from a tag to ${branch} is not what cc update does; cc update --release moves between releases.`);
      startTag = tag;
    }
    running = packageVersion(readFileSync(join(opts.repoRoot, 'package.json'), 'utf8')) ?? '';
    if (!isVersion(running)) throw new Refused(`package.json's version "${running}" is not MAJOR.MINOR.PATCH, so nothing can be newer than it.`);
    method = opts.restartSpec !== undefined ? parseRestartSpec(opts.restartSpec) : await detectRestart(deps.exec, deps.platform);
    log(`Restart: ${describeRestart(method)}`);
    if (!opts.checkOnly) {
      const problem = await restartProblem(method, deps.exec);
      if (problem) throw new Refused(`the daemon could not be restarted afterwards: ${problem}`);
    }

    // 2. Fetch, then work out what would be installed and show it.
    if (wantsRelease || opts.checkOnly) await repo.fetchTags(remote);
    else await repo.fetch(remote);
    previousSha = await repo.revParse('HEAD');
    if (startTag === null) {
      const { ahead } = await repo.aheadBehind(branchRef);
      if (ahead > 0) throw new Refused(`${ahead} local commit${ahead === 1 ? ' is' : 's are'} not on ${branchRef}. An update must not throw work away: push or move them first.`);
    } else {
      log(`Running ${running} on the release tag ${startTag} at ${previousSha.slice(0, 7)}.`);
    }

    if (opts.checkOnly) {
      // --check: what origin/main would give, then the releases, and the status file for the
      // dashboard. Nothing is refused here: each channel reports its own answer.
      if (startTag === null) {
        const main = await considerMain(repo, branchRef, running, previousSha, log);
        if (main.plan) log(`${main.plan.version} is available from ${branchRef}. Run cc update to install it.`);
        else log(`${branchRef}: ${main.reason}`);
      } else {
        log(`${branchRef} is not a target from a release tag; cc update --release moves between releases.`);
      }
      const release = await considerRelease(repo, opts, deps, { kind: 'release' }, running, startTag, remote, log);
      if (release.plan) log(`${release.plan.tag} is available. Run cc update --release to install it.`);
      else log(`Releases: ${release.reason}`, release.nothingNewer ? 'stdout' : 'stderr');
      const at = deps.now().toISOString();
      writeUpdateStatus(opts.dbPath, {
        ...readUpdateStatus(opts.dbPath),
        lastCheckAt: at,
        available: release.plan ? { version: release.plan.version, notes: release.plan.notes ?? '', touchesSchema: release.plan.touchesSchema } : null,
      });
      return 0;
    }

    const considered = wantsRelease
      ? await considerRelease(repo, opts, deps, target, running, startTag, remote, log)
      : await considerMain(repo, branchRef, running, previousSha, log);
    if (!considered.plan) {
      if (considered.nothingNewer) { log(`${considered.reason} Nothing installed.`); return 0; }
      throw new Refused(considered.reason ?? 'nothing to install');
    }
    plan = considered.plan;
    if (!opts.yes && !(await deps.confirm(`Update ${running} to ${plan.version}${plan.tag ? ` (${plan.tag})` : ''} and restart the daemon? [y/N] `))) { log('Not updating. Pass --yes to update without the question.'); return 0; }

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

    // 4. Check out. From here on any failure rolls back. A release is checked out detached; main
    // is fast-forwarded. Then the checkout must say it is the version it was chosen for.
    if (plan.tag) await repo.checkout(plan.tag, { detach: true });
    else await repo.fastForward(plan.ref);
    moved = true;
    log(`Checked out ${plan.sha.slice(0, 7)} (${plan.ref}).`);
    const installedVersion = packageVersion(readFileSync(join(opts.repoRoot, 'package.json'), 'utf8'));
    if (installedVersion !== plan.version) {
      throw new UpdateError(plan.tag
        ? `the release ${plan.tag} says version ${installedVersion ?? 'none'} in its package.json, not ${plan.version}: a release is what it says it is or it does not run`
        : `the checkout says version ${installedVersion ?? 'none'}, not ${plan.version}`);
    }

    // 5. Install from the lockfiles. Install scripts are skipped except esbuild's, which fetches
    // the binary the build needs; installScripts.test.ts pins that list.
    depsTouched = true;
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
    const health = await waitForHealthy({ port: opts.port, apiToken: resolveTokens(opts.dbPath, deps.env).api, expectedVersion: plan.version }, HEALTH_TIMEOUT_MS, healthDeps());
    if (!health.ok) throw new UpdateError(`the health check failed: ${health.reason}`);
    log(`Updated to ${plan.version}${plan.tag ? ` (${plan.tag})` : ''}. The daemon is up on port ${opts.port}.`);
    recordResult(true, `Updated to ${plan.version}`, plan.version);
    return 0;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof Refused || e instanceof SignersError) { log(`Refused: ${message}`, 'stderr'); return 1; }
    if (!moved) { log(`Failed before anything changed: ${message}`, 'stderr'); return 1; }

    // 9. Roll back: the previous commit, its dependencies, the previous dashboard, and, when the
    // new code migrated the database, the snapshot.
    log(`FAILED: ${message}`, 'stderr');
    log(`Rolling back to ${running} at ${previousSha.slice(0, 7)}.`);
    try {
      if (plan?.tag) {
        // The checkout was detached onto the tag; the branch (if that is where we started) never moved.
        if (startTag === null) await repo.checkout(branch, { detach: false, force: true });
        else await repo.checkout(previousSha, { detach: true, force: true });
      } else {
        await repo.resetHard(previousSha);
      }
      if (depsTouched) {
        await program('npm ci --ignore-scripts (rollback)', npm, ['ci', '--ignore-scripts'], opts.repoRoot);
        await program('npm ci --ignore-scripts (command-center, rollback)', npm, ['ci', '--ignore-scripts'], join(opts.repoRoot, 'command-center'));
        await program('npm rebuild esbuild (rollback)', npm, ['rebuild', 'esbuild'], opts.repoRoot);
      }
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
      log(`To finish by hand: stop the daemon, git checkout --force ${startTag === null ? branch : `--detach ${previousSha}`} (at ${previousSha}), npm ci --ignore-scripts in both package folders, npm rebuild esbuild, put ${distPrev} back as ${opts.dashboardDir}${snapshot ? `, restore ${snapshot} over ${opts.dbPath} if the schema moved` : ''}, then start the daemon.`, 'stderr');
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
  /** The status file (status.ts): a manual run leaves `updaterInstalled` false; --auto (phase C)
   *  sets it. A successful install clears `available`, which named what was just installed. */
  function recordResult(ok: boolean, message: string, version: string | null): void {
    const at = deps.now().toISOString();
    const before = readUpdateStatus(opts.dbPath);
    writeUpdateStatus(opts.dbPath, {
      ...before,
      updaterInstalled: false,
      running: version,
      available: ok ? null : before.available,
      lastResult: { ok, message, at, version: version ?? '' },
    });
  }
}

/** `origin/main` as a target (section 1B): it must be strictly ahead of HEAD, and its version
 *  must not be older than the running one. The same version with new commits is the everyday
 *  case before releases exist: a merge need not bump the version. */
async function considerMain(repo: Git, branchRef: string, running: string, previousSha: string, log: Log): Promise<Considered> {
  const { behind } = await repo.aheadBehind(branchRef);
  const sha = await repo.revParse(branchRef);
  const version = packageVersion((await repo.showFile(branchRef, 'package.json')) ?? '');
  log(`Running ${running} at ${previousSha.slice(0, 7)}; ${branchRef} is ${version ?? 'no version'} at ${sha.slice(0, 7)}, ${behind} commit${behind === 1 ? '' : 's'} ahead.`);
  if (behind === 0) return { plan: null, reason: 'Already up to date.', nothingNewer: true };
  for (const line of await repo.logLines('HEAD', branchRef)) log(`  ${line}`);
  const { touchesSchema, lockfiles } = await describeChanges(repo, branchRef, log);
  if (version === null || !isVersion(version)) return { plan: null, reason: `package.json on ${branchRef} has no MAJOR.MINOR.PATCH version. Nothing installed.` };
  if (compareVersions(parseVersion(version)!, parseVersion(running)!) < 0) return { plan: null, reason: `${branchRef} is ${version}, which is older than the running ${running}. Nothing installed.` };
  return { plan: { ref: branchRef, sha, version, tag: null, notes: null, touchesSchema, lockfiles } };
}

/** A release as a target (section 2): the signers are pinned on first use and the checkout's
 *  file is only compared against the pinned copy; then the newest tag strictly newer than the
 *  running version that verifies against the pinned keys, or the one named by `--to`, which must
 *  verify and be strictly newer. A tag that does not verify is skipped and reported. */
async function considerRelease(repo: Git, opts: UpdateOptions, deps: UpdateDeps, target: UpdateTarget, running: string, startTag: string | null, remote: string, log: Log): Promise<Considered> {
  const pinnedFile = pinnedSignersPath(opts.dbPath);
  const committedFile = committedSignersPath(opts.repoRoot);
  if (!existsSync(pinnedFile)) {
    if (!existsSync(committedFile)) return { plan: null, reason: `there is no ${RELEASE_SIGNERS_FILE} file in the checkout and none is pinned at ${pinnedFile}, so no release can verify.` };
    mkdirSync(dirname(pinnedFile), { recursive: true });
    const pinned = pinSigners(committedFile, pinnedFile);
    log(`Pinned ${RELEASE_SIGNERS_FILE} (${pinned.length} key${pinned.length === 1 ? '' : 's'}) to ${pinnedFile}: releases verify against that copy from now on, and cc update --trust-signers is how it changes.`);
  }
  const pinned = readSignersFile(pinnedFile, deps.platform);
  if (existsSync(committedFile)) {
    const committed = parseAllowedSigners(readFileSync(committedFile, 'utf8'));
    if (!sameSigners(committed, pinned.signers)) log(`The signers file changed; run cc update --trust-signers to review it. Verifying against the pinned copy at ${pinnedFile}.`, 'stderr');
  } else {
    log(`The checkout has no ${RELEASE_SIGNERS_FILE} file; verifying against the pinned copy at ${pinnedFile}.`, 'stderr');
  }
  if (!pinned.signers.length) return { plan: null, reason: `no release can verify: the pinned signers file ${pinnedFile} has no keys. Add the release key to ${RELEASE_SIGNERS_FILE} (docs/releases.md) and run cc update --trust-signers.` };
  log(`Verifying tags against ${pinned.signers.length} pinned key${pinned.signers.length === 1 ? '' : 's'}.`);
  if (startTag !== null) {
    const v = await repo.verifyTag(startTag, pinnedFile);
    if (!v.ok) return { plan: null, reason: `the checkout is on ${startTag}, which does not verify against the pinned signers (${v.reason}). Check out main, or review the signers.` };
  }

  const tags = releaseTags(await repo.tags());
  log(`${tags.length} release tag${tags.length === 1 ? '' : 's'} from ${remote}${tags.length ? `; newest ${tags[0].tag}` : ''}.`);
  let chosen: ReleaseTag | null = null;
  if (target.kind === 'to') {
    const want = tags.find((t) => t.version === target.version) ?? null;
    if (!want) return { plan: null, reason: `there is no release tag ${releaseTag(target.version)}${tags.length ? ` (the newest is ${tags[0].tag})` : ' (there are no release tags)'}.` };
    if (!isNewerVersion(want.version, running)) return { plan: null, reason: `${want.tag} is not newer than the running ${running}. Moving back is a deliberate git checkout by you, outside cc update.` };
    const v = await repo.verifyTag(want.tag, pinnedFile);
    if (!v.ok) return { plan: null, reason: `${want.tag} does not verify against the pinned signers: ${v.reason}. Nothing installed.` };
    chosen = want;
  } else {
    const newer = tags.filter((t) => isNewerVersion(t.version, running));
    let skipped = 0;
    for (const t of newer) {
      const v = await repo.verifyTag(t.tag, pinnedFile);
      if (v.ok) { chosen = t; break; }
      skipped++;
      log(`Skipped ${t.tag}: ${v.reason}`, 'stderr');
    }
    if (!chosen) {
      if (!newer.length) return { plan: null, reason: `No release is newer than the running ${running}.`, nothingNewer: true };
      return { plan: null, reason: `no release newer than ${running} verifies against the pinned signers (${skipped} skipped). Nothing installed.` };
    }
  }

  const sha = await repo.revParse(chosen.tag);
  const notes = sanitizeNotes(await repo.tagNotes(chosen.tag));
  log(`${chosen.tag} (${chosen.version}) at ${sha.slice(0, 7)} verifies. Running ${running}.`);
  for (const line of await repo.logLines('HEAD', chosen.tag)) log(`  ${line}`);
  if (notes) { log('Release notes:'); for (const line of notes.split('\n')) log(`  ${line}`); }
  const { touchesSchema, lockfiles } = await describeChanges(repo, chosen.tag, log);
  return { plan: { ref: chosen.tag, sha, version: chosen.version, tag: chosen.tag, notes, touchesSchema, lockfiles } };
}

async function describeChanges(repo: Git, ref: string, log: Log): Promise<{ touchesSchema: boolean; lockfiles: string[] }> {
  const changed = await repo.changedFiles('HEAD', ref, [SCHEMA_FILE, ...LOCKFILES]);
  const touchesSchema = changed.includes(SCHEMA_FILE);
  const lockfiles = changed.filter((f) => LOCKFILES.includes(f));
  log(touchesSchema ? 'The schema changes: a snapshot of the database is taken first, and a rollback restores it.' : 'The schema does not change.');
  log(lockfiles.length ? `Dependencies change (${lockfiles.join(', ')}): npm ci --ignore-scripts runs from the new lockfiles.` : 'Dependencies do not change.');
  return { touchesSchema, lockfiles };
}

export interface TrustSignersOptions {
  repoRoot: string;
  dbPath: string;
  /** Replace the pinned copy without the question. */
  yes: boolean;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/** `cc update --trust-signers`: show the pinned keys and the committed keys side by side, with
 *  their fingerprints, and replace the pinned copy once the owner has said yes. This is the one
 *  way the pinned copy changes after the first use. Exit 0 when done or nothing changed, 1 when
 *  there is nothing to trust. */
export async function runTrustSigners(opts: TrustSignersOptions, deps: UpdateDeps = defaultDeps()): Promise<number> {
  const log = openLog(opts, deps);
  const pinnedFile = pinnedSignersPath(opts.dbPath);
  const committedFile = committedSignersPath(opts.repoRoot);
  log(`cc update --trust-signers: ${committedFile} against the pinned ${pinnedFile}`);
  try {
    if (!existsSync(committedFile)) { log(`Refused: there is no ${RELEASE_SIGNERS_FILE} file at ${committedFile}.`, 'stderr'); return 1; }
    const committed = parseAllowedSigners(readFileSync(committedFile, 'utf8'));
    let pinned: Signer[] | null = null;
    if (existsSync(pinnedFile)) pinned = readSignersFile(pinnedFile, deps.platform).signers;
    log(pinned === null ? `Pinned (${pinnedFile}): nothing pinned yet` : `Pinned (${pinnedFile}):`);
    if (pinned !== null) for (const line of await describeSigners(deps.exec, pinned)) log(line);
    log(`Committed (${committedFile}):`);
    for (const line of await describeSigners(deps.exec, committed)) log(line);
    if (pinned !== null && sameSigners(committed, pinned)) { log('The pinned copy already allows the same keys. Nothing changed.'); return 0; }
    if (!committed.length) log(`The committed file has no keys: once pinned, no release can verify until a key is added and trusted.`, 'stderr');
    if (!opts.yes && !(await deps.confirm(`Trust the committed keys for releases from now on? [y/N] `))) { log('Not changed. Pass --yes to trust them without the question.'); return 0; }
    mkdirSync(dirname(pinnedFile), { recursive: true });
    const now = pinSigners(committedFile, pinnedFile);
    log(`Pinned ${now.length} key${now.length === 1 ? '' : 's'} to ${pinnedFile}. Releases verify against that copy from now on.`);
    return 0;
  } catch (e) {
    log(`Refused: ${e instanceof Error ? e.message : String(e)}`, 'stderr');
    return 1;
  }
}

function openLog(opts: Pick<UpdateOptions, 'dbPath' | 'stdout' | 'stderr'>, deps: Pick<UpdateDeps, 'now'>): Log {
  const logFile = updateLogPath(opts.dbPath);
  mkdirSync(dirname(logFile), { recursive: true });
  return (line, to = 'stdout') => {
    appendFileSync(logFile, `${deps.now().toISOString()} ${line}\n`);
    (to === 'stderr' ? opts.stderr : opts.stdout)(line);
  };
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

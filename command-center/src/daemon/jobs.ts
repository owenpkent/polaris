// Job catalog shared by the one-shot `sync` command and the long-running daemon.
// Every job records sync.<name>.lastAt on success and sync.<name>.lastError on failure,
// which the digest's source freshness section and the dashboard's sync strip read.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { App } from '../app.ts';
import type { Json } from '../core/index.ts';
import { buildDigest, markDigestDelivered, runRules } from '../automation/index.ts';
import { formatReport, type SyncReport } from '../ingest/common.ts';
import { syncGithub } from '../ingest/github/sync.ts';
import { syncGithubRepoFiles } from '../ingest/github/repoFiles.ts';
import { hasInitiatives, importInitiativeFiles, initiativesDir } from '../importer/initiatives.ts';
import { BACKUP_PASSPHRASE_KEY, backupDatabase, backupDir, DEFAULT_BACKUP_KEEP } from './backup.ts';
import { defaultSecretStore } from '../ingest/secrets.ts';
import { passphraseProblem } from './backupCrypto.ts';

export interface JobDefinition {
  name: string;
  summary: string;
  /** Default daemon cadence. Exactly one of everyMs or dailyAt. */
  everyMs?: number;
  dailyAt?: string;
  /** Daily jobs only: the daemon runs the job at startup when its last success is over a day old,
   *  so a machine that was off at `dailyAt` does not go without. */
  catchUp?: boolean;
  run(app: App, log: (line: string) => void): Promise<string>;
}

const MIN = 60_000;

export function reportLine(r: SyncReport): string {
  if (r.partial && r.errors.some((e) => e.startsWith('skipped:'))) throw new SkippedError(r.errors.join('; '));
  if (r.errors.length) throw new Error(`${formatReport(r)}\n${r.errors.join('\n')}`);
  return formatReport(r);
}

export class SkippedError extends Error {}

export const JOBS: JobDefinition[] = [
  {
    name: 'import',
    summary: 'Re-import the initiatives/*.md files',
    everyMs: 30 * MIN,
    async run(app) {
      // A checkout without initiatives/ (the public repo, an install) has nothing to import: a
      // skipped job, like the GitHub syncs when nobody is signed in, not a success with zero counts.
      if (!hasInitiatives(app.config.repoRoot)) throw new SkippedError(`no initiatives folder at ${initiativesDir(app.config.repoRoot)}`);
      const init = importInitiativeFiles(app.store, app.config.repoRoot);
      return `import: initiatives ${init.created} new ${init.updated} updated; tasks ${init.tasks.created} new ${init.tasks.updated} updated ${init.tasks.gone} gone`;
    },
  },
  {
    name: 'github',
    summary: 'GitHub issues, review requests, and PRs needing attention',
    everyMs: 15 * MIN,
    async run(app, log) { return reportLine(await syncGithub(app.store, { log, secrets: app.secrets, fetchImpl: app.githubFetch })); },
  },
  {
    name: 'repo-files',
    summary: 'TODO/README/CLAUDE/docs checklists of every project with a GitHub repo',
    everyMs: 30 * MIN,
    async run(app, log) { return reportLine(await syncGithubRepoFiles(app.store, { log, secrets: app.secrets, fetchImpl: app.githubFetch })); },
  },
  {
    name: 'rules',
    summary: 'Evaluate enabled rules against new events and schedules',
    everyMs: 1 * MIN,
    async run(app) {
      const r = runRules(app.store, { today: app.today() });
      if (r.errors.length) throw new Error(r.errors.map((e) => `${e.ruleId}: ${e.message}`).join('; '));
      return `rules: ${r.fired.length} fired`;
    },
  },
  {
    name: 'digest',
    summary: 'Write the daily digest to data/digests',
    dailyAt: process.env.CC_DIGEST_AT ?? '07:30',
    async run(app) {
      const digest = buildDigest(app.store, { today: app.today() });
      const file = join(dirname(app.config.dbPath), 'digests', `${digest.date}.md`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, digest.markdown, 'utf8');
      markDigestDelivered(app.store, new Date().toISOString());
      return `digest: wrote ${file}`;
    },
  },
  {
    name: 'backup',
    summary: 'Copy the database to data/backups (or CC_BACKUP_DIR), keeping the newest CC_BACKUP_KEEP. Encrypted once `backup encrypt` has set a passphrase.',
    dailyAt: process.env.CC_BACKUP_AT ?? '03:15',
    catchUp: true,
    async run(app) {
      const dir = backupDir(app.config.dbPath);
      if (!dir) throw new SkippedError('an in-memory database has nowhere to be backed up to; set CC_BACKUP_DIR');
      const keep = process.env.CC_BACKUP_KEEP ? Number(process.env.CC_BACKUP_KEEP) : DEFAULT_BACKUP_KEEP;
      // Set by `cc backup encrypt`. With none, the copy is a plain SQLite file.
      const passphrase = await (app.secrets ?? defaultSecretStore()).get(BACKUP_PASSPHRASE_KEY);
      // Encryption is on the moment a passphrase is stored. One that cannot be used is a failed
      // backup, never a readable one written as if encryption were off.
      if (passphrase !== undefined && passphraseProblem(passphrase)) {
        throw new Error(`backup: the stored passphrase cannot be used (${passphraseProblem(passphrase)}) and no backup was written. Set another with backup encrypt --replace.`);
      }
      const { file, removed } = backupDatabase(app.store, dir, app.today(), keep, new Date(), { passphrase });
      return `backup: wrote ${file}${passphrase ? ' (encrypted)' : ''}${removed.length ? `, removed ${removed.length} old` : ''}`;
    },
  },
];

const DAY_MS = 24 * 60 * MIN;

/** Whether the daemon's startup pass should run this job: every interval job, and a `catchUp` daily job that is overdue. */
export function dueAtStartup(app: App, job: JobDefinition, now: Date = new Date()): boolean {
  if (!job.dailyAt) return true;
  if (!job.catchUp) return false;
  const last = app.store.getKv<string>(`sync.${job.name}.lastAt`);
  return !last || now.getTime() - Date.parse(last) > DAY_MS;
}

export interface JobOutcome { name: string; ok: boolean; skipped: boolean; message: string; ms: number }

/** Run one job with bookkeeping. Never throws. */
export async function runJob(app: App, job: JobDefinition, log: (line: string) => void = () => {}): Promise<JobOutcome> {
  const started = Date.now();
  try {
    const message = await job.run(app, log);
    app.store.setKv(`sync.${job.name}.lastAt`, new Date().toISOString());
    app.store.setKv(`sync.${job.name}.lastError`, null);
    return { name: job.name, ok: true, skipped: false, message, ms: Date.now() - started };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const skipped = e instanceof SkippedError;
    app.store.setKv(`sync.${job.name}.lastError`, skipped ? null : (message.slice(0, 2000) as Json));
    return { name: job.name, ok: skipped, skipped, message: skipped ? `${job.name}: skipped (${message})` : `${job.name}: FAILED ${message}`, ms: Date.now() - started };
  }
}

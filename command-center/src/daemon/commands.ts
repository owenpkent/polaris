import { randomBytes } from 'node:crypto';
import { basename, resolve } from 'node:path';
import type { Command, CommandContext } from '../cli-types.ts';
import { defaultSecretStore } from '../ingest/secrets.ts';
import { readSecret } from '../prompt.ts';
import { BackupDecryptError, decryptFile, ENCRYPTED_SUFFIX, isEncryptedBackup, MIN_PASSPHRASE_LENGTH, passphraseProblem } from './backupCrypto.ts';
import { parseFlags } from '../cli-types.ts';
import { warnIfNotLoopback } from '../http/commands.ts';
import { JOBS, runJob } from './jobs.ts';
import { runDaemon } from './daemon.ts';
import { existsSync } from 'node:fs';
import { loadConfig } from '../config.ts';
import { BACKUP_PASSPHRASE_KEY, backupDir, inspectBackup, newestBackup, soundnessProblems } from './backup.ts';
import { inspectDatabaseFile } from '../core/index.ts';
import { MIGRATIONS } from '../core/schema.ts';

/** The jobs a `sync` runs: the named ones, or every interval job. Daily jobs (digest, backup) only run when named. */
export function jobsForSync(names: string[]): typeof JOBS {
  return names.length ? JOBS.filter((j) => names.includes(j.name)) : JOBS.filter((j) => j.dailyAt === undefined);
}

const syncCommand: Command = {
  name: 'sync',
  summary: 'Run sync jobs once (default: every job except digest and backup, which only run when named)',
  usage: 'sync [job ...]    jobs: ' + JOBS.map((j) => j.name).join(', '),
  async run(args, { openApp, stdout }) {
    const names = args.filter((a) => !a.startsWith('--'));
    const unknown = names.filter((n) => !JOBS.some((j) => j.name === n));
    if (unknown.length) throw new Error(`Unknown job(s): ${unknown.join(', ')}. Valid: ${JOBS.map((j) => j.name).join(', ')}`);
    const selected = jobsForSync(names);
    const app = openApp();
    let failed = 0;
    try {
      for (const job of selected) {
        const outcome = await runJob(app, job);
        if (!outcome.ok) failed++;
        stdout(`${outcome.message} (${(outcome.ms / 1000).toFixed(1)}s)`);
      }
    } finally { app.close(); }
    return failed ? 1 : 0;
  },
};

const jobsCommand: Command = {
  name: 'jobs',
  summary: 'List jobs with cadence, last run, and last error',
  run(_args, { openApp, stdout }) {
    const app = openApp();
    const nameWidth = Math.max(...JOBS.map((j) => j.name.length));
    try {
      for (const j of JOBS) {
        const last = app.store.getKv<string>(`sync.${j.name}.lastAt`) ?? 'never';
        const err = app.store.getKv<string | null>(`sync.${j.name}.lastError`);
        const cadence = j.everyMs ? `every ${j.everyMs / 60_000} min` : `daily at ${j.dailyAt}`;
        stdout(`${j.name.padEnd(nameWidth)} ${cadence.padEnd(16)} last ${last}${err ? `  ERROR ${err.split('\n')[0]}` : ''}\n${' '.repeat(nameWidth + 1)}${j.summary}`);
      }
      return 0;
    } finally { app.close(); }
  },
};

const daemonCommand: Command = {
  name: 'daemon',
  summary: 'Run every job on its schedule plus the HTTP API and MCP endpoint',
  usage: 'daemon [--no-http] [--port 8788] [--host 127.0.0.1] [--readonly-mcp] [--only job,job] [--skip job,job]',
  // The update stops and starts the daemon while its write barrier is up; the daemon refuses
  // writes itself for as long as the barrier stands (http/server.ts, mcp/server.ts).
  runsDuringUpdate: true,
  async run(args, { openApp, stdout, stderr }) {
    const f = parseFlags(args);
    const list = (v: unknown) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
    const host = typeof f.host === 'string' ? f.host : '127.0.0.1';
    if (!f['no-http']) warnIfNotLoopback(host, stderr);
    return runDaemon(openApp(), {
      http: !f['no-http'],
      port: Number(typeof f.port === 'string' ? f.port : 8788),
      host,
      readonlyMcp: Boolean(f['readonly-mcp']),
      only: list(f.only),
      skip: list(f.skip),
      stdout,
      stderr,
    });
  },
};

/** Run `fn` with the passphrase an encrypted backup needs: the stored one, and if there is none or
 *  it does not open this file (it was made under an earlier passphrase), one typed in. A plain
 *  backup runs `fn` with nothing and nobody is asked. */
async function withPassphrase<T>(file: string, ctx: CommandContext, fn: (passphrase?: string) => T): Promise<T> {
  if (!isEncryptedBackup(file)) return fn();
  const stored = await (ctx.secrets ?? defaultSecretStore()).get(BACKUP_PASSPHRASE_KEY);
  if (stored) {
    try { return fn(stored); } catch (e) { if (!(e instanceof BackupDecryptError)) throw e; }
  }
  const ask = ctx.readSecret ?? readSecret;
  return fn(await ask(stored ? 'The stored passphrase does not open this backup. Passphrase it was made with: ' : 'Backup passphrase: '));
}

function madePassphrase(): string {
  // 18 random bytes are 144 bits. Groups of four are easier to read back and to type.
  return randomBytes(18).toString('base64url').match(/.{4}/g)!.join('-');
}

const backupEncryptCommand: Command = {
  name: 'backup encrypt',
  summary: 'Turn backup encryption on by setting a passphrase, or off with --off. --status says which. The passphrase is kept in the secret store, never in the database or an environment variable.',
  usage: 'backup encrypt [--status | --off | --replace]',
  async run(args, ctx) {
    const { stdout, stderr } = ctx;
    const flags = parseFlags(args);
    const secrets = ctx.secrets ?? defaultSecretStore();
    const current = await secrets.get(BACKUP_PASSPHRASE_KEY);

    if (flags.status) { stdout(current ? 'Backup encryption is on.' : 'Backup encryption is off: backups are plain SQLite files.'); return 0; }
    if (flags.off) {
      if (!current) { stdout('Backup encryption is already off.'); return 0; }
      await secrets.delete(BACKUP_PASSPHRASE_KEY);
      stdout('Backup encryption is off. New backups will be plain SQLite files.');
      stdout('Backups already encrypted still need their passphrase: keep it for as long as you keep them.');
      return 0;
    }
    if (current && !flags.replace) {
      stderr('Backup encryption is already on. To change the passphrase run this again with --replace.');
      stderr('Backups made so far will still need the old passphrase.');
      return 1;
    }

    const ask = ctx.readSecret ?? readSecret;
    let passphrase = await ask(`Passphrase (${MIN_PASSPHRASE_LENGTH} or more characters, or leave empty and one is made for you): `);
    if (passphrase === '') {
      passphrase = madePassphrase();
      stdout('');
      stdout(`  ${passphrase}`);
      stdout('');
      stdout('That is the passphrase. It is shown this once and cannot be recovered from the backups.');
    } else {
      const problem = passphraseProblem(passphrase);
      if (problem) { stderr(`${problem} Or leave it empty to have one made.`); return 1; }
      if (await ask('The same passphrase again: ') !== passphrase) { stderr('The two did not match. Nothing was changed.'); return 1; }
    }
    await secrets.set(BACKUP_PASSPHRASE_KEY, passphrase);
    stdout('Backup encryption is on. Save the passphrase in your password manager now:');
    stdout('without it no encrypted backup can ever be read, on this machine or any other.');
    if (current) stdout('Backups made before now still need the old passphrase. Keep both until the old ones have aged out.');
    stdout('Make the first encrypted backup with: npm run cc -- sync backup');
    return 0;
  },
};

const backupDecryptCommand: Command = {
  name: 'backup decrypt',
  summary: 'Turn an encrypted backup back into a SQLite file, to restore from it. Writes to the current folder unless told where. Never overwrites.',
  usage: 'backup decrypt <file.db.enc> [output.db]',
  async run(args, ctx) {
    const { stdout, stderr } = ctx;
    const [file, outArg] = args.filter((a) => !a.startsWith('--'));
    if (!file) { stderr('Name the backup to decrypt: backup decrypt <file.db.enc> [output.db]'); return 1; }
    if (!isEncryptedBackup(file)) { stderr(`${file} is not an encrypted Polaris backup. A plain .db backup needs no decrypting.`); return 1; }
    const bare = basename(file).endsWith(ENCRYPTED_SUFFIX) ? basename(file).slice(0, -ENCRYPTED_SUFFIX.length) : `${basename(file)}.db`;
    const out = resolve(outArg ?? bare);
    if (existsSync(out)) { stderr(`${out} already exists. Name another output file, or move that one first.`); return 1; }
    try {
      await withPassphrase(file, ctx, (passphrase) => decryptFile(file, out, passphrase!));
    } catch (e) {
      stderr(e instanceof Error ? e.message : String(e));
      return 1;
    }
    const problems = soundnessProblems(inspectDatabaseFile(out));
    for (const p of problems) stderr(`  PROBLEM ${p}`);
    stdout(`Wrote ${out}`);
    stdout('That file is readable by anyone who can open it. To restore: stop the daemon, put it where CC_DB points, start the daemon. Delete any copy you do not need.');
    return problems.length ? 1 : 0;
  },
};

// The restore drill. It must work on a recovery host, where the live database may be missing,
// empty, or the very thing that broke: so it never opens the store (which would create and migrate
// one), and the backup is judged on its own. The live database is described when it can be read,
// for comparison only.
const backupCheckCommand: Command = {
  name: 'backup check',
  summary: 'Prove a backup can be read back: passphrase (if encrypted), integrity, foreign keys, schema version. Checks the newest one unless a file is named. Reads only.',
  usage: 'backup check [file]',
  async run(args, ctx) {
    const { config, stdout, stderr } = ctx;
    const { dbPath } = (config ?? loadConfig)();
    const dir = backupDir(dbPath);
    const file = args.find((a) => !a.startsWith('--')) ?? (dir && newestBackup(dir));
    if (!file) { stderr(`No backup found${dir ? ` in ${dir}` : ''}. Run \`npm run cc -- sync backup\` first.`); return 1; }
    stdout(file);

    let found;
    try {
      found = await withPassphrase(file, ctx, (passphrase) => inspectBackup(file, passphrase));
      if (isEncryptedBackup(file)) stdout('  encrypted, and the passphrase opens it');
    } catch (e) {
      stderr(`  PROBLEM cannot be opened (${e instanceof Error ? e.message : String(e)})`);
      stdout('  This backup should not be trusted.');
      return 1;
    }
    const problems = soundnessProblems(found);
    // An earlier schema is fine: opening the restored file migrates it. A later one this code cannot run.
    if (found.schemaVersion > MIGRATIONS.length) problems.push(`schema version ${found.schemaVersion} is newer than this code supports (${MIGRATIONS.length})`);
    stdout(`  schema ${found.schemaVersion} (this code: ${MIGRATIONS.length}); tasks ${found.counts.tasks}; projects ${found.counts.projects}; events ${found.counts.events}`);

    if (dbPath !== ':memory:') {
      if (!existsSync(dbPath)) stdout(`  live database: none at ${dbPath}`);
      else {
        try {
          const live = inspectDatabaseFile(dbPath);
          stdout(`  live database: schema ${live.schemaVersion}; tasks ${live.counts.tasks}; projects ${live.counts.projects}; events ${live.counts.events}`);
        } catch (e) {
          stdout(`  live database: could not be read (${e instanceof Error ? e.message : String(e)})`);
        }
      }
    }

    for (const p of problems) stderr(`  PROBLEM ${p}`);
    stdout(problems.length ? '  This backup should not be trusted.' : '  ok: this backup can be restored.');
    return problems.length ? 1 : 0;
  },
};

export const commands: Command[] = [syncCommand, jobsCommand, daemonCommand, backupCheckCommand, backupEncryptCommand, backupDecryptCommand];

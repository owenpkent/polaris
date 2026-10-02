// Backup settings for the dashboard. A passphrase can be sent to the server and can never be read
// back: no route here returns it, echoes it in an error, or logs it. One made for the owner is made
// in the browser, which has to show it to them anyway, so the server never has a reason to send one.
// These are REST routes only. There is no MCP tool for any of this: an agent must not be able to
// turn encryption off, or set a passphrase the owner does not have.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { z } from 'zod';
import type { App } from '../app.ts';
import { MIGRATIONS } from '../core/schema.ts';
import { BACKUP_PASSPHRASE_KEY, DEFAULT_BACKUP_KEEP, backupDir, inspectBackup, newestBackup, soundnessProblems } from '../daemon/backup.ts';
import { BackupDecryptError, ENCRYPTED_SUFFIX, MIN_PASSPHRASE_LENGTH, isEncryptedBackup, passphraseProblem } from '../daemon/backupCrypto.ts';
import { defaultSecretStore } from '../ingest/secrets.ts';
import { HttpError, sendJson } from './errors.ts';
import type { Router } from './router.ts';
import { parseBody } from './schemas.ts';
import type { HttpServerOptions } from './types.ts';

const DATED_BACKUP = /^constellation-\d{4}-\d{2}-\d{2}\.db(\.enc)?$/;

const encryptionBodySchema = z.object({
  passphrase: z.string().max(1024).refine((p) => passphraseProblem(p) === null, { message: passphraseProblem('') ?? 'too short' }),
  /** Must be true to change a passphrase that is already set. */
  replace: z.boolean().optional(),
}).strict();

export function registerBackupRoutes(router: Router, app: App, opts: HttpServerOptions): void {
  const secrets = () => app.secrets ?? defaultSecretStore();
  const folder = () => backupDir(app.config.dbPath);

  async function status() {
    const dir = folder();
    const names = dir && existsSync(dir) ? readdirSync(dir).filter((name) => DATED_BACKUP.test(name)).sort() : [];
    const newest = dir ? newestBackup(dir) : undefined;
    const job = opts.getJobStatus?.().backup ?? null;
    return {
      encryption: await secrets().has(BACKUP_PASSPHRASE_KEY),
      folder: dir ?? null,
      keep: process.env.CC_BACKUP_KEEP ? Number(process.env.CC_BACKUP_KEEP) : DEFAULT_BACKUP_KEEP,
      copies: names.length,
      /** Readable copies still in the folder. After encryption is turned on they age out one a day. */
      plainCopies: names.filter((name) => !name.endsWith(ENCRYPTED_SUFFIX)).length,
      newest: newest ? { name: names.at(-1)!, encrypted: isEncryptedBackup(newest), bytes: statSync(newest).size, modifiedAt: statSync(newest).mtime.toISOString() } : null,
      /** Null when this server runs no jobs (`serve`), so the dashboard can say so and hide Back up now. */
      job,
      minPassphraseLength: MIN_PASSPHRASE_LENGTH,
    };
  }

  router.add('GET', '/api/backup', async (ctx) => {
    sendJson(ctx.res, 200, await status());
  });

  router.add('POST', '/api/backup/encryption', async (ctx) => {
    const body = parseBody(encryptionBodySchema, ctx.body);
    const store = secrets();
    if (body.replace) {
      await store.set(BACKUP_PASSPHRASE_KEY, body.passphrase);
    } else {
      // The check and the write are one step: of two requests at once, one turns it on and the
      // other gets a 409, so no browser reports success for a passphrase that was then overwritten.
      await store.update(BACKUP_PASSPHRASE_KEY, (current) => {
        if (current !== undefined) {
          throw new HttpError(409, 'Conflict', 'Backup encryption is already on. Send replace: true to change the passphrase. Backups made so far will still need the old one.');
        }
        return body.passphrase;
      });
    }
    sendJson(ctx.res, 200, await status());
  });

  router.add('DELETE', '/api/backup/encryption', async (ctx) => {
    await secrets().delete(BACKUP_PASSPHRASE_KEY);
    sendJson(ctx.res, 200, await status());
  });

  // The restore drill, on the newest copy, with the stored passphrase. A copy made under an earlier
  // passphrase cannot be checked from here: that needs `cc backup check`, which can ask for it.
  router.add('POST', '/api/backup/check', async (ctx) => {
    const dir = folder();
    const file = dir && newestBackup(dir);
    if (!file) { sendJson(ctx.res, 200, { checked: false, message: 'There is no backup to check yet.' }); return; }
    const name = basename(file);
    const encrypted = isEncryptedBackup(file);
    try {
      const found = inspectBackup(file, await secrets().get(BACKUP_PASSPHRASE_KEY));
      const problems = soundnessProblems(found);
      if (found.schemaVersion > MIGRATIONS.length) problems.push(`schema version ${found.schemaVersion} is newer than this code supports (${MIGRATIONS.length})`);
      sendJson(ctx.res, 200, { checked: true, ok: problems.length === 0, name, encrypted, problems, counts: found.counts, schemaVersion: found.schemaVersion });
    } catch (e) {
      const message = e instanceof BackupDecryptError || (e instanceof Error && /no passphrase was given/.test(e.message))
        ? 'The passphrase stored on this server does not open this backup. It was made under another passphrase: check it with `cc backup check`, which can ask for that one.'
        : `cannot be opened (${e instanceof Error ? e.message : String(e)})`;
      sendJson(ctx.res, 200, { checked: true, ok: false, name, encrypted, problems: [message] });
    }
  });
}

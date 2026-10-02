// A separate process for backupCommands.test.ts: runs the real `backup encrypt` command with the
// real prompt (prompt.ts) reading the real stdin, against an in-memory secret store. Reports what
// the command printed and whether a passphrase ended up stored, never the passphrase itself.
import { memorySecretStore } from '../../ingest/secrets.ts';
import { loadConfig } from '../../config.ts';
import { BACKUP_PASSPHRASE_KEY } from '../backup.ts';
import { commands } from '../commands.ts';

const secrets = memorySecretStore();
const out: string[] = [];
const err: string[] = [];
const command = commands.find((c) => c.name === 'backup encrypt')!;
// Like cli.ts: an error thrown by the command is printed and is exit code 1.
let code: number;
try {
  code = await command.run(process.argv.slice(2), {
    openApp: (): never => { throw new Error('not opened'); },
    config: () => ({ ...loadConfig({}), dbPath: ':memory:' }),
    secrets,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
  });
} catch (e) {
  err.push(e instanceof Error ? e.message : String(e));
  code = 1;
}
const stored = await secrets.get(BACKUP_PASSPHRASE_KEY);
process.stdout.write(JSON.stringify({ code, stored: stored !== undefined, storedLength: stored?.length ?? 0, out, err }));

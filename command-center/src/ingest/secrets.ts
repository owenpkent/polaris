// Where OAuth secrets live: the GitHub App credentials and the signed-in user's tokens. Never the
// database, never the repo, never a log line. Three implementations: Windows DPAPI, a 0600 file
// for every other platform, and in-memory (tests).

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { withFileLock } from '../core/fileLock.ts';
import { dirname, join } from 'node:path';
import { loadConfig } from '../config.ts';

export interface SecretStore {
  /** Whether a value is stored, without reading it. On Windows a read spawns PowerShell to decrypt; this does not. */
  has(key: string): Promise<boolean>;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Read, decide, write as one step that no other writer, in this process or another, comes
   * between. `fn` gets the stored value and returns the new one, or undefined to leave it as it
   * is; an error it throws leaves the value untouched and reaches the caller. The GitHub token
   * write needs this: a refresh that finishes after a sign-out must find out and not write.
   */
  update(key: string, fn: (current: string | undefined) => string | undefined): Promise<void>;
  /**
   * Runs `fn` while no other caller of this store, in this process or another, runs one under the
   * same name. For work that spans reads, writes, and something outside the store: a GitHub token
   * refresh reads the pair, spends the refresh token at GitHub, and saves the new pair, and two
   * processes doing that at once lose the sign-in. `fn` must finish well inside `staleMs`.
   */
  exclusive<T>(name: string, fn: () => Promise<T>, opts: ExclusiveOptions): Promise<T>;
}

export interface ExclusiveOptions {
  /** How long to wait for another holder. */
  timeoutMs: number;
  /** After this long a holder counts as dead and its lock is taken over. */
  staleMs: number;
}

const lockName = (name: string) => `exclusive-${name.replace(/[^a-zA-Z0-9_.-]/g, '_')}.lock`;

export function memorySecretStore(seed: Record<string, string> = {}): SecretStore {
  const map = new Map(Object.entries(seed));
  const queues = new Map<string, Promise<void>>();
  return {
    async has(key) { return map.has(key); },
    async get(key) { return map.get(key); },
    async set(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
    async update(key, fn) {
      const next = fn(map.get(key));
      if (next !== undefined) map.set(key, next);
    },
    async exclusive(name, fn) {
      const before = queues.get(name) ?? Promise.resolve();
      let done = () => {};
      const mine = new Promise<void>((resolve) => { done = resolve; });
      queues.set(name, before.then(() => mine));
      await before;
      try {
        return await fn();
      } finally {
        done();
      }
    },
  };
}

export interface DpapiDeps {
  baseDir?: string;
  /** Injectable for tests so no real powershell.exe is ever spawned outside this file. */
  runPowerShell?: (script: string, stdin: string) => Promise<string>;
}

// Secrets go over stdin, never argv, and cross the PowerShell boundary as base64 of their UTF-8
// bytes in both directions. That is what keeps them exact: PowerShell's console would otherwise
// re-encode them, and trimming its output would eat spaces at the ends. A backup passphrase is
// used byte for byte as a key, so a changed byte is a backup nobody can open. `$raw` is never
// interpolated into the script text itself.
const ENCRYPT_SCRIPT = [
  '$raw = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()))',
  '$secure = ConvertTo-SecureString -String $raw -AsPlainText -Force',
  'ConvertFrom-SecureString -SecureString $secure',
].join('\n');

const DECRYPT_SCRIPT = [
  '$raw = [Console]::In.ReadToEnd()',
  '$secure = ConvertTo-SecureString -String $raw',
  '$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)',
  'try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }',
  '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($plain))',
].join('\n');

/** The environment for Windows PowerShell 5.1, without PSModulePath. When this process was started
 *  from PowerShell 7 (a pwsh terminal, a GitHub Actions step), that variable points at PowerShell
 *  7's modules, 5.1 inherits it, and ConvertTo-SecureString fails with "the module could not be
 *  loaded". Without it 5.1 builds its own default. Windows variable names ignore case. */
export function windowsPowerShellEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'));
}

// A run is stopped after this long. It has taken more than 5 seconds on the CI runner.
const POWERSHELL_TIMEOUT_MS = 20_000;

// Asynchronous, because PowerShell can take seconds to start and the daemon answers every other
// request meanwhile.
function defaultRunPowerShell(script: string, stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      env: windowsPowerShellEnv(),
      timeout: POWERSHELL_TIMEOUT_MS,
    }, (e, stdout, stderr) => {
      if (!e) { resolve(stdout.trim()); return; }
      // The default message repeats the whole command line and every line PowerShell printed, and it
      // reaches the dashboard. The secret is never in it (it goes over stdin), but one line is enough.
      const firstLine = e.killed
        ? `powershell.exe did not finish within ${POWERSHELL_TIMEOUT_MS / 1000} seconds`
        : stderr.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? e.message.split('\n')[0];
      reject(new Error(`Windows could not protect or read the secret (DPAPI through powershell.exe): ${firstLine}`));
    });
    // A process that never started closes its stdin under us. The callback above reports why, and an
    // unhandled error here would stop the daemon.
    child.stdin?.on('error', () => {});
    child.stdin?.end(stdin);
  });
}

function defaultBaseDir(): string {
  const appData = process.env.APPDATA;
  return appData ? join(appData, 'constellation', 'secrets') : join(process.env.USERPROFILE ?? '.', 'AppData', 'Roaming', 'constellation', 'secrets');
}

/** DPAPI-CurrentUser encryption via powershell.exe. Ciphertext on disk, plaintext only ever
 *  passed over stdin to a fixed script -- never on a command line, never logged. */
export function windowsDpapiSecretStore(deps: DpapiDeps = {}): SecretStore {
  const dir = deps.baseDir ?? defaultBaseDir();
  const run = deps.runPowerShell ?? defaultRunPowerShell;
  const fileFor = (key: string) => join(dir, `${key.replace(/[^a-zA-Z0-9_.-]/g, '_')}.bin`);
  const get = async (key: string): Promise<string | undefined> => {
    const file = fileFor(key);
    if (!existsSync(file)) return undefined;
    const ciphertext = readFileSync(file, 'utf8');
    return Buffer.from((await run(DECRYPT_SCRIPT, ciphertext)).trim(), 'base64').toString('utf8');
  };
  const encrypt = async (key: string, value: string): Promise<string> => {
    // DPAPI refuses an empty string, and no caller has a reason to store one.
    if (value === '') throw new Error(`Refusing to store an empty value for secret '${key}'.`);
    return run(ENCRYPT_SCRIPT, Buffer.from(value, 'utf8').toString('base64'));
  };
  // Every change holds its key's lock: one ciphertext file per key, so one lock per key. PowerShell
  // runs while this process goes on with other work, so without the lock a delete or a second write
  // in this process could land between an update's read and its write, and the daemon and a CLI
  // command are separate processes besides. A change runs PowerShell at most twice and each run is
  // stopped after 20 seconds, so a live holder is done well inside the minute after which its lock
  // counts as stale. `write` still checks that the lock is its own: one taken over writes nothing.
  const locked = async (key: string, fn: (write: (commit: () => void) => void) => Promise<void>): Promise<void> => {
    mkdirSync(dir, { recursive: true });
    await withFileLock(`${fileFor(key)}.lock`, (lock) => fn((commit) => {
      if (!lock.held()) throw new Error(`Secret '${key}' was not changed: it took so long that another change went ahead. Try again.`);
      commit();
    }), { what: `Secret '${key}'`, staleMs: 60_000, timeoutMs: 60_000 });
  };
  return {
    async has(key) { return existsSync(fileFor(key)); },
    get,
    async set(key, value) {
      await locked(key, async (write) => {
        const ciphertext = await encrypt(key, value);
        write(() => writeFileSync(fileFor(key), ciphertext, 'utf8'));
      });
    },
    async delete(key) {
      await locked(key, async (write) => write(() => {
        const file = fileFor(key);
        if (existsSync(file)) unlinkSync(file);
      }));
    },
    async update(key, fn) {
      await locked(key, async (write) => {
        const next = fn(await get(key));
        if (next === undefined) return;
        const ciphertext = await encrypt(key, next);
        write(() => writeFileSync(fileFor(key), ciphertext, 'utf8'));
      });
    },
    async exclusive(name, fn, opts) {
      mkdirSync(dir, { recursive: true });
      return withFileLock(join(dir, lockName(name)), () => fn(), { ...opts, what: `The ${name} lock` });
    },
  };
}

export interface FileStoreDeps {
  /** Injectable for tests. Permission bits are only checked where they mean something. */
  platform?: NodeJS.Platform;
  /** How long a writer waits for another process's lock before giving up. */
  lockTimeoutMs?: number;
}

/** Rename over `to`. On Windows that fails for a moment while a reader (a `get` in another process,
 *  a virus scanner) has the target open, so try again briefly before giving up. */
function publish(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try { renameSync(from, to); return; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 50 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

/** Plaintext JSON in one file, readable by its owner only: the protection the `gh` CLI gives its
 *  token on Linux. Disk encryption is the host's job. Like ssh, it refuses a file that group or
 *  others can read, so a bad copy or restore fails loudly and never quietly.
 *
 *  The daemon and a CLI command are separate processes writing the same file (a token refresh can
 *  overlap a sign-in), so every change is one load, modify, save under a lock file, and each
 *  writer stages into a file of its own. */
export function fileSecretStore(file: string, deps: FileStoreDeps = {}): SecretStore {
  const posix = (deps.platform ?? process.platform) !== 'win32';
  const lockFile = `${file}.lock`;
  const lockTimeoutMs = deps.lockTimeoutMs ?? 15_000;

  const load = (): Record<string, string> => {
    if (!existsSync(file)) return {};
    if (posix && (statSync(file).mode & 0o077) !== 0) {
      throw new Error(`Secret file ${file} can be read by other users. Run: chmod 600 ${file}`);
    }
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
  };

  const save = (all: Record<string, string>): void => {
    // 'wx' fails if the name is taken, and the mode applies from creation, so the secret bytes
    // never sit in a file others could read. Only this writer's own staging file is ever removed.
    const staging = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.partial`;
    try {
      writeFileSync(staging, JSON.stringify(all), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      publish(staging, file);
    } catch (e) {
      try { unlinkSync(staging); } catch { /* never created, or already renamed */ }
      throw e;
    }
  };

  const withLock = <T,>(fn: () => T) => withFileLock(lockFile, fn, { timeoutMs: lockTimeoutMs, what: `Secret file ${file}` });

  return {
    async has(key) { return key in load(); },
    async get(key) { return load()[key]; },
    async set(key, value) { await withLock(() => save({ ...load(), [key]: value })); },
    async delete(key) {
      await withLock(() => {
        const all = load();
        if (!(key in all)) return;
        delete all[key];
        save(all);
      });
    },
    async update(key, fn) {
      await withLock(() => {
        const all = load();
        const next = fn(all[key]);
        if (next !== undefined) save({ ...all, [key]: next });
      });
    },
    async exclusive(name, fn, opts) {
      return withFileLock(join(dirname(file), lockName(name)), () => fn(), { ...opts, what: `The ${name} lock` });
    },
  };
}

/** One process-wide store: real callers all share it, so a GitHub token refresh in flight against
 *  one instance is visible to every other caller (see github/auth.ts). */
let cachedDefaultSecretStore: SecretStore | undefined;

/** Windows DPAPI on Windows, a 0600 file next to the database everywhere else. There is no env var
 *  store: the GitHub App's refresh token rotates, so the store has to be writable. */
export function defaultSecretStore(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): SecretStore {
  if (!cachedDefaultSecretStore) {
    // CC_SECRETS_DIR moves the store. On Windows it otherwise belongs to the user, not to a
    // database, so a scratch server (the UI tests, the mockup) would read and write the real one.
    cachedDefaultSecretStore = platform === 'win32'
      ? windowsDpapiSecretStore(env.CC_SECRETS_DIR ? { baseDir: env.CC_SECRETS_DIR } : {})
      : fileSecretStore(join(env.CC_SECRETS_DIR ?? dirname(loadConfig(env).dbPath), 'secrets.json'), { platform });
  }
  return cachedDefaultSecretStore;
}

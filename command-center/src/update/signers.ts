// The keys allowed to sign a release (docs/update-proposal.md, section 2). The committed file,
// `release-signers` at the repo root, is in OpenSSH allowed_signers format: one key per line as
// `<principal> namespaces="git" <keytype> <key>`, with `#` comments. `cc update` never verifies
// against the committed file: on first use it copies the file to `data/release-signers`, beside
// the database, and verifies against that pinned copy from then on. A commit that changes the
// committed file widens nothing until the owner has seen both and run `cc update --trust-signers`,
// which is the only thing that replaces the pinned copy.
//
// Nothing here runs a program except ssh-keygen for a fingerprint, through the Exec seam.
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Exec } from './exec.ts';

export const RELEASE_SIGNERS_FILE = 'release-signers';

export interface Signer {
  /** The principal(s) the line names, as written (comma-separated when several). */
  principal: string;
  /** The options between the principal and the key, e.g. `namespaces="git"`. */
  options: string[];
  keyType: string;
  /** The base64 key material. */
  key: string;
  comment: string;
}

export class SignersError extends Error {}

const KEY_TYPE_RE = /^(ssh-|ecdsa-|sk-)/;

export function committedSignersPath(repoRoot: string): string {
  return join(repoRoot, RELEASE_SIGNERS_FILE);
}

/** The pinned copy lives next to the database, like the token files and the status file. */
export function pinnedSignersPath(dbPath: string): string {
  return join(dirname(dbPath), RELEASE_SIGNERS_FILE);
}

/** The keys in an allowed_signers text. Blank lines and `#` comments are skipped. A line that
 *  has no key on it is an error: a file ssh-keygen could not read must not pass as "no keys". */
export function parseAllowedSigners(text: string): Signer[] {
  const signers: Signer[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const tokens = line.split(/\s+/);
    const at = tokens.findIndex((t, n) => n > 0 && KEY_TYPE_RE.test(t));
    if (at < 1 || at + 1 >= tokens.length) throw new SignersError(`line ${i + 1} of the signers file is not "<principal> [options] <keytype> <key>"`);
    signers.push({
      principal: tokens[0],
      options: tokens.slice(1, at),
      keyType: tokens[at],
      key: tokens[at + 1],
      comment: tokens.slice(at + 2).join(' '),
    });
  }
  return signers;
}

/** One line that identifies a key, for comparing two files: the comment is not part of it. */
export function signerIdentity(s: Signer): string {
  return `${s.principal} ${[...s.options].sort().join(',')} ${s.keyType} ${s.key}`;
}

/** Whether two signers lists allow the same keys for the same principals. */
export function sameSigners(a: Signer[], b: Signer[]): boolean {
  const ids = (list: Signer[]) => [...new Set(list.map(signerIdentity))].sort().join('\n');
  return ids(a) === ids(b);
}

export interface SignersFile {
  text: string;
  signers: Signer[];
}

/** Read and parse a signers file. On POSIX a file that group or others can write is refused, as
 *  the secret store refuses one they can read: a key list another account can edit decides what
 *  code runs here. */
export function readSignersFile(file: string, platform: NodeJS.Platform = process.platform): SignersFile {
  if (platform !== 'win32' && (statSync(file).mode & 0o022) !== 0) {
    throw new SignersError(`${file} can be written by other users. Run: chmod 600 ${file}`);
  }
  const text = readFileSync(file, 'utf8');
  return { text, signers: parseAllowedSigners(text) };
}

/** Copy the committed file over the pinned one, owner-only, through a staging file and a rename so
 *  no reader sees a torn copy. Returns the keys now pinned. */
export function pinSigners(committedFile: string, pinnedFile: string): Signer[] {
  const text = readFileSync(committedFile, 'utf8');
  const signers = parseAllowedSigners(text);
  const staging = `${pinnedFile}.${process.pid}.partial`;
  try {
    writeFileSync(staging, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(staging, pinnedFile);
  } catch (e) {
    try { unlinkSync(staging); } catch { /* never created, or already renamed */ }
    throw e;
  }
  return signers;
}

/** The key's SHA256 fingerprint from `ssh-keygen -lf`, or a note saying why there is none. The
 *  key goes through a temp file because ssh-keygen reads a file, never an argument. */
export async function keyFingerprint(exec: Exec, signer: Signer): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'cc-signer-'));
  try {
    const file = join(dir, 'key.pub');
    writeFileSync(file, `${signer.keyType} ${signer.key}\n`, { mode: 0o600 });
    const r = await exec('ssh-keygen', ['-lf', file]);
    const m = /SHA256:[A-Za-z0-9+/=]+/.exec(r.stdout);
    if (r.code === 0 && m) return m[0];
    return r.code === -1 ? '(ssh-keygen is not installed)' : `(no fingerprint: ${(r.stderr || r.stdout).trim().split('\n').pop() ?? 'ssh-keygen failed'})`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The lines `--trust-signers` shows for a list of keys: principal, key type, fingerprint. */
export async function describeSigners(exec: Exec, signers: Signer[]): Promise<string[]> {
  if (!signers.length) return ['  (no keys)'];
  const lines: string[] = [];
  for (const s of signers) lines.push(`  ${s.principal}  ${s.keyType}  ${await keyFingerprint(exec, s)}`);
  return lines;
}

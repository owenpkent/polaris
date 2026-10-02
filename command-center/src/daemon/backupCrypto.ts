// Encryption for backup files that leave the machine (a NAS, a synced folder, a bucket). Built on
// node:crypto only: scrypt turns the passphrase into a key, ChaCha20-Poly1305 encrypts and
// authenticates. A wrong passphrase, a truncated file, and a flipped bit all fail the same way, at
// the tag, and nothing is written when they do.
//
// File format, so a backup can be read without this code:
//   bytes 0-3    "CCBK"
//   byte  4      format version, 1
//   byte  5      scrypt log2(N)
//   byte  6      scrypt r
//   byte  7      scrypt p
//   bytes 8-23   scrypt salt (16)
//   bytes 24-35  nonce (12)
//   ...          ciphertext of the SQLite file
//   last 16      Poly1305 tag
// The key is scrypt(passphrase as UTF-8 NFKC, salt, N, r, p) at 32 bytes. Bytes 0-35 are the
// additional authenticated data, so the parameters cannot be changed without failing the tag.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';

const MAGIC = Buffer.from('CCBK', 'latin1');
const VERSION = 1;
const HEADER_BYTES = 36;
const TAG_BYTES = 16;
/** 2^17 with r=8 is the OWASP scrypt recommendation: about 128 MB and a fraction of a second, once a day. */
export const DEFAULT_LOG_N = 17;
/** A crafted header must not be able to ask for gigabytes. 2^20 with r=8 is about 1 GB. */
const MAX_LOG_N = 20;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

export const ENCRYPTED_SUFFIX = '.enc';
export const MIN_PASSPHRASE_LENGTH = 12;

/** Why a passphrase cannot be used, or null. The same rule in the CLI, the API, the dashboard, and
 *  the job, so nothing accepts a passphrase that another part will not encrypt with. Spaces at the
 *  ends count as bytes of the key but not towards the length: twelve of them are not a passphrase. */
export function passphraseProblem(passphrase: string): string | null {
  if (passphrase.trim().length < MIN_PASSPHRASE_LENGTH) {
    return `Use ${MIN_PASSPHRASE_LENGTH} or more characters, not counting spaces at the ends.`;
  }
  return null;
}

export class BackupDecryptError extends Error {}

function deriveKey(passphrase: string, salt: Buffer, logN: number, r: number, p: number): Buffer {
  const N = 2 ** logN;
  return scryptSync(Buffer.from(passphrase.normalize('NFKC'), 'utf8'), salt, 32, { N, r, p, maxmem: 256 * N * r });
}

export interface EncryptOptions {
  /** Tests lower this so they take milliseconds. The value is stored in the file, so decrypting needs no option. */
  logN?: number;
}

/** Encrypt `source` into `dest`. `dest` must not exist: the caller owns staging and publication. */
export function encryptFile(source: string, dest: string, passphrase: string, opts: EncryptOptions = {}): void {
  if (!passphrase) throw new Error('backup: cannot encrypt with an empty passphrase');
  const logN = opts.logN ?? DEFAULT_LOG_N;
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION, logN, SCRYPT_R, SCRYPT_P]), salt, nonce]);
  const cipher = createCipheriv('chacha20-poly1305', deriveKey(passphrase, salt, logN, SCRYPT_R, SCRYPT_P), nonce, { authTagLength: TAG_BYTES });
  const plain = readFileSync(source);
  cipher.setAAD(header, { plaintextLength: plain.length });
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  writeFileSync(dest, Buffer.concat([header, body, cipher.getAuthTag()]), { flag: 'wx', mode: 0o600 });
}

/** The decrypted bytes. Throws BackupDecryptError for a file that is not an encrypted backup, and for a wrong passphrase or a damaged file, which cannot be told apart. */
export function decryptBuffer(file: string, passphrase: string): Buffer {
  const all = readFileSync(file);
  if (all.length < HEADER_BYTES + TAG_BYTES || !all.subarray(0, 4).equals(MAGIC)) throw new BackupDecryptError(`${file} is not an encrypted Polaris backup`);
  const [version, logN, r, p] = all.subarray(4, 8);
  if (version !== VERSION) throw new BackupDecryptError(`${file} uses backup format ${version}, and this code reads format ${VERSION}`);
  if (logN < 10 || logN > MAX_LOG_N || r !== SCRYPT_R || p !== SCRYPT_P) throw new BackupDecryptError(`${file} has key settings this code will not run`);
  const header = all.subarray(0, HEADER_BYTES);
  const decipher = createDecipheriv('chacha20-poly1305', deriveKey(passphrase, all.subarray(8, 24), logN, r, p), all.subarray(24, 36), { authTagLength: TAG_BYTES });
  decipher.setAAD(header, { plaintextLength: all.length - HEADER_BYTES - TAG_BYTES });
  decipher.setAuthTag(all.subarray(all.length - TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(all.subarray(HEADER_BYTES, all.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw new BackupDecryptError(`${file} could not be decrypted: the passphrase is wrong, or the file is damaged`);
  }
}

/** Decrypt `file` into `dest`, which must not exist. Nothing is written unless the whole file authenticates. */
export function decryptFile(file: string, dest: string, passphrase: string): void {
  writeFileSync(dest, decryptBuffer(file, passphrase), { flag: 'wx', mode: 0o600 });
}

/** By content, not by name: a renamed file is still what it is. False for a missing or unreadable file. */
export function isEncryptedBackup(file: string): boolean {
  let fd;
  try {
    fd = openSync(file, 'r');
    const head = Buffer.alloc(4);
    return readSync(fd, head, 0, 4, 0) === 4 && head.equals(MAGIC);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

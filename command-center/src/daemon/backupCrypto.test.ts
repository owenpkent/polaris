import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupDecryptError, DEFAULT_LOG_N, decryptBuffer, decryptFile, encryptFile, isEncryptedBackup } from './backupCrypto.ts';

// A low scrypt cost keeps these fast. The cost is read back from the file, so decrypting is the real path.
const FAST = { logN: 10 };
const PASS = 'correct horse battery staple';

function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'cc-crypto-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function encrypted(dir: string, content: Buffer | string = 'SQLite format 3\0 and then the rest of a database'): { plain: string; enc: string } {
  const plain = join(dir, 'plain.db');
  const enc = join(dir, 'plain.db.enc');
  writeFileSync(plain, content);
  encryptFile(plain, enc, PASS, FAST);
  return { plain, enc };
}

test('round trip: what comes out is byte for byte what went in, including an empty file', (t) => {
  const dir = tempDir(t);
  const { plain, enc } = encrypted(dir);
  assert.deepEqual(decryptBuffer(enc, PASS), readFileSync(plain));
  const out = join(dir, 'out.db');
  decryptFile(enc, out, PASS);
  assert.deepEqual(readFileSync(out), readFileSync(plain));

  const empty = join(dir, 'empty');
  writeFileSync(empty, '');
  encryptFile(empty, `${empty}.enc`, PASS, FAST);
  assert.equal(decryptBuffer(`${empty}.enc`, PASS).length, 0);
});

test('the encrypted file holds none of the plaintext, and two encryptions of one file differ', (t) => {
  const dir = tempDir(t);
  const { plain, enc } = encrypted(dir, 'a task title nobody else should read '.repeat(20));
  assert.equal(readFileSync(enc).includes('task title'), false);
  const again = join(dir, 'again.enc');
  encryptFile(plain, again, PASS, FAST);
  assert.notDeepEqual(readFileSync(again), readFileSync(enc), 'a fresh salt and nonce every time');
});

test('a wrong passphrase fails, says so, and writes nothing', (t) => {
  const dir = tempDir(t);
  const { enc } = encrypted(dir);
  const out = join(dir, 'out.db');
  assert.throws(() => decryptFile(enc, out, 'not the passphrase'), (e: unknown) => e instanceof BackupDecryptError && /passphrase is wrong, or the file is damaged/.test(e.message));
  assert.equal(existsSync(out), false);
});

test('a flipped bit anywhere fails: in the ciphertext, in the tag, in the salt, and in the cost setting', (t) => {
  const dir = tempDir(t);
  const { enc } = encrypted(dir);
  const good = readFileSync(enc);
  for (const at of [5, 10, 30, 40, good.length - 1]) {
    const bad = Buffer.from(good);
    bad[at] ^= 0x01;
    const file = join(dir, `bad-${at}.enc`);
    writeFileSync(file, bad);
    assert.throws(() => decryptBuffer(file, PASS), BackupDecryptError, `byte ${at}`);
  }
});

test('a truncated file fails', (t) => {
  const dir = tempDir(t);
  const { enc } = encrypted(dir);
  const good = readFileSync(enc);
  const short = join(dir, 'short.enc');
  writeFileSync(short, good.subarray(0, good.length - 7));
  assert.throws(() => decryptBuffer(short, PASS), BackupDecryptError);
  writeFileSync(short, good.subarray(0, 20));
  assert.throws(() => decryptBuffer(short, PASS), /not an encrypted Polaris backup/);
});

test('a header asking for an enormous key cost is refused before any work is done', (t) => {
  const dir = tempDir(t);
  const { enc } = encrypted(dir);
  const bad = Buffer.from(readFileSync(enc));
  bad[5] = 30;
  const file = join(dir, 'greedy.enc');
  writeFileSync(file, bad);
  assert.throws(() => decryptBuffer(file, PASS), /key settings this code will not run/);
});

test('a plain database, and a newer format, are told apart from a wrong passphrase', (t) => {
  const dir = tempDir(t);
  const { plain, enc } = encrypted(dir);
  assert.throws(() => decryptBuffer(plain, PASS), /not an encrypted Polaris backup/);
  const newer = Buffer.from(readFileSync(enc));
  newer[4] = 2;
  const file = join(dir, 'newer.enc');
  writeFileSync(file, newer);
  assert.throws(() => decryptBuffer(file, PASS), /uses backup format 2/);
});

test('encryptFile and decryptFile never overwrite, and an empty passphrase is refused', (t) => {
  const dir = tempDir(t);
  const { plain, enc } = encrypted(dir);
  assert.throws(() => encryptFile(plain, enc, PASS, FAST), /EEXIST/);
  assert.throws(() => decryptFile(enc, plain, PASS), /EEXIST/);
  assert.throws(() => encryptFile(plain, join(dir, 'x.enc'), '', FAST), /empty passphrase/);
});

test('the same passphrase typed in a different Unicode form still opens the file', (t) => {
  const dir = tempDir(t);
  const plain = join(dir, 'p.db');
  writeFileSync(plain, 'data');
  encryptFile(plain, join(dir, 'p.enc'), 'café au lait, s’il vous plaît', FAST);
  assert.equal(decryptBuffer(join(dir, 'p.enc'), 'café au lait, s’il vous plaît').toString(), 'data');
});

test('isEncryptedBackup goes by content, not by name', (t) => {
  const dir = tempDir(t);
  const { plain, enc } = encrypted(dir);
  assert.equal(isEncryptedBackup(enc), true);
  assert.equal(isEncryptedBackup(plain), false);
  assert.equal(isEncryptedBackup(join(dir, 'missing')), false);
  writeFileSync(join(dir, 'tiny'), 'CC');
  assert.equal(isEncryptedBackup(join(dir, 'tiny')), false);
});

test('the real key cost works on this machine', (t) => {
  const dir = tempDir(t);
  const plain = join(dir, 'p.db');
  writeFileSync(plain, 'data');
  encryptFile(plain, join(dir, 'p.enc'), PASS);
  assert.equal(readFileSync(join(dir, 'p.enc'))[5], DEFAULT_LOG_N);
  assert.equal(decryptBuffer(join(dir, 'p.enc'), PASS).toString(), 'data');
});

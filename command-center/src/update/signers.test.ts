import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Exec } from './exec.ts';
import { committedSignersPath, describeSigners, keyFingerprint, parseAllowedSigners, pinSigners, pinnedSignersPath, readSignersFile, sameSigners, SignersError, signerIdentity } from './signers.ts';

const KEY_A = 'AAAAC3NzaC1lZDI1NTE5AAAAIAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const KEY_B = 'AAAAC3NzaC1lZDI1NTE5AAAAIBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const LINE_A = `polaris-release namespaces="git" ssh-ed25519 ${KEY_A} owner@laptop`;
const LINE_B = `polaris-release namespaces="git" ssh-ed25519 ${KEY_B}`;

function scratch(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'cc-signers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the committed file is at the repo root and the pinned copy next to the database', () => {
  assert.equal(committedSignersPath('/srv/polaris'), join('/srv/polaris', 'release-signers'));
  assert.equal(pinnedSignersPath('/srv/polaris/command-center/data/constellation.db'), join('/srv/polaris/command-center/data', 'release-signers'));
});

test('parseAllowedSigners reads principal, options, key type, key, and comment, and skips comments and blank lines', () => {
  const text = `# The keys allowed to sign a release.\n\n${LINE_A}\n  # indented comment\n${LINE_B}\nci valid-after="20260101",namespaces="git" sk-ssh-ed25519@openssh.com ${KEY_B} hardware key\n`;
  const signers = parseAllowedSigners(text);
  assert.equal(signers.length, 3);
  assert.deepEqual(signers[0], { principal: 'polaris-release', options: ['namespaces="git"'], keyType: 'ssh-ed25519', key: KEY_A, comment: 'owner@laptop' });
  assert.deepEqual(signers[1], { principal: 'polaris-release', options: ['namespaces="git"'], keyType: 'ssh-ed25519', key: KEY_B, comment: '' });
  assert.deepEqual(signers[2].options, ['valid-after="20260101",namespaces="git"']);
  assert.equal(signers[2].keyType, 'sk-ssh-ed25519@openssh.com');
  assert.equal(signers[2].comment, 'hardware key');
  assert.deepEqual(parseAllowedSigners('# only comments\n\n'), []);
  assert.deepEqual(parseAllowedSigners(''), []);
});

test('a line without a key is an error, not an empty list', () => {
  assert.throws(() => parseAllowedSigners(`${LINE_A}\njust-a-principal\n`), (e: unknown) => e instanceof SignersError && /line 2 of the signers file/.test(e.message));
  assert.throws(() => parseAllowedSigners('polaris-release ssh-ed25519\n'), /line 1/);
  assert.throws(() => parseAllowedSigners(`ssh-ed25519 ${KEY_A}\n`), /line 1/, 'a key with no principal is not an allowed_signers line');
});

test('sameSigners compares the keys allowed, not the comments or the order', () => {
  const a = parseAllowedSigners(`${LINE_A}\n${LINE_B}\n`);
  const b = parseAllowedSigners(`${LINE_B}\n# different comments\npolaris-release namespaces="git" ssh-ed25519 ${KEY_A} another comment\n`);
  assert.equal(sameSigners(a, b), true);
  assert.equal(sameSigners(a, parseAllowedSigners(LINE_A)), false, 'a key removed');
  assert.equal(sameSigners(parseAllowedSigners(LINE_A), parseAllowedSigners(`${LINE_A}\n${LINE_B}`)), false, 'a key added');
  assert.equal(sameSigners(parseAllowedSigners(LINE_A), parseAllowedSigners(`other namespaces="git" ssh-ed25519 ${KEY_A}`)), false, 'a different principal');
  assert.equal(sameSigners(parseAllowedSigners(LINE_A), parseAllowedSigners(`polaris-release ssh-ed25519 ${KEY_A}`)), false, 'different options');
  assert.equal(sameSigners([], []), true);
  assert.match(signerIdentity(a[0]), /^polaris-release namespaces="git" ssh-ed25519 /);
});

test('pinSigners copies the committed text owner-only, through a staging file that is not left behind', (t) => {
  const dir = scratch(t);
  const committed = join(dir, 'release-signers');
  const dataDir = join(dir, 'data');
  const pinned = join(dataDir, 'release-signers');
  writeFileSync(committed, `# comment\n${LINE_A}\n`);
  assert.throws(() => pinSigners(committed, pinned), 'the data folder must exist: the caller makes it');
  mkdirSync(dataDir);
  const signers = pinSigners(committed, pinned);
  assert.equal(signers.length, 1);
  assert.equal(readFileSync(pinned, 'utf8'), `# comment\n${LINE_A}\n`, 'the text is copied as it is, comments included');
  if (process.platform !== 'win32') assert.equal(statSync(pinned).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dataDir), ['release-signers'], 'no staging file left');
  writeFileSync(committed, `${LINE_B}\n`);
  pinSigners(committed, pinned);
  assert.equal(readFileSync(pinned, 'utf8'), `${LINE_B}\n`, 'a second pin replaces the copy');
  assert.deepEqual(readdirSync(dataDir), ['release-signers']);
  writeFileSync(committed, 'broken line\n');
  assert.throws(() => pinSigners(committed, pinned), SignersError, 'a malformed committed file is never pinned');
  assert.equal(readFileSync(pinned, 'utf8'), `${LINE_B}\n`);
});

test('readSignersFile refuses a file other users can write', { skip: process.platform === 'win32' ? 'POSIX mode bits' : false }, (t) => {
  const dir = scratch(t);
  const file = join(dir, 'release-signers');
  writeFileSync(file, `${LINE_A}\n`, { mode: 0o600 });
  assert.deepEqual(readSignersFile(file, 'linux').signers.map((s) => s.key), [KEY_A]);
  chmodSync(file, 0o644);
  assert.deepEqual(readSignersFile(file, 'linux').signers.map((s) => s.key), [KEY_A], 'readable by others is fine: the keys are public');
  chmodSync(file, 0o664);
  assert.throws(() => readSignersFile(file, 'linux'), (e: unknown) => e instanceof SignersError && /can be written by other users.*chmod 600/.test(e.message));
  chmodSync(file, 0o602);
  assert.throws(() => readSignersFile(file, 'linux'), /written by other users/);
  assert.equal(readSignersFile(file, 'win32').signers.length, 1, 'on Windows the mode bits mean nothing');
});

test('keyFingerprint runs ssh-keygen -lf on a temp copy of the key and reports when it cannot', async () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push({ cmd, args });
    const text = readFileSync(args[1], 'utf8');
    assert.equal(text, `ssh-ed25519 ${KEY_A}\n`, 'the file holds key type and key only, never the principal');
    return { code: 0, stdout: '256 SHA256:7XkuoKngBtHFlb11TNVHq4BN7kSlZDld0g0xBo6AAos no comment (ED25519)\n', stderr: '' };
  };
  const signer = parseAllowedSigners(LINE_A)[0];
  assert.equal(await keyFingerprint(exec, signer), 'SHA256:7XkuoKngBtHFlb11TNVHq4BN7kSlZDld0g0xBo6AAos');
  assert.deepEqual(calls.map((c) => [c.cmd, c.args[0]]), [['ssh-keygen', '-lf']]);
  assert.equal(existsSync(calls[0].args[1]), false, 'the temp file is removed');
  const missing: Exec = async () => ({ code: -1, stdout: '', stderr: 'spawn ssh-keygen ENOENT' });
  assert.equal(await keyFingerprint(missing, signer), '(ssh-keygen is not installed)');
  const broken: Exec = async () => ({ code: 255, stdout: '', stderr: 'key.pub is not a public key file.' });
  assert.equal(await keyFingerprint(broken, signer), '(no fingerprint: key.pub is not a public key file.)');
  const lines = await describeSigners(exec, [signer]);
  assert.deepEqual(lines, ['  polaris-release  ssh-ed25519  SHA256:7XkuoKngBtHFlb11TNVHq4BN7kSlZDld0g0xBo6AAos']);
  assert.deepEqual(await describeSigners(exec, []), ['  (no keys)']);
});

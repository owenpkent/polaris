// Signed releases with the real git and the real ssh-keygen: a key is made in a temp folder, a
// tag is signed with it, and `cc update --check` accepts the tag with that key pinned and rejects
// it with another key pinned, with no keys pinned, and when the tag is not signed at all. Nothing
// but git and ssh-keygen is ever run: --check installs nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memorySecretStore } from '../ingest/secrets.ts';
import { realExec, type Exec } from './exec.ts';
import { SCHEMA_FILE } from './git.ts';
import { runUpdate } from './run.ts';
import { pinnedSignersPath } from './signers.ts';
import { readUpdateStatus } from './status.ts';

const GIT_IDENTITY = ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false'];

function sh(cwd: string, args: string[], extra: string[] = []): string {
  const r = spawnSync('git', [...GIT_IDENTITY, ...extra, ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** Why the test cannot run here, or false. SSH signing needs git 2.34 and ssh-keygen. */
function skipReason(): string | false {
  const keygen = spawnSync('ssh-keygen', ['-?'], { encoding: 'utf8' });
  if (keygen.error) return 'ssh-keygen is not installed, so SSH-signed tags cannot be made or verified here';
  const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
  const m = /(\d+)\.(\d+)/.exec(git.stdout ?? '');
  if (git.error || !m) return 'git is not installed';
  if (Number(m[1]) < 2 || (Number(m[1]) === 2 && Number(m[2]) < 34)) return `git ${m[0]} is older than 2.34, which brought SSH signing`;
  return false;
}

test('cc update --check accepts a tag signed by a pinned key and rejects every other tag', { skip: skipReason() }, async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'cc-update-signing-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const keys = join(base, 'keys');
  mkdirSync(keys);
  for (const name of ['release', 'other']) {
    const r = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `polaris-${name}`, '-f', join(keys, name)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  const signerLine = (name: string) => `polaris-release namespaces="git" ${readFileSync(join(keys, `${name}.pub`), 'utf8').trim().split(' ').slice(0, 2).join(' ')}`;

  // origin: v2.0.0 on main with the release key committed in release-signers, then three newer
  // releases: v2.1.0 signed by the release key, v2.2.0 annotated but unsigned, v2.3.0 signed by
  // the other key.
  const origin = join(base, 'origin.git');
  const seed = join(base, 'seed');
  mkdirSync(seed);
  sh(seed, ['init', '-q', '-b', 'main']);
  const commit = (message: string, files: Record<string, string>) => {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(seed, name, '..'), { recursive: true });
      writeFileSync(join(seed, name), text);
    }
    sh(seed, ['add', '-A']);
    sh(seed, ['commit', '-q', '-m', message]);
  };
  commit('v2.0.0', { 'package.json': JSON.stringify({ version: '2.0.0' }), [SCHEMA_FILE]: 'export const MIGRATIONS = [];\n', 'release-signers': `# release keys\n${signerLine('release')}\n` });
  sh(base, ['init', '-q', '--bare', '-b', 'main', origin]);
  sh(seed, ['remote', 'add', 'origin', origin]);
  sh(seed, ['push', '-q', 'origin', 'main']);
  const clone = join(base, 'clone');
  sh(base, ['clone', '-q', origin, clone]);

  const signedTag = (tag: string, key: string, message: string) => sh(seed, ['tag', '-s', tag, '-m', message], ['-c', 'gpg.format=ssh', '-c', `user.signingkey=${join(keys, key)}`]);
  commit('feat: 2.1.0', { 'package.json': JSON.stringify({ version: '2.1.0' }), [SCHEMA_FILE]: 'export const MIGRATIONS = ["one"];\n' });
  signedTag('v2.1.0', 'release', 'Release 2.1.0\n\nAdds a migration.\u0007');
  commit('feat: 2.2.0', { 'package.json': JSON.stringify({ version: '2.2.0' }) });
  sh(seed, ['tag', '-a', 'v2.2.0', '-m', 'Not signed']);
  commit('feat: 2.3.0', { 'package.json': JSON.stringify({ version: '2.3.0' }) });
  signedTag('v2.3.0', 'other', 'Signed by someone else');
  sh(seed, ['push', '-q', 'origin', 'main', '--tags']);

  const programs: string[] = [];
  const real = realExec();
  const exec: Exec = (cmd, args, opts) => { programs.push(cmd); return real(cmd, args, opts); };
  const dbPath = join(base, 'data', 'constellation.db');
  const pinned = pinnedSignersPath(dbPath);
  const check = async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runUpdate({ repoRoot: clone, dbPath, dashboardDir: join(clone, 'dist'), port: 8790, checkOnly: true, yes: true, restartSpec: 'manual', stdout: (l) => out.push(l), stderr: (l) => err.push(l) }, {
      exec, fetch, now: () => new Date(), sleep: async () => {}, portListening: async () => true, platform: 'linux', env: {}, secrets: memorySecretStore(), confirm: async () => true,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  // First run: the committed file is pinned, and the one tag the pinned key signed is the answer.
  let r = await check();
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(pinned, 'utf8'), `# release keys\n${signerLine('release')}\n`);
  if (process.platform !== 'win32') assert.equal(statSync(pinned).mode & 0o777, 0o600);
  assert.match(r.out, /Pinned release-signers \(1 key\)/);
  assert.match(r.err, /Skipped v2\.3\.0: No principal matched/, 'signed by a key that is not pinned');
  assert.match(r.err, /Skipped v2\.2\.0: no signature found/);
  assert.match(r.out, /v2\.1\.0 \(2\.1\.0\) at [0-9a-f]{7} verifies/);
  assert.match(r.out, /v2\.1\.0 is available/);
  assert.match(r.out, /The schema changes/);
  let status = readUpdateStatus(dbPath);
  assert.deepEqual(status.available, { version: '2.1.0', notes: 'Release 2.1.0\n\nAdds a migration.', touchesSchema: true });
  assert.ok(status.lastCheckAt);

  // The other key pinned instead: v2.3.0 verifies now, and v2.1.0 is not looked at.
  writeFileSync(pinned, `${signerLine('other').replace('polaris-release', 'someone-else')}\n`, { mode: 0o600 });
  r = await check();
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /The signers file changed; run cc update --trust-signers/);
  assert.match(r.out, /v2\.3\.0 \(2\.3\.0\) at [0-9a-f]{7} verifies/);
  assert.equal(readUpdateStatus(dbPath).available?.version, '2.3.0');

  // A pinned key that signed nothing: every newer tag is skipped and nothing is available.
  const unused = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(keys, 'unused')], { encoding: 'utf8' });
  assert.equal(unused.status, 0, unused.stderr);
  writeFileSync(pinned, `${signerLine('unused')}\n`, { mode: 0o600 });
  r = await check();
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /Skipped v2\.3\.0: No principal matched/);
  assert.match(r.err, /Skipped v2\.2\.0: no signature found/);
  assert.match(r.err, /Skipped v2\.1\.0: No principal matched/);
  assert.match(r.err, /no release newer than 2\.0\.0 verifies against the pinned signers \(3 skipped\)/);
  assert.equal(readUpdateStatus(dbPath).available, null);

  // No keys pinned: nothing is even verified.
  writeFileSync(pinned, '# nothing yet\n', { mode: 0o600 });
  r = await check();
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /no release can verify: the pinned signers file .* has no keys/);
  assert.equal(readUpdateStatus(dbPath).available, null);

  assert.deepEqual([...new Set(programs)], ['git'], 'git was the only program run: nothing was installed');
  assert.equal(sh(clone, ['rev-parse', 'HEAD']), sh(clone, ['rev-parse', 'origin/main~3']), 'the checkout never moved');
  assert.equal(sh(clone, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
});

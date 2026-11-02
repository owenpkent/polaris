// The git wrappers against a real repository in a temp folder, with a bare "origin" beside it,
// and the refusals of `cc update` run end to end with the real git: each one stops before npm,
// so nothing but git is ever run. Commits are made with explicit identity and signing off, so
// the owner's git config plays no part.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memorySecretStore } from '../ingest/secrets.ts';
import { realExec, type Exec } from './exec.ts';
import { createPublicKey } from 'node:crypto';
import { sshRsaKey } from '../dev/der.ts';
import { git, LOCKFILES, NO_OTHER_SIGNATURE_PROGRAMS, releaseSignatureFormat, SCHEMA_FILE, tagObjectName } from './git.ts';
import { parseAllowedSigners, x509PinnedKeys } from './signers.ts';
import { runUpdate } from './run.ts';

// Every repository here is a temp one the test makes. A pre-push hook in a linked worktree runs
// with GIT_DIR exported (git does that for hooks there), and every git call below would then act
// on the repository being pushed, so the variables that name a repository are dropped for this
// process. signing.test.ts does the same.
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) delete process.env[name];

const GIT_IDENTITY = ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false'];

function sh(cwd: string, args: string[]): string {
  const r = spawnSync('git', [...GIT_IDENTITY, ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** A bare origin with `main` at version 2.0.0, and a clone of it. */
function repos(t: { after(fn: () => void): void }) {
  const base = mkdtempSync(join(tmpdir(), 'cc-update-git-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const origin = join(base, 'origin.git');
  const seed = join(base, 'seed');
  mkdirSync(seed);
  sh(seed, ['init', '-q', '-b', 'main']);
  mkdirSync(join(seed, 'command-center', 'src', 'core'), { recursive: true });
  const commit = (dir: string, message: string, files: Record<string, string>) => {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    sh(dir, ['add', '-A']);
    sh(dir, ['commit', '-q', '-m', message]);
    return sh(dir, ['rev-parse', 'HEAD']);
  };
  commit(seed, 'v2.0.0', { 'package.json': JSON.stringify({ version: '2.0.0' }), [SCHEMA_FILE]: 'export const MIGRATIONS = [];\n', 'package-lock.json': '{}' });
  sh(base, ['init', '-q', '--bare', '-b', 'main', origin]);
  sh(seed, ['remote', 'add', 'origin', origin]);
  sh(seed, ['push', '-q', 'origin', 'main']);
  const clone = join(base, 'clone');
  sh(base, ['clone', '-q', origin, clone]);
  return { base, origin, seed, clone, commit };
}

test('the git wrappers read a real repository', async (t) => {
  const r = repos(t);
  const g = git(realExec(), r.clone);
  assert.deepEqual(await g.statusLines(), []);
  assert.equal(await g.branch(), 'main');
  assert.equal(await g.tagAtHead(), null);
  assert.deepEqual(await g.aheadBehind('origin/main'), { ahead: 0, behind: 0 });
  const head = await g.revParse('HEAD');
  assert.match(head, /^[0-9a-f]{40}$/);
  assert.equal(await g.showFile('origin/main', 'package.json'), JSON.stringify({ version: '2.0.0' }));
  assert.equal(await g.showFile('origin/main', 'missing.json'), null);

  // Two commits land on origin: one touches the schema and a lockfile and bumps the version.
  r.commit(r.seed, 'feat: one', { 'README.md': 'hello' });
  const target = r.commit(r.seed, 'feat: two', { 'package.json': JSON.stringify({ version: '2.1.0' }), [SCHEMA_FILE]: 'export const MIGRATIONS = ["x"];\n', [LOCKFILES[0]]: '{"changed":1}' });
  sh(r.seed, ['push', '-q', 'origin', 'main']);
  await g.fetch('origin');
  assert.deepEqual(await g.aheadBehind('origin/main'), { ahead: 0, behind: 2 });
  assert.equal(await g.revParse('origin/main'), target);
  assert.deepEqual((await g.logLines('HEAD', 'origin/main')).map((l) => l.replace(/^\w+ /, '')), ['feat: two', 'feat: one']);
  assert.deepEqual((await g.changedFiles('HEAD', 'origin/main', [SCHEMA_FILE, ...LOCKFILES])).sort(), [SCHEMA_FILE, LOCKFILES[0]].sort());

  await g.fastForward('origin/main');
  assert.equal(await g.revParse('HEAD'), target);
  assert.equal(await g.branch(), 'main', 'still on main after the fast-forward');
  await g.resetHard(head);
  assert.equal(await g.revParse('HEAD'), head);
  assert.deepEqual(await g.statusLines(), []);

  writeFileSync(join(r.clone, 'untracked.txt'), 'x');
  assert.deepEqual(await g.statusLines(), ['?? untracked.txt'], 'an untracked file counts');

  sh(r.seed, ['tag', 'v2.1.0']);
  sh(r.seed, ['tag', 'not-a-release']);
  assert.equal(await git(realExec(), r.seed).tagAtHead(), 'v2.1.0');
  sh(r.seed, ['tag', '-d', 'v2.1.0']);
  assert.equal(await git(realExec(), r.seed).tagAtHead(), null, 'a tag that is not vX.Y.Z is not a release');

  // Tags: fetched with the branches, listed, their notes read without the signature block, and
  // verified (here: refused, since nothing is signed) against one named signers file.
  rmSync(join(r.clone, 'untracked.txt'));
  sh(r.seed, ['tag', '-a', 'v2.1.0', '-m', 'Release 2.1.0\n\nSecond paragraph.']);
  sh(r.seed, ['push', '-q', 'origin', '--tags']);
  await g.fetchTags('origin');
  assert.deepEqual((await g.tags()).sort(), ['not-a-release', 'v2.1.0']);
  assert.equal((await g.tagNotes('v2.1.0')).trim(), 'Release 2.1.0\n\nSecond paragraph.');
  assert.equal((await g.tagNotes('not-a-release')).trim(), '', 'a lightweight tag has no notes of its own');
  const signers = join(r.base, 'signers');
  writeFileSync(signers, '# no keys\n');
  const unsigned = await g.verifyTag('v2.1.0', signers, []);
  assert.equal(unsigned.ok, false);
  assert.match((unsigned as { reason: string }).reason, /no signature found/);
  const lightweight = await g.verifyTag('not-a-release', signers, []);
  assert.equal(lightweight.ok, false);
  assert.match((lightweight as { reason: string }).reason, /cannot verify a non-tag object/);

  await g.checkout('v2.1.0', { detach: true });
  assert.equal(await g.branch(), null, 'detached on the tag');
  assert.equal(await g.tagAtHead(), 'v2.1.0');
  assert.equal(await g.revParse('HEAD'), target);
  await g.checkout('main', { detach: false, force: true });
  assert.equal(await g.branch(), 'main');
  assert.equal(await g.revParse('HEAD'), head, 'main never moved');
  await g.checkout(head, { detach: true, force: true });
  assert.equal(await g.branch(), null);
  await g.checkout('main', { detach: false });
});

test('a git failure is reported with the command and the reason', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-update-nogit-'));
  try {
    await assert.rejects(git(realExec(), dir).statusLines(), /git status --porcelain failed .*not a git repository/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with the real git, each refusal stops before any other program runs', async (t) => {
  const r = repos(t);
  const programs: string[] = [];
  const real = realExec();
  const exec: Exec = (cmd, args, opts) => { programs.push(cmd); return real(cmd, args, opts); };
  const dbPath = join(r.base, 'data', 'polaris.db');
  const run = async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runUpdate({ repoRoot: r.clone, dbPath, dashboardDir: join(r.clone, 'dist'), port: 8790, checkOnly: false, yes: true, restartSpec: 'manual', stdout: (l) => out.push(l), stderr: (l) => err.push(l) }, {
      exec, fetch, now: () => new Date(), sleep: async () => {}, portListening: async () => true, platform: 'linux', env: {}, secrets: memorySecretStore(), confirm: async () => true,
    });
    return { code, text: [...out, ...err].join('\n') };
  };

  // Dirty tree.
  writeFileSync(join(r.clone, 'scratch.txt'), 'work in progress');
  let result = await run();
  assert.equal(result.code, 1);
  assert.match(result.text, /uncommitted changes/);
  rmSync(join(r.clone, 'scratch.txt'));

  // Not on main.
  sh(r.clone, ['checkout', '-q', '-b', 'feat/x']);
  result = await run();
  assert.equal(result.code, 1);
  assert.match(result.text, /on feat\/x, not main/);
  sh(r.clone, ['checkout', '-q', 'main']);
  sh(r.clone, ['branch', '-q', '-D', 'feat/x']);

  // Local commits ahead of origin.
  r.commit(r.clone, 'local work', { 'local.txt': 'x' });
  result = await run();
  assert.equal(result.code, 1);
  assert.match(result.text, /1 local commit is not on origin\/main/);
  sh(r.clone, ['reset', '-q', '--hard', 'origin/main']);

  // Behind, but origin's version is older than the running one.
  r.commit(r.seed, 'chore: wrong way', { 'package.json': JSON.stringify({ version: '1.9.9' }) });
  sh(r.seed, ['push', '-q', 'origin', 'main']);
  result = await run();
  assert.equal(result.code, 1);
  assert.match(result.text, /origin\/main is 1\.9\.9, which is older than the running 2\.0\.0/);

  // Behind, same version: that would install, so --check only. It reports main and the releases.
  const checked = await (async () => {
    const out: string[] = [];
    const code = await runUpdate({ repoRoot: r.clone, dbPath, dashboardDir: join(r.clone, 'dist'), port: 8790, checkOnly: true, yes: true, restartSpec: 'manual', stdout: (l) => out.push(l), stderr: (l) => out.push(l) }, {
      exec, fetch, now: () => new Date(), sleep: async () => {}, portListening: async () => true, platform: 'linux', env: {}, secrets: memorySecretStore(), confirm: async () => true,
    });
    return { code, text: out.join('\n') };
  })();
  assert.equal(checked.code, 0);
  assert.match(checked.text, /origin\/main: origin\/main is 1\.9\.9, which is older/);
  assert.match(checked.text, /there is no release-signers file in the checkout and none is pinned/);

  assert.deepEqual([...new Set(programs)], ['git'], 'git was the only program run');
  assert.equal(sh(r.clone, ['rev-parse', 'HEAD']), sh(r.clone, ['rev-parse', 'origin/main~1']), 'the checkout never moved');
});

test('the signature gate takes exactly one SSH or X.509 signature block and names any other format', () => {
  const tag = (blocks: string) => `object ${'a'.repeat(40)}\ntype commit\ntag v2.1.0\ntagger t <t@example.com> 1760000000 +0000\n\nRelease 2.1.0\n${blocks}`;
  const ssh = '-----BEGIN SSH SIGNATURE-----\nU1NIU0lH\n-----END SSH SIGNATURE-----\n';
  const pgp = '-----BEGIN PGP SIGNATURE-----\n\niQEz\n-----END PGP SIGNATURE-----\n';
  const x509 = '-----BEGIN SIGNED MESSAGE-----\nMIIG\n-----END SIGNED MESSAGE-----\n';
  assert.deepEqual(releaseSignatureFormat(tag(ssh)), { ok: true, format: 'SSH' });
  assert.deepEqual(releaseSignatureFormat(tag(x509)), { ok: true, format: 'X.509' });
  assert.deepEqual(releaseSignatureFormat(tag(ssh.replace(/\n/g, '\r\n'))), { ok: true, format: 'SSH' }, 'CRLF line ends');
  assert.deepEqual(releaseSignatureFormat(tag(x509.replace(/\n/g, '\r\n'))), { ok: true, format: 'X.509' }, 'CRLF line ends');
  assert.deepEqual(releaseSignatureFormat(tag('')), { ok: false, reason: 'no signature found' });
  const openPgp = /signed with OpenPGP; a release is signed with SSH or X\.509/;
  assert.match((releaseSignatureFormat(tag(pgp)) as { reason: string }).reason, openPgp);
  assert.match((releaseSignatureFormat(tag('-----BEGIN PGP MESSAGE-----\nx\n-----END PGP MESSAGE-----\n')) as { reason: string }).reason, openPgp);
  const reason = (text: string) => (releaseSignatureFormat(text) as { reason: string }).reason;
  assert.match(reason(tag(ssh + pgp)), /carries 2 signature blocks \(SSH, OpenPGP\)/);
  assert.match(reason(tag(ssh + ssh)), /carries 2 signature blocks \(SSH, SSH\)/);
  assert.match(reason(tag(x509 + ssh)), /carries 2 signature blocks \(X\.509, SSH\)/);
  // A message that quotes a signature header is two blocks, and two blocks is a refusal.
  assert.match(reason(tag('').replace('Release 2.1.0', 'Release 2.1.0\n-----BEGIN SSH SIGNATURE-----\nquoted\n-----END SSH SIGNATURE-----') + ssh), /carries 2 signature blocks/);
  assert.match(reason(tag('-----BEGIN SOMETHING ELSE-----\nx\n-----END SOMETHING ELSE-----\n')), /signed with SOMETHING ELSE; a release is signed with SSH or X\.509/);
  assert.deepEqual(releaseSignatureFormat(tag('  -----BEGIN SSH SIGNATURE-----\n')), { ok: false, reason: 'no signature found' }, 'a header is a whole line, as git writes it');
  assert.ok(NO_OTHER_SIGNATURE_PROGRAMS.includes('-c') && NO_OTHER_SIGNATURE_PROGRAMS.some((a) => a.startsWith('gpg.openpgp.program=')) && NO_OTHER_SIGNATURE_PROGRAMS.some((a) => a.startsWith('gpg.x509.program=')));
});

test('tagObjectName reads the tag header, and only the header', () => {
  assert.equal(tagObjectName('object abc\ntype commit\ntag v2.1.0\ntagger t <t@e> 1 +0000\n\nRelease\n'), 'v2.1.0');
  assert.equal(tagObjectName('object abc\ntype commit\n\nRelease\n'), null);
  assert.equal(tagObjectName('object abc\r\ntype commit\r\ntag v2.1.0\r\ntagger t <t@e> 1 +0000\r\n\r\nRelease\r\n'), 'v2.1.0');
  assert.equal(tagObjectName('object abc\ntype commit\n\ntag v9.9.9\nin the message\n'), null, 'a tag line in the message is not the header');
  assert.equal(tagObjectName('object abc\ntype commit\ntag v1.0.0\n\ntag v9.9.9\n'), 'v1.0.0');
});

const fixtureDir = join(import.meta.dirname, 'fixtures');

/** A fake Exec that answers `git cat-file tag` with the given bytes and records every command. */
function catFileExec(raw: string, verifyStderr = ''): { exec: Exec; commands: string[] } {
  const commands: string[] = [];
  const exec: Exec = async (cmd, args) => {
    commands.push(`${cmd} ${args.join(' ')}`);
    if (args[0] === 'cat-file') return { code: 0, stdout: raw, stderr: '' };
    if (args.includes('verify-tag')) return { code: 0, stdout: '', stderr: verifyStderr };
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  return { exec, commands };
}

test('verifyTag verifies an X.509 signature with the pinned RSA key and never asks git verify-tag', async () => {
  const bytes = readFileSync(join(fixtureDir, 'x509-tag.txt'));
  const raw = bytes.toString('latin1');
  const keys = x509PinnedKeys(parseAllowedSigners(`ok-studio-ev namespaces="git" ${sshRsaKey(createPublicKey(readFileSync(join(fixtureDir, 'x509-signer.pem'))))}\n`));
  assert.equal(keys.length, 1);

  const ok = catFileExec(raw);
  assert.deepEqual(await git(ok.exec, '/repo').verifyTag('v0.0.1-dryrun', '/nowhere', keys), { ok: true, format: 'X.509', signer: 'ok-studio-ev' });
  assert.deepEqual(ok.commands, ['git cat-file tag v0.0.1-dryrun']);
  assert.ok(!ok.commands.some((c) => c.includes('verify-tag')));

  const noKeys = catFileExec(raw);
  const none = await git(noKeys.exec, '/repo').verifyTag('v0.0.1-dryrun', '/nowhere', []);
  assert.equal(none.ok, false);
  assert.match((none as { reason: string }).reason, /no pinned key signed it/);

  const renamed = catFileExec(raw);
  const wrongName = await git(renamed.exec, '/repo').verifyTag('v9.9.9', '/nowhere', keys);
  assert.equal(wrongName.ok, false);
  assert.match((wrongName as { reason: string }).reason, /named v0\.0\.1-dryrun, not v9\.9\.9/);
  assert.ok(!renamed.commands.some((c) => c.includes('verify-tag')));

  const edited = Buffer.from(bytes);
  const messageAt = edited.indexOf('\n\n') + 2;
  edited[messageAt] ^= 0x01;
  const changed = catFileExec(edited.toString('latin1'));
  const bad = await git(changed.exec, '/repo').verifyTag('v0.0.1-dryrun', '/nowhere', keys);
  assert.equal(bad.ok, false);
  assert.match((bad as { reason: string }).reason, /changed after it was signed/);
});

test('a pinned key the SSH path would refuse for a tag does not verify the same release as X.509', async () => {
  const raw = readFileSync(join(fixtureDir, 'x509-tag.txt')).toString('latin1');
  const key = sshRsaKey(createPublicKey(readFileSync(join(fixtureDir, 'x509-signer.pem'))));
  for (const options of ['namespaces="file"', 'namespaces="git",valid-before="20000101"', 'cert-authority,namespaces="git"']) {
    const keys = x509PinnedKeys(parseAllowedSigners(`ok-studio-ev ${options} ${key}\n`));
    const result = await git(catFileExec(raw).exec, '/repo').verifyTag('v0.0.1-dryrun', '/nowhere', keys);
    assert.equal(result.ok, false, `${options} signs no release`);
    assert.match((result as { reason: string }).reason, /no pinned key signed it/);
  }
});

test('verifyTag verifies an SSH signature with git verify-tag and names the principal git reports', async () => {
  const raw = `object ${'a'.repeat(40)}\ntype commit\ntag v2.1.0\ntagger t <t@example.com> 1760000000 +0000\n\nRelease 2.1.0\n-----BEGIN SSH SIGNATURE-----\nU1NIU0lH\n-----END SSH SIGNATURE-----\n`;
  const f = catFileExec(raw, 'Good "git" signature for polaris-release with ED25519 key SHA256:x');
  assert.deepEqual(await git(f.exec, '/repo').verifyTag('v2.1.0', '/pinned/signers', []), { ok: true, format: 'SSH', signer: 'polaris-release' });
  assert.ok(f.commands.some((c) => c.includes('verify-tag v2.1.0') && c.includes('gpg.ssh.allowedSignersFile=/pinned/signers')));
});
// The desktop app was removed in 2026-10 (PR #100), but a checkout that built or tested it still
// holds its generated output. Those paths stay in the repo's .gitignore, because runUpdate
// refuses a tree with untracked files and would otherwise be blocked on every such checkout.
test('old desktop build output in a checkout is still ignored, so the updater is not blocked by it', async (t) => {
  const r = repos(t);
  const ignore = readFileSync(join(import.meta.dirname, '..', '..', '..', '.gitignore'), 'utf8');
  r.commit(r.clone, 'the real .gitignore', { '.gitignore': ignore });
  const leftovers = [
    'desktop/src-tauri/resources/command-center/package.json',
    'desktop/src-tauri/binaries/node-x86_64-pc-windows-msvc.exe',
    'desktop/src-tauri/target/debug/polaris-desktop.exe',
    'desktop/src-tauri/gen/schemas/desktop-schema.json',
    'desktop/release/latest.json',
    'desktop-test-output/run-1/error-context.md',
  ];
  for (const name of leftovers) {
    mkdirSync(join(r.clone, name, '..'), { recursive: true });
    writeFileSync(join(r.clone, name), 'left behind by the old desktop build\n');
  }
  assert.deepEqual(await git(realExec(), r.clone).statusLines(), []);
});

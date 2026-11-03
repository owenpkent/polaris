// What `cc update` asks git, through the Exec seam: the state of the working tree, where it stands
// against origin, what an update would change, and the two moves it makes (fast-forward, and the
// reset that undoes it). Every call is `git` with an argument array; nothing is pasted into a
// command line. Nothing here writes to the remote: the only network calls are `git fetch` and
// `git fetch --tags`, with whatever credential-free access the remote already has for `git pull`.
// A tag is verified against the pinned signers (signers.ts) and nothing else: a tag that carries
// exactly one signature block is verified by that block's format, an SSH signature with
// `git verify-tag` against the pinned allowed_signers file alone (never the checkout's own or the
// global git config), an X.509 one with cms.ts against the RSA keys in that same file. Anything
// else (no block, two blocks, OpenPGP) is refused before git is asked, because git would otherwise
// accept a signature from the local keyring, which the pinned signers never named. The name on
// the tag object must be the tag's: the signature covers the name, not the ref.
import { splitSignedTag, verifySignedMessage, type PinnedPublicKey } from './cms.ts';
import type { Exec, ExecResult } from './exec.ts';

export const SCHEMA_FILE = 'command-center/src/core/schema.ts';
export const LOCKFILES = ['package-lock.json', 'command-center/package-lock.json'];

export class GitError extends Error {}

export interface AheadBehind { ahead: number; behind: number }

export type SignatureFormat = 'SSH' | 'X.509';

export type TagVerification =
  | { ok: true; format: SignatureFormat; /** The principal of the pinned key, when known. */ signer: string | null }
  | { ok: false; reason: string };

/** `git verify-tag` picks the verifier from the signature in the tag, not from `gpg.format`: an
 *  OpenPGP signature goes to gpg and an X.509 one to gpgsm, and a key in the local keyring would
 *  pass. These point both at a program that does not exist, so neither can succeed; the format
 *  check on the raw tag (`releaseSignatureFormat`) is the gate that does not depend on it, and
 *  an X.509 signature never reaches git at all. */
export const NO_OTHER_SIGNATURE_PROGRAMS = ['-c', 'gpg.openpgp.program=cc-update-refuses-openpgp', '-c', 'gpg.x509.program=cc-update-refuses-x509'];

const SIGNATURE_BLOCK_RE = /^-----BEGIN ([A-Z0-9 ]+?)-----\r?$/gm;

/** The name of a signature format from the line that opens its block, as git writes them. */
function signatureFormatName(block: string): string {
  if (block === 'SSH SIGNATURE') return 'SSH';
  if (block === 'PGP SIGNATURE' || block === 'PGP MESSAGE') return 'OpenPGP';
  if (block === 'SIGNED MESSAGE') return 'X.509';
  return block;
}

/** Which release signature a raw tag object (`git cat-file tag`) carries: exactly one signature
 *  block, SSH or X.509. Anything else is a reason. A message that quotes a signature header counts
 *  as a second block, and refusing that is the safe reading. */
export function releaseSignatureFormat(rawTag: string): { ok: true; format: SignatureFormat } | { ok: false; reason: string } {
  const blocks = [...rawTag.matchAll(SIGNATURE_BLOCK_RE)].map((m) => m[1]);
  if (blocks.length === 0) return { ok: false, reason: 'no signature found' };
  if (blocks.length > 1) return { ok: false, reason: `the tag carries ${blocks.length} signature blocks (${blocks.map(signatureFormatName).join(', ')}); a release carries one signature, SSH or X.509` };
  const format = signatureFormatName(blocks[0]);
  if (format === 'SSH' || format === 'X.509') return { ok: true, format };
  return { ok: false, reason: `the tag is signed with ${format}; a release is signed with SSH or X.509 by a pinned key` };
}

/** The name on the tag object's `tag` header line, or null when there is none. */
export function tagObjectName(rawTag: string): string | null {
  const blank = rawTag.search(/\r?\n\r?\n/);
  const headers = blank < 0 ? rawTag : rawTag.slice(0, blank);
  return /^tag (.+?)\r?$/m.exec(headers)?.[1] ?? null;
}

export interface Git {
  /** The porcelain status lines: empty for a clean tree. Untracked files count as dirty. */
  statusLines(): Promise<string[]>;
  /** The current branch, or null when HEAD is detached. */
  branch(): Promise<string | null>;
  /** A vX.Y.Z tag exactly at HEAD, or null. Other tags at HEAD are ignored. */
  tagAtHead(): Promise<string | null>;
  fetch(remote: string): Promise<void>;
  /** `git fetch --tags`: the branches as `fetch` gets them, plus every tag on the remote. */
  fetchTags(remote: string): Promise<void>;
  /** Every local tag name, including the ones just fetched. */
  tags(): Promise<string[]>;
  /** An annotated tag's message (subject and body, without the signature); empty for a lightweight tag. */
  tagNotes(tag: string): Promise<string>;
  /** The tag's one signature against the pinned signers: an SSH one with `git verify-tag` against
   *  `allowedSignersFile` only, an X.509 one against `x509Keys` (the RSA keys of that same file).
   *  A failure carries the reason, or git's last line. */
  verifyTag(tag: string, allowedSignersFile: string, x509Keys: PinnedPublicKey[]): Promise<TagVerification>;
  /** Commits HEAD has that `ref` does not, and the reverse. */
  aheadBehind(ref: string): Promise<AheadBehind>;
  revParse(ref: string): Promise<string>;
  /** One line per commit in `from..to`, newest first. */
  logLines(from: string, to: string): Promise<string[]>;
  /** The paths among `paths` that differ between `from` and `to`. */
  changedFiles(from: string, to: string, paths: string[]): Promise<string[]>;
  /** The text of `path` at `ref`, or null when it does not exist there. */
  showFile(ref: string, path: string): Promise<string | null>;
  /** Move the current branch forward to `ref`; refused by git unless it is a fast-forward. */
  fastForward(ref: string): Promise<void>;
  /** Put the working tree and the current branch back at `sha`. Only for a tree already known clean. */
  resetHard(sha: string): Promise<void>;
  /** Check out `ref` with HEAD detached (a release tag), or a branch by name; `force` discards any
   *  working-tree change in a tracked file, for a rollback that must land. */
  checkout(ref: string, opts: { detach: boolean; force?: boolean }): Promise<void>;
}

export function git(exec: Exec, cwd: string): Git {
  const run = async (args: string[]): Promise<ExecResult> => exec('git', args, { cwd });
  const must = async (args: string[]): Promise<string> => {
    const r = await run(args);
    if (r.code !== 0) throw new GitError(`git ${args.join(' ')} failed (${r.code}): ${(r.stderr || r.stdout).trim()}`);
    return r.stdout;
  };
  const lines = (text: string) => text.split('\n').map((l) => l.trimEnd()).filter(Boolean);
  return {
    statusLines: async () => lines(await must(['status', '--porcelain'])),
    branch: async () => {
      const name = (await must(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      return name === 'HEAD' ? null : name;
    },
    tagAtHead: async () => {
      const tags = lines(await must(['tag', '--points-at', 'HEAD'])).filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
      return tags[0] ?? null;
    },
    fetch: async (remote) => { await must(['fetch', '--prune', remote]); },
    fetchTags: async (remote) => { await must(['fetch', '--prune', '--tags', remote]); },
    tags: async () => lines(await must(['tag', '--list'])),
    tagNotes: async (tag) => {
      // A lightweight tag is a commit, and its "contents" would be the commit message: not notes.
      const text = await must(['tag', '-l', '--format=%(objecttype)%0a%(contents:subject)%0a%0a%(contents:body)', tag]);
      const newline = text.indexOf('\n');
      return newline > 0 && text.slice(0, newline) === 'tag' ? text.slice(newline + 1) : '';
    },
    verifyTag: async (tag, allowedSignersFile, x509Keys) => {
      const verifySsh = () => run(['-c', 'gpg.format=ssh', '-c', `gpg.ssh.allowedSignersFile=${allowedSignersFile}`, ...NO_OTHER_SIGNATURE_PROGRAMS, 'verify-tag', tag]);
      const gitSaid = (r: ExecResult) => (lines(`${r.stdout}\n${r.stderr}`).pop() ?? `git verify-tag exited ${r.code}`).replace(/^error: /, '').replace(/\.$/, '');
      // The gate first: git verify-tag would verify whatever signature the tag carries with
      // whatever program that format names, so only a tag that carries one SSH signature is put
      // to it at all. The bytes are kept as they are: an X.509 signature covers them exactly.
      const raw = await exec('git', ['cat-file', 'tag', tag], { cwd, raw: true });
      if (raw.code !== 0) {
        // A lightweight tag has no tag object; git verify-tag says so in its own words.
        const r = await verifySsh();
        if (r.code !== 0) return { ok: false, reason: gitSaid(r) };
        return { ok: false, reason: `the tag object could not be read (git cat-file exited ${raw.code}), so its signature format is not known` };
      }
      const format = releaseSignatureFormat(raw.stdout);
      if (!format.ok) return format;
      const named = tagObjectName(raw.stdout);
      if (named !== tag) return { ok: false, reason: `the tag object is named ${named === null ? 'nothing' : named}, not ${tag}; the signature covers that name, so the tag was renamed after it was signed` };
      if (format.format === 'X.509') {
        const split = splitSignedTag(Buffer.from(raw.stdout, 'latin1'));
        if (!split) return { ok: false, reason: 'the X.509 signature block does not start a line' };
        const v = verifySignedMessage(split.payload, split.signatureBlock, x509Keys);
        if (!v.ok) return { ok: false, reason: `the X.509 signature does not verify against the pinned keys: ${v.reason}` };
        return { ok: true, format: 'X.509', signer: v.signer };
      }
      const r = await verifySsh();
      if (r.code !== 0) return { ok: false, reason: gitSaid(r) };
      return { ok: true, format: 'SSH', signer: /Good "git" signature for (\S+)/.exec(`${r.stdout}\n${r.stderr}`)?.[1] ?? null };
    },
    aheadBehind: async (ref) => {
      const [ahead, behind] = (await must(['rev-list', '--left-right', '--count', `HEAD...${ref}`])).trim().split(/\s+/).map(Number);
      if (!Number.isInteger(ahead) || !Number.isInteger(behind)) throw new GitError(`git rev-list gave no counts for HEAD...${ref}`);
      return { ahead, behind };
    },
    revParse: async (ref) => (await must(['rev-parse', '--verify', `${ref}^{commit}`])).trim(),
    logLines: async (from, to) => lines(await must(['log', '--oneline', '--no-decorate', `${from}..${to}`])),
    changedFiles: async (from, to, paths) => lines(await must(['diff', '--name-only', from, to, '--', ...paths])),
    showFile: async (ref, path) => {
      const r = await run(['show', `${ref}:${path}`]);
      return r.code === 0 ? r.stdout : null;
    },
    fastForward: async (ref) => { await must(['merge', '--ff-only', ref]); },
    resetHard: async (sha) => { await must(['reset', '--hard', sha]); },
    checkout: async (ref, opts) => { await must(['checkout', '-q', ...(opts.force ? ['--force'] : []), ...(opts.detach ? ['--detach'] : []), ref]); },
  };
}

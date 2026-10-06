// What `cc update` asks git, through the Exec seam: the state of the working tree, where it stands
// against origin, what an update would change, and the two moves it makes (fast-forward, and the
// reset that undoes it). Every call is `git` with an argument array; nothing is pasted into a
// command line. Nothing here writes to the remote: the only network calls are `git fetch` and
// `git fetch --tags`, with whatever credential-free access the remote already has for `git pull`.
// A tag is verified with `git verify-tag` against one named allowed_signers file (signers.ts),
// never against the checkout's own or the global git config.
import type { Exec, ExecResult } from './exec.ts';

export const SCHEMA_FILE = 'command-center/src/core/schema.ts';
export const LOCKFILES = ['package-lock.json', 'command-center/package-lock.json'];

export class GitError extends Error {}

export interface AheadBehind { ahead: number; behind: number }

export type TagVerification = { ok: true } | { ok: false; reason: string };

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
  /** `git verify-tag` with SSH signatures against `allowedSignersFile` only. A failure carries git's last line. */
  verifyTag(tag: string, allowedSignersFile: string): Promise<TagVerification>;
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
    verifyTag: async (tag, allowedSignersFile) => {
      const r = await run(['-c', 'gpg.format=ssh', '-c', `gpg.ssh.allowedSignersFile=${allowedSignersFile}`, 'verify-tag', tag]);
      if (r.code === 0) return { ok: true };
      const said = lines(`${r.stdout}\n${r.stderr}`).pop() ?? `git verify-tag exited ${r.code}`;
      return { ok: false, reason: said.replace(/^error: /, '').replace(/\.$/, '') };
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

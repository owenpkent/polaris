// Verifies a release tag the way an install does (command-center/src/update/git.ts verifyTag),
// against the committed release-signers file instead of an install's pinned copy: exactly one
// signature block, SSH (git verify-tag) or X.509 (cms.ts), from a key in the file, and the tag
// object named for the tag. Run it before pushing a tag:
//   node scripts/verify-release-tag.mjs v2.3.0
// Exit 0 when the tag verifies, 1 when it does not, with the reason an install would log.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { realExec } from '../command-center/src/update/exec.ts';
import { git } from '../command-center/src/update/git.ts';
import { committedSignersPath, parseAllowedSigners, x509PinnedKeys } from '../command-center/src/update/signers.ts';

const tag = process.argv[2];
if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error('usage: node scripts/verify-release-tag.mjs vX.Y.Z');
  process.exit(2);
}
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const signersFile = committedSignersPath(repoRoot);
const signers = parseAllowedSigners(readFileSync(signersFile, 'utf8'));
const result = await git(realExec(), repoRoot).verifyTag(tag, signersFile, x509PinnedKeys(signers));
if (result.ok) {
  console.log(`${tag} verifies (${result.format}${result.signer ? `, ${result.signer}` : ''}) against ${signersFile}`);
} else {
  console.error(`${tag} does not verify: ${result.reason}`);
  process.exit(1);
}

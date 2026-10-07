// Run by `npm install` (the root `prepare` script): points git at .githooks so the pre-push
// gate is on without a manual step. It does nothing in CI, outside a git checkout, or when git
// is missing, and it never fails the install.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

try {
  if (process.env.CI || !existsSync('.githooks')) process.exit(0);
  execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' });
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
} catch {
  // No git, not a checkout, or a read-only config: the hook is a convenience, not a requirement.
}

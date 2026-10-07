// `cc update` installs with `npm ci --ignore-scripts` in both package folders and then runs
// `npm rebuild esbuild` at the root, because esbuild's install script is what fetches its binary
// and the dashboard build needs it (docs/update-proposal.md, section 1, step 5). This test pins
// the packages whose install scripts are skipped. A new entry here is a deliberate change to
// `cc update` (src/update/run.ts): decide whether that package needs a rebuild, and say so there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');

interface LockPackage { hasInstallScript?: boolean; dev?: boolean }
interface Lockfile { packages: Record<string, LockPackage> }

/** The package names (the last `node_modules/` segment) of every entry with an install script. */
function withInstallScripts(lockfile: string): { name: string; dev: boolean }[] {
  const lock = JSON.parse(readFileSync(lockfile, 'utf8')) as Lockfile;
  return Object.entries(lock.packages)
    .filter(([, p]) => p.hasInstallScript)
    .map(([path, p]) => ({ name: path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length), dev: Boolean(p.dev) }));
}

test('the root lockfile has install scripts for esbuild and fsevents only, both dev dependencies', () => {
  const found = withInstallScripts(join(ROOT, 'package-lock.json'));
  assert.deepEqual([...new Set(found.map((p) => p.name))].sort(), ['esbuild', 'fsevents']);
  assert.ok(found.every((p) => p.dev), 'an install script on a runtime dependency changes what --ignore-scripts leaves out');
});

test('the command-center lockfile has no install scripts', () => {
  assert.deepEqual(withInstallScripts(join(ROOT, 'command-center', 'package-lock.json')), []);
});

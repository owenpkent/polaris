// The version is the root package.json's, and command-center/package.json mirrors it
// (docs/update-proposal.md, section 1B). GET /api/health reports the second, and `cc update`
// compares the first against what it would install, so the two must agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isVersion } from './update/version.ts';

const here = dirname(fileURLToPath(import.meta.url));
const version = (file: string) => (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version;

test('the two package.json versions are equal and well-formed', () => {
  const root = version(join(here, '..', '..', 'package.json'));
  const commandCenter = version(join(here, '..', 'package.json'));
  assert.equal(commandCenter, root, 'bump both package.json files together');
  assert.ok(isVersion(root), `${root} is not MAJOR.MINOR.PATCH`);
});

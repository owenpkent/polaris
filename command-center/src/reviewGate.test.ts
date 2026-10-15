// The Reviewed check (.github/workflows/review-gate.yml) decides from the reviews on the head commit
// whether a pull request may merge. These tests run the workflow's own shell step with a stand-in
// for gh that prints the lines the real call's --jq filter would print, under the shell options
// Actions uses (bash -eo pipefail), so the ordering and the decision are tested as written,
// without the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = join(here, '..', '..', '.github', 'workflows', 'review-gate.yml');

/** The `run: |` block of the workflow's one step, dedented. */
function gateScript(): string {
  const lines = readFileSync(WORKFLOW, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === 'run: |');
  assert.ok(start >= 0, 'review-gate.yml has no run block');
  const body = lines.slice(start + 1);
  const indent = body.find((line) => line.trim())!.match(/^ */)![0].length;
  const end = body.findIndex((line) => line.trim() !== '' && line.match(/^ */)![0].length < indent);
  return body.slice(0, end === -1 ? undefined : end).map((line) => line.slice(indent)).join('\n');
}

const haveBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;

function gate(reviews: string[], opts: { apiFails?: boolean } = {}) {
  const stub = 'gh() { if [ -n "$GH_FAIL" ]; then echo "gh: HTTP 502" >&2; return 1; fi; printf "%s" "$GH_FIXTURE"; }\n';
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', stub + gateScript()], {
    encoding: 'utf8',
    env: {
      ...process.env,
      REPO: 'owner/repo', PR: '7', HEAD: 'abc123',
      GH_FIXTURE: reviews.map((line) => line + '\n').join(''),
      GH_FAIL: opts.apiFails ? '1' : '',
    },
  });
  return { code: result.status, out: (result.stdout ?? '') + (result.stderr ?? '') };
}

test('no review on the head commit fails the check', { skip: !haveBash }, () => {
  const r = gate([]);
  assert.equal(r.code, 1);
  assert.match(r.out, /No review on the latest commit/);
});

test('a review with a summary passes, whatever its state but a request for changes', { skip: !haveBash }, () => {
  assert.equal(gate(['2026-10-15T12:00:00Z COMMENTED owner 1']).code, 0);
  assert.equal(gate(['2026-10-15T12:00:00Z APPROVED reviewer 1']).code, 0);
  assert.equal(gate(['2026-10-15T12:00:00Z CHANGES_REQUESTED reviewer 1']).code, 1);
});

test('the newest submitted review decides, even when an older review has the higher id', { skip: !haveBash }, () => {
  // Draft 100 was started first and submitted last; 101 was submitted in between.
  const r = gate(['2026-10-15T12:02:00Z CHANGES_REQUESTED a 100', '2026-10-15T12:01:00Z COMMENTED b 101']);
  assert.equal(r.code, 1);
  assert.match(r.out, /requests changes/);
  // And the reverse: the newest submission clears an older request for changes.
  assert.equal(gate(['2026-10-15T12:01:00Z CHANGES_REQUESTED a 101', '2026-10-15T12:02:00Z COMMENTED b 100']).code, 0);
});

test('a request for changes in the same second as the newest review fails the check', { skip: !haveBash }, () => {
  assert.equal(gate(['2026-10-15T12:02:00Z COMMENTED a 5', '2026-10-15T12:02:00Z CHANGES_REQUESTED b 4']).code, 1);
  assert.equal(gate(['2026-10-15T12:02:00Z CHANGES_REQUESTED b 4', '2026-10-15T12:02:00Z COMMENTED a 5']).code, 1);
});

test('a failed API call is reported as one, not as a missing review', { skip: !haveBash }, () => {
  const r = gate(['2026-10-15T12:00:00Z COMMENTED owner 1'], { apiFails: true });
  assert.equal(r.code, 1);
  assert.match(r.out, /Could not read the reviews/);
  assert.doesNotMatch(r.out, /No review on the latest commit/);
});

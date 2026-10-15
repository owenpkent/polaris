// The Reviewed status (.github/workflows/review-gate.yml) decides from the reviews on the head commit
// whether a pull request may merge. These tests run the workflow's own shell step with a stand-in
// for gh, under the shell options Actions uses (bash -eo pipefail): reading the reviews prints the
// lines the real call's --jq filter would print, and setting the status prints what was sent. So
// the ordering, the decision, and the status call are tested as written, without the network.
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

// WSL's bash.exe can come first on PATH on Windows, and it does not pass the environment through,
// so only a bash that sees a variable set here runs these tests.
const haveBash = spawnSync('bash', ['-c', 'test "$GATE_PROBE" = yes'], { env: { ...process.env, GATE_PROBE: 'yes' } }).status === 0;

// `gh api -X POST .../statuses/<sha> -f state=... -f context=... -f description=...` prints one
// STATUS line, on stderr because the script discards what the real call prints; any other
// `gh api` call is the review read.
const STUB = `gh() {
  if [ "$2" = "-X" ]; then
    local path="$4"; shift 4; local fields=""
    while [ $# -gt 0 ]; do if [ "$1" = "-f" ]; then fields="$fields|$2"; fi; shift; done
    echo "STATUS $path$fields" >&2
    [ -z "$GH_STATUS_FAIL" ] || { echo "gh: HTTP 403" >&2; return 1; }
    return 0
  fi
  if [ -n "$GH_FAIL" ]; then echo "gh: HTTP 502" >&2; return 1; fi
  printf "%s" "$GH_FIXTURE"
}
`;

function gate(reviews: string[], opts: { apiFails?: boolean; statusFails?: boolean } = {}) {
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', STUB + gateScript()], {
    encoding: 'utf8',
    env: {
      ...process.env,
      REPO: 'owner/repo', PR: '7', HEAD: 'abc123', RUN_URL: 'https://example.invalid/run',
      GH_FIXTURE: reviews.map((line) => line + '\n').join(''),
      GH_FAIL: opts.apiFails ? '1' : '',
      GH_STATUS_FAIL: opts.statusFails ? '1' : '',
    },
  });
  const out = (result.stdout ?? '') + (result.stderr ?? '');
  const status = out.match(/^STATUS (.*)$/m)?.[1];
  return { code: result.status, out, status, state: status?.match(/\|state=(\w+)/)?.[1] };
}

test('the status goes to the head commit, under the name branch protection requires', { skip: !haveBash }, () => {
  const r = gate(['2026-10-15T12:00:00Z COMMENTED owner 1']);
  assert.equal(r.code, 0);
  assert.match(r.status!, /^repos\/owner\/repo\/statuses\/abc123\|/);
  assert.match(r.status!, /\|context=Reviewed\|/);
  assert.match(r.status!, /\|target_url=https:\/\/example\.invalid\/run$/);
});

test('no review on the head commit sets failure, and the job itself succeeds', { skip: !haveBash }, () => {
  const r = gate([]);
  assert.equal(r.code, 0);
  assert.equal(r.state, 'failure');
  assert.match(r.out, /No review on the latest commit/);
});

test('a review with a summary sets success, whatever its state but a request for changes', { skip: !haveBash }, () => {
  assert.equal(gate(['2026-10-15T12:00:00Z COMMENTED owner 1']).state, 'success');
  assert.equal(gate(['2026-10-15T12:00:00Z APPROVED reviewer 1']).state, 'success');
  assert.equal(gate(['2026-10-15T12:00:00Z CHANGES_REQUESTED reviewer 1']).state, 'failure');
});

test('the newest submitted review decides, even when an older review has the higher id', { skip: !haveBash }, () => {
  // Draft 100 was started first and submitted last; 101 was submitted in between.
  const r = gate(['2026-10-15T12:02:00Z CHANGES_REQUESTED a 100', '2026-10-15T12:01:00Z COMMENTED b 101']);
  assert.equal(r.state, 'failure');
  assert.match(r.out, /requests changes/);
  // And the reverse: the newest submission clears an older request for changes.
  assert.equal(gate(['2026-10-15T12:01:00Z CHANGES_REQUESTED a 101', '2026-10-15T12:02:00Z COMMENTED b 100']).state, 'success');
});

test('a request for changes in the same second as the newest review sets failure', { skip: !haveBash }, () => {
  assert.equal(gate(['2026-10-15T12:02:00Z COMMENTED a 5', '2026-10-15T12:02:00Z CHANGES_REQUESTED b 4']).state, 'failure');
  assert.equal(gate(['2026-10-15T12:02:00Z CHANGES_REQUESTED b 4', '2026-10-15T12:02:00Z COMMENTED a 5']).state, 'failure');
});

test('a failed review read sets error and fails the job, never reporting a missing review', { skip: !haveBash }, () => {
  const r = gate(['2026-10-15T12:00:00Z COMMENTED owner 1'], { apiFails: true });
  assert.equal(r.code, 1);
  assert.equal(r.state, 'error');
  assert.match(r.out, /Could not read the reviews/);
  assert.doesNotMatch(r.out, /No review on the latest commit/);
});

test('a token that cannot set the status is a warning, and the decision is still printed', { skip: !haveBash }, () => {
  const r = gate(['2026-10-15T12:00:00Z COMMENTED owner 1'], { statusFails: true });
  assert.equal(r.code, 0);
  assert.equal(r.state, 'success');
  assert.match(r.out, /::warning::Could not set the Reviewed status/);
});

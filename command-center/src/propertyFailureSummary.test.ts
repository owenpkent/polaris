// scripts/property-failure-summary.mjs turns a property-test log into the `tail` step output the
// nightly workflow puts in its failure issue. The review of #111 showed the shell pipeline it
// replaces could glue the closing delimiter to a truncated line, or die of SIGPIPE before writing
// it, so the runner then dropped the output. These tests run the script the way the workflow
// does, with GITHUB_OUTPUT set, and read the result back as the runner does: a `name<<DELIM`
// line, the text, and DELIM alone on a line, within the byte budget, whatever the log holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', '..', 'scripts', 'property-failure-summary.mjs');
const MAX = 6000;

/** Runs the script on `log` and returns the record it appended to GITHUB_OUTPUT, parsed as the runner parses it. */
function run(log: string | null, extraArgs: string[] = []): { status: number | null; name: string; delimiter: string; text: string; raw: string } {
  const dir = mkdtempSync(join(tmpdir(), 'polaris-summary-'));
  try {
    const logFile = join(dir, 'property-tests.log');
    if (log !== null) writeFileSync(logFile, log);
    const out = join(dir, 'output.txt');
    writeFileSync(out, 'earlier=1\n');
    const r = spawnSync(process.execPath, [SCRIPT, logFile, ...extraArgs], { env: { ...process.env, GITHUB_OUTPUT: out }, encoding: 'utf8' });
    const raw = readFileSync(out, 'utf8').slice('earlier=1\n'.length);
    const lines = raw.split('\n');
    const head = /^([^<]+)<<(\S+)$/.exec(lines[0]);
    assert.ok(head, `first line is name<<DELIM, got ${JSON.stringify(lines[0])}`);
    const closing = lines.indexOf(head[2], 1);
    assert.ok(closing > 0, 'the delimiter closes the record on a line of its own');
    assert.equal(closing, lines.length - 2, 'nothing follows the closing delimiter but the final newline');
    const text = lines.slice(1, closing).join('\n');
    assert.ok(!text.includes(head[2]), 'the delimiter does not occur in the text');
    return { status: r.status, name: head[1], delimiter: head[2], text, raw };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const failure = (n: number, example: string) => [
  `✖ property: rule ${n} (3.2ms)`,
  `  Error: property failed: seed=${n} path=12:3`,
  `  Property failed after 7 tests`,
  `  Counterexample: ${example}`,
  `  Shrunk 4 time(s)`,
  '',
].join('\n');

test('a short failing log comes through whole, with the matching lines first and the last lines after', () => {
  const log = `ℹ seed: 1\n${failure(1, '["a"]')}ℹ tests 3\nℹ fail 1\n`;
  const r = run(log);
  assert.equal(r.status, 0);
  assert.equal(r.name, 'tail');
  assert.match(r.text, /^2: ✖ property: rule 1/m);
  assert.match(r.text, /^3: {3}Error: property failed: seed=1 path=12:3/m);
  assert.match(r.text, /--- last lines ---/);
  assert.match(r.text, /ℹ fail 1$/);
  assert.ok(Buffer.byteLength(r.text) <= MAX);
});

test('one 7000-character counterexample is cut inside the budget and the record still closes', () => {
  const r = run(failure(1, 'x'.repeat(7000)));
  assert.equal(r.status, 0);
  assert.ok(Buffer.byteLength(r.text) <= MAX, `${Buffer.byteLength(r.text)} bytes`);
  assert.match(r.text, /more characters\)/);
  assert.match(r.text, /^4: {3}Counterexample: x+ \.\.\. \(\d+ more characters\)$/m);
  assert.doesNotMatch(r.text, /x{1001}/, 'no line keeps more than the per-line cap');
});

test('300 repeated failures are cut on whole lines, say how many were left out, and keep the last lines', () => {
  const log = Array.from({ length: 300 }, (_, i) => failure(i, `[${i}]`)).join('') + 'ℹ fail 300\n';
  const r = run(log);
  assert.equal(r.status, 0);
  assert.ok(Buffer.byteLength(r.text) <= MAX, `${Buffer.byteLength(r.text)} bytes`);
  assert.match(r.text, /^\.\.\. \(\d+ more lines in the log artifact\)$/m);
  assert.match(r.text, /ℹ fail 300$/);
  for (const line of r.text.split('\n')) assert.ok(!/^\d+: {3}Counterexample: \[\d*$/.test(line), `a line was cut mid-way: ${line}`);
});

test('a log that contains delimiter-shaped lines and no newline at the end still parses', () => {
  const r = run('CC_EOF\ntail<<CC_EOF\nCC_EOF_0123456789abcdef\nnot ok 1\nError: x');
  assert.equal(r.status, 0);
  assert.match(r.delimiter, /^CC_EOF_[0-9a-f]{16}$/);
  assert.match(r.text, /^4: not ok 1$/m);
  assert.match(r.text, /Error: x$/);
});

test('a missing log, or an empty one, is a summary that says so, never a failed step', () => {
  const missing = run(null);
  assert.equal(missing.status, 0);
  assert.match(missing.text, /^\(no summary: /);
  const empty = run('');
  assert.equal(empty.status, 0);
  assert.match(empty.text, /--- last lines ---/);
});

test('the name and budget can be set, and the budget holds', () => {
  const r = run(failure(1, 'y'.repeat(500)).repeat(20), ['--name', 'summary', '--max-bytes', '1500']);
  assert.equal(r.name, 'summary');
  assert.ok(Buffer.byteLength(r.text) <= 1500, `${Buffer.byteLength(r.text)} bytes`);
});

test('the workflow calls the script from command-center and exits with the test status, not the summary step', () => {
  const workflow = readFileSync(join(here, '..', '..', '.github', 'workflows', 'nightly-properties.yml'), 'utf8');
  assert.match(workflow, /^\s+node \.\.\/scripts\/property-failure-summary\.mjs property-tests\.log$/m);
  assert.match(workflow, /status=\$\{PIPESTATUS\[0\]\}[\s\S]*exit "\$status"/);
  assert.doesNotMatch(workflow, /head -c|<<CC_EOF/, 'the shell pipeline the script replaces is gone');
});

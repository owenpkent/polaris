// Runs one Jazzer.js target:   node fuzz/run.mjs <target> [seconds]        (npm run fuzz -- <target>)
// Replays one input:           node fuzz/run.mjs repro <target> <file>    (npm run fuzz:repro)
// Minimizes a corpus:          node fuzz/run.mjs merge <target> [corpus-dir]  (npm run fuzz:merge)
//
// The time budget also comes from FUZZ_SECONDS (default 60). The evolved corpus lives in
// fuzz/.corpus/<target>/ (untracked) and is seeded from the committed fuzz/corpus/<target>/;
// crashing inputs land in fuzz/crashes/<target>/. A dictionary at fuzz/dict/<target>.dict, when
// present, is passed with -dict. Targets are fuzz/targets/<target>.fuzz.ts; see CONTRIBUTING.md,
// "Coverage-guided fuzzing".
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { root } from './bundle.mjs';

const require = createRequire(import.meta.url);
const mode = ['merge', 'repro'].includes(process.argv[2]) ? process.argv[2] : 'fuzz';
const args = mode === 'fuzz' ? process.argv.slice(2) : process.argv.slice(3);
const target = args[0];
const seconds = mode === 'fuzz' ? Number(args[1] ?? process.env.FUZZ_SECONDS ?? 60) : 1;
const sourceFile = path.join(root, 'fuzz/targets', `${target}.fuzz.ts`);
const targetFile = path.join(root, 'fuzz/.out', `${target}.fuzz.cjs`);
if (!target || !existsSync(sourceFile)) {
  console.error('usage: node fuzz/run.mjs [merge|repro] <target> [seconds|corpus-dir|file]; targets are fuzz/targets/*.fuzz.ts');
  process.exit(2);
}
// Whole seconds, at least one: libFuzzer reads -max_total_time=0 as no limit at all, so a
// fractional budget rounded down would run forever.
if (!Number.isInteger(seconds) || seconds < 1) {
  console.error(`invalid time budget: ${args[1] ?? process.env.FUZZ_SECONDS} (whole seconds, at least 1)`);
  process.exit(2);
}

const build = spawnSync(process.execPath, [path.join(root, 'fuzz/build.mjs')], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

const jazzer = require.resolve('@jazzer.js/core/dist/cli.js');
// An async target must not run in sync mode: Jazzer.js would drop its promises unawaited.
const isAsync = /export\s+async\s+function\s+fuzz\b/.test(readFileSync(sourceFile, 'utf8'));
// Instrument only our own bundles (fuzz/bundle.mjs keeps packages external).
const common = [
  ...(isAsync ? [] : ['--sync']),
  // Per-input timeout. Jazzer hands libFuzzer its own -timeout from this option (default 5 s).
  '--timeout=10000',
  '--includes', path.join('fuzz', '.out') + path.sep,
];
const run = (jazzerArgs, fuzzerArgs) => spawnSync(process.execPath, [jazzer, targetFile, ...jazzerArgs, '--', ...fuzzerArgs], { cwd: root, stdio: 'inherit' });

if (mode === 'repro') {
  // One input, once: the way to confirm a crash file from fuzz/crashes or an issue is fixed.
  const file = args[1] && path.resolve(args[1]);
  if (!file || !existsSync(file)) {
    console.error('usage: node fuzz/run.mjs repro <target> <input-file>');
    process.exit(2);
  }
  process.exit(run([file, ...common], ['-runs=1', '-rss_limit_mb=2048']).status ?? 1);
}

const evolved = path.join(root, 'fuzz/.corpus', target);
if (mode === 'merge') {
  // libFuzzer -merge=1 copies into the FIRST directory only the inputs that add coverage over the
  // rest, so the result is a fresh minimized corpus in fuzz/.corpus-min/<target>/ (untracked). The
  // inputs are the committed seeds and the evolved corpus, or the directory given as the last
  // argument (for example a cached nightly corpus downloaded and unpacked).
  const fresh = path.join(root, 'fuzz/.corpus-min', target);
  rmSync(fresh, { recursive: true, force: true });
  mkdirSync(fresh, { recursive: true });
  const inputs = args[1] ? [path.resolve(args[1])] : [path.join(root, 'fuzz/corpus', target), evolved].filter((d) => existsSync(d));
  const result = run([fresh, ...inputs, ...common], ['-merge=1', '-rss_limit_mb=2048']);
  if (result.status === 0 && readdirSync(fresh).length === 0) {
    // On Windows libFuzzer may record no coverage features for any input, so it keeps nothing. Do
    // not trust an empty result; run the merge on Linux.
    console.error(`merge kept no inputs for ${target}: either the corpus adds no coverage or this platform does not report it`);
    process.exit(3);
  }
  process.exit(result.status ?? 1);
}

const crashes = path.join(root, 'fuzz/crashes', target);
mkdirSync(evolved, { recursive: true });
mkdirSync(crashes, { recursive: true });
const seeds = path.join(root, 'fuzz/corpus', target);
if (existsSync(seeds)) cpSync(seeds, evolved, { recursive: true, force: false });

// A dictionary of format tokens (libFuzzer syntax) lets the mutator splice in keywords it would
// take far longer to invent byte by byte. Optional: a target without one runs as before.
const dictFile = path.join(root, 'fuzz/dict', `${target}.dict`);
// libFuzzer writes the input it stopped on to the artifact prefix: crash-*, timeout-*, oom-*,
// slow-unit-*, or leak-*.
const findings = () => readdirSync(crashes).filter((name) => /^(crash|timeout|oom|slow-unit|leak)-/.test(name));
const known = new Set(findings());
// The fuzzer's stderr is passed through as it comes, and its end is kept, to see whether libFuzzer
// reached its closing line ("Done N runs in S second(s)") before the process ended.
const child = spawn(process.execPath, [jazzer, targetFile, evolved, ...common, '--',
  `-max_total_time=${seconds}`,
  '-rss_limit_mb=2048',
  `-artifact_prefix=${crashes}${path.sep}`,
  ...(existsSync(dictFile) ? [`-dict=${dictFile}`] : []),
], { cwd: root, stdio: ['inherit', 'inherit', 'pipe'] });
let tail = '';
child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
  tail = (tail + chunk).slice(-4000);
});
const result = await new Promise((resolve) => {
  child.on('error', () => resolve({ status: 1, signal: null }));
  child.on('close', (status, signal) => resolve({ status, signal }));
});
// On most nights of 2026-11 the pattern target's process was ended by SIGABRT after libFuzzer
// had printed "Done N runs": node aborted while exiting, in libuv (uv__io_poll: Assertion
// `errno == EINTR' failed), and the job failed with nothing found. An abort is such an end, and
// not a failure, only when libFuzzer had printed that closing line and no input was written. An
// abort part way through, any other signal, and any exit code of the process's own (a finding
// is 77) stay failures.
const newFindings = findings().filter((name) => !known.has(name));
if (result.status === null && result.signal === 'SIGABRT' && newFindings.length === 0 && /Done \d+ runs in \d+ second/.test(tail)) {
  const message = `fuzz: the ${target} process aborted while exiting, after libFuzzer finished and with no input written to ${crashes}. Not a finding; treated as a pass.`;
  console.error(process.env.GITHUB_ACTIONS ? `::warning::${message}` : message);
  process.exit(0);
}
process.exit(result.status ?? 1);

// Writes the part of a property-test log a reader needs first (the failing properties and their
// counterexamples, then the last lines) as one GitHub Actions step output, for the issue the
// nightly run files (.github/workflows/nightly-properties.yml).
//
//   node scripts/property-failure-summary.mjs <log-file> [--name tail] [--max-bytes 6000]
//
// The output is appended to $GITHUB_OUTPUT when that is set, else printed, in the runner's
// multiline form: `name<<DELIM`, the text, and DELIM alone on its own line. Three things keep
// it valid whatever the log holds, which a shell pipeline did not (PR #111 review): the text is
// cut on whole lines and never past the byte budget, the closing delimiter is one the text does
// not contain and is always preceded by a newline, and nothing here can fail with SIGPIPE or
// change the test command's exit status. Never exits non-zero: a summary that cannot be made is
// written as the summary.
import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';

// The spec reporter marks a failed test with ✖; the TAP reporter says "not ok".
const MATCH = /✖|property failed|not ok|Counterexample|Shrunk|Error:/;
const LAST_LINES = 40;
/** A single log line longer than this is cut, so one huge counterexample cannot use the budget alone. */
const MAX_LINE = 1000;

function parseArgs(argv) {
  const opts = { file: null, name: 'tail', maxBytes: 6000 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--name') opts.name = argv[++i];
    else if (argv[i] === '--max-bytes') opts.maxBytes = Number(argv[++i]);
    else opts.file = argv[i];
  }
  return opts;
}

const clip = (line) => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)} ... (${line.length - MAX_LINE} more characters)` : line);

/** As many whole lines as fit in `budget` bytes, with a note for the ones left out. */
function fit(lines, budget) {
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const bytes = Buffer.byteLength(line, 'utf8') + 1;
    if (used + bytes > budget) {
      kept.push(`... (${lines.length - kept.length} more lines in the log artifact)`);
      break;
    }
    kept.push(line);
    used += bytes;
  }
  return kept;
}

/** The summary text for a log, bounded to `maxBytes` after the cut lines are counted. */
export function summarize(log, maxBytes) {
  const lines = log.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const hits = lines.map((l, i) => [i + 1, l]).filter(([, l]) => MATCH.test(l)).map(([n, l]) => `${n}: ${clip(l)}`);
  const last = lines.slice(-LAST_LINES).map(clip);
  // Half the budget each, less the headers; the notes fit() adds are short and counted.
  const header = '--- last lines ---';
  const half = Math.floor((maxBytes - header.length - 2) / 2) - 80;
  const parts = [...fit(hits, half), header, ...fit(last, half)];
  return parts.join('\n');
}

/** A delimiter the text does not contain, on no line of it. */
export function delimiterFor(text) {
  for (;;) {
    const d = `CC_EOF_${randomBytes(8).toString('hex')}`;
    if (!text.includes(d)) return d;
  }
}

/** The complete multiline output record for GITHUB_OUTPUT. */
export function outputRecord(name, text) {
  const d = delimiterFor(text);
  return `${name}<<${d}\n${text}\n${d}\n`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  let text;
  try {
    if (!opts.file) throw new Error('no log file was named');
    text = summarize(readFileSync(opts.file, 'utf8'), opts.maxBytes);
  } catch (e) {
    text = `(no summary: ${e instanceof Error ? e.message : String(e)})`;
  }
  const record = outputRecord(opts.name, text);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, record);
  else process.stdout.write(record);
}

// Run as a script; importing the functions above (for a test) does not write anything.
if (process.argv[1]?.endsWith('property-failure-summary.mjs')) main();

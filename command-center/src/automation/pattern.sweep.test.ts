// A bounded sweep of the pattern engine against JavaScript's RegExp: every pattern that can be
// written from a small set of tokens, up to a few tokens long, against every short input from a
// small alphabet. Where the engine accepts a pattern and RegExp does too, the two must give the
// same answer on every input (the promise at the top of pattern.ts).
//
// The nightly fuzz target (fuzz/targets/pattern.fuzz.ts) makes the same comparison on random
// inputs, and took nights to reach `[\s--z]` and `\00`. A sweep reaches every short pattern of its
// alphabet in about two seconds, on every push. The idea is RE2's exhaustive tester
// (re2/testing/exhaustive_tester.cc).
//
// The sweep is deterministic, so it tells nothing new from one night to the next: it is for the
// day pattern.ts changes. The bounds here keep the normal suite fast. After a change to
// pattern.ts, run the deeper one once (longer patterns, every token, more inputs; minutes):
//   CC_PATTERN_SWEEP=deep node --test src/automation/pattern.sweep.test.ts
//
// THE RULE when a sweep fails: fix pattern.ts (make it agree, or refuse the syntax with a
// PatternError), and add the pattern it printed as a named regression test in pattern.test.ts.
// Never drop a token from an alphabet to make a sweep pass.
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PatternError, compilePattern } from './pattern.ts';

const DEEP = process.env.CC_PATTERN_SWEEP === 'deep';
const pick = <T>(normal: T, deep: T): T => (DEEP ? deep : normal);

/** Every sequence of `min` to `max` tokens, joined, shortest first. */
function* sequences(tokens: readonly string[], max: number, min = 0): Generator<string> {
  for (let length = min; length <= max; length++) {
    const index = new Array<number>(length).fill(0);
    for (;;) {
      let out = '';
      for (const i of index) out += tokens[i];
      yield out;
      let at = length - 1;
      while (at >= 0 && ++index[at] === tokens.length) index[at--] = 0;
      if (at < 0) break;
    }
  }
}

function* each(source: Iterable<string>, wrap: (s: string) => string[]): Generator<string> {
  for (const s of source) yield* wrap(s);
}

interface Tally { patterns: number; refused: number; oursOnly: number; compared: number }

/**
 * Compares the engine with RegExp on every pattern, against `inputs` and whatever `more` adds for
 * that pattern. A pattern the engine refuses is not compared, and neither is one RegExp refuses
 * (the promise covers what both accept). An error from the engine that is not a PatternError
 * fails the test.
 */
function sweep(t: TestContext, patterns: Iterable<string>, inputs: readonly string[], more?: (pattern: string) => string[]): Tally {
  const tally: Tally = { patterns: 0, refused: 0, oursOnly: 0, compared: 0 };
  const shown: string[] = [];
  let disagreements = 0;
  for (const source of patterns) {
    tally.patterns++;
    let ours;
    try {
      ours = compilePattern(source);
    } catch (err) {
      if (!(err instanceof PatternError)) throw new Error(`pattern ${JSON.stringify(source)}: ${String(err)}`, { cause: err });
      tally.refused++;
      continue;
    }
    let theirs: RegExp;
    try {
      theirs = new RegExp(source);
    } catch {
      tally.oursOnly++;
      continue;
    }
    let reported = false;
    for (const input of more ? [...inputs, ...more(source)] : inputs) {
      tally.compared++;
      const mine = ours.test(input);
      if (mine === theirs.test(input)) continue;
      disagreements++;
      // One line per pattern is enough to fix it: the first input it disagrees on.
      if (!reported && shown.length < 25) shown.push(`${JSON.stringify(source)} on ${JSON.stringify(input)}: ours ${mine}, RegExp ${!mine}`);
      reported = true;
    }
  }
  t.diagnostic(`${tally.patterns} patterns: ${tally.refused} refused, ${tally.oursOnly} accepted here and refused by RegExp, ${tally.compared} comparisons`);
  assert.equal(disagreements, 0, `${disagreements} disagreements with RegExp, the first of them:\n${shown.join('\n')}`);
  return tally;
}

/** A sweep that compares almost nothing has stopped testing: every pattern refused, or no inputs. */
const FLOOR = 50_000;

test('sweep: groups, alternation, quantifiers, and anchors', (t) => {
  const all = ['a', 'b', '.', '(', '(?:', ')', '|', '*', '+', '?', '^', '$'];
  const core = ['a', 'b', '(', ')', '|', '*', '?', '^', '$'];
  const inputs = [...sequences(['a', 'b', '\n'], 3)];
  // Normally every token to three, and the core of them to five, which is where a quantified
  // group of two branches starts to fit.
  const patterns = pick(
    (function* () { yield* sequences(all, 3, 1); yield* sequences(core, 5, 4); })(),
    sequences(all, 6, 1),
  );
  assert.ok(sweep(t, patterns, inputs).compared > FLOOR);
});

test('sweep: word boundaries', (t) => {
  const tokens = ['a', ' ', '_', '\\b', '\\B', '^', '$', '(', ')', '|', '?'];
  const inputs = [...sequences(['a', ' ', '_'], 3)];
  assert.ok(sweep(t, sequences(tokens, pick(4, 6), 1), inputs).compared > FLOOR);
});

test('sweep: character classes', (t) => {
  // Members of a class, in every order: literals, a dash wherever it can stand, a caret, the class
  // escapes (which cannot be either end of a range), NUL and a digit after it, an escaped dash and
  // bracket, and in the deep sweep a backspace, an open bracket, and an early close.
  const members = pick(
    ['a', 'z', '-', '^', '0', '\\d', '\\W', '\\s', '\\0', '\\-', '\\]', '5'],
    ['a', 'm', 'z', '-', '^', '0', '\\d', '\\W', '\\s', '\\0', '\\-', '\\]', '5', '\\b', '[', ']'],
  );
  const inputs = ['', 'a', 'b', 'm', 'z', '-', '^', '0', '5', ' ', '\0', '_', 'A', '\\', ']', '[', '\b', 'd', 'W', 's', '\n', ',', '~',
    // After a "]" member the rest of the pattern is literal text: two-character inputs reach it.
    ...pick([], ['a]', 'az', '-]', 'a-', '0]', ']]'])];
  const wrap = pick(
    (body: string) => [`[${body}]`, `[^${body}]`],
    (body: string) => [`[${body}]`, `[^${body}]`, `^[${body}]+$`],
  );
  // Four members is the least that holds `\s--z` and `\s-a-z`, the shapes of the 2026-11 finding.
  assert.ok(sweep(t, each(sequences(members, pick(4, 5)), wrap), inputs).compared > FLOOR);
});

test('sweep: escapes', (t) => {
  // What can follow a backslash: digits (NUL, octal, backreferences), x and u with hex digits, c
  // with a letter, the class and boundary letters, and punctuation.
  const after = ['0', '1', '7', '8', '9', 'x', 'u', 'c', 'a', 'f', 'A', 'b', 'd', 'k', '{', '}', '<', '>', '-', '.', '/'];
  const units = ['\0', '0', '1', '7', '8', '9', 'a', 'f', 'A', '\x01', '\x07', '\b', '\n', 'x', 'u', 'c', '\\', 'k', '{', '}', '<', '>', '-', '.', '/',
    '\x0f', '\x10', '\x11', '\x17', '\x18', '\xaa', '\xaf', '\xff', ' ', 'પ'];
  // An escape is one character, or one and the text after it (`\08` is NUL then "8"): every unit
  // alone, and pairs of the ones that follow a NUL or stand for a digit.
  const inputs = pick(
    ['', ...units, ...sequences(['\0', '0', '1', '8', 'a', '\x01', 'x', '\\'], 2, 2)],
    [...sequences(units, 2)],
  );
  const patterns = each(sequences(after, pick(3, 4), 1), (body) => [`\\${body}`, `^\\${body}$`, `[\\${body}]`]);
  assert.ok(sweep(t, patterns, inputs).compared > FLOOR);
});

test('sweep: repeat counts and braces', (t) => {
  // A brace is a count only in the shapes {n}, {n,} and {n,m}; anywhere else RegExp reads it as
  // text. So each pattern also runs against its own quantifier as text, after one atom and two.
  //
  // Every count here is small on purpose, and that is for the reference, not the engine: RegExp
  // backtracks, and `(|a){22}` costs it about 2^22 steps on an input that does not match. (The fuzz
  // target runs RegExp in a worker with a budget for the same reason.) So the well-formed counts
  // go up to 3, with leading zeros ({0002}, the 2026-11-09 finding), and the free sequences have
  // only the digits 0 and 1, which reach 11.
  const braces = (function* () {
    const shapes: string[] = ['{,,}', '{1,2,3}', '{ 1}', '{1 }', '{a}', '{-1}', '{1,-2}'];
    for (const n of ['', '0', '1', '2', '00', '02', '0002']) {
      shapes.push(`{${n}}`);
      for (const m of ['', '0', '1', '3', '03']) shapes.push(`{${n},${m}}`);
    }
    for (const shape of shapes) for (const after of ['', '?', '*', '+', '{', '}', '??']) yield `${shape}${after}`;
  })();
  const raw = ['{', '}', ',', '0', '1', '*', '+', '?'];
  const quantifiers = pick(
    (function* () { yield* braces; yield* sequences(raw, 3, 1); })(),
    (function* () { yield* braces; yield* sequences(raw, 6, 1); })(),
  );
  const atoms = ['a', '(a|b)', '.', '(|a)', '[ab]'];
  const patterns = (function* () {
    for (const q of quantifiers) for (const atom of atoms) { yield `^${atom}${q}$`; yield `${atom}${q}b`; }
  })();
  const inputs = [...sequences(['a', 'b'], pick(4, 5))];
  const asText = (pattern: string): string[] => {
    const brace = pattern.indexOf('{');
    if (brace < 0) return [];
    const q = pattern.slice(brace, -1);
    return [`a${q}`, `aa${q}`, `b${q}`, `a${q}b`];
  };
  assert.ok(sweep(t, patterns, inputs, asText).compared > FLOOR);
});

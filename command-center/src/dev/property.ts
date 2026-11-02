// The one way a property test runs fast-check, so every *.property.test.ts reads the same
// environment and reports a failure the same way.
//
// Normal suite: a fixed seed and a modest run count, so the same inputs run every time and
// test:fast stays fast. Deep run (.github/workflows/nightly-properties.yml): CC_PROPERTY_SEED and
// CC_PROPERTY_RUNS come from the environment, so a nightly run explores new inputs.
//
// THE RULE when a property fails: fix the bug, then add the shrunk input as a named regression
// test next to the code (a plain example in the matching *.test.ts, so it runs on every push).
// Do not loosen the property, and do not rerun until it passes. Replay a failure with the seed and
// path it prints:
//   CC_PROPERTY_SEED=<seed> CC_PROPERTY_PATH=<path> node --test src/<dir>/<name>.property.test.ts
import fc from 'fast-check';

export const SEED = Number(process.env.CC_PROPERTY_SEED ?? 20260921);
export const RUNS = Number(process.env.CC_PROPERTY_RUNS ?? 60);
const PATH = process.env.CC_PROPERTY_PATH;

/** Runs a property, and on failure throws a message that names the seed and path to replay it. */
export function check<T>(arb: fc.Arbitrary<T>, predicate: (value: T) => void): void {
  const details = fc.check(
    fc.property(arb, (value) => { predicate(value); }),
    { seed: SEED, numRuns: RUNS, path: PATH, endOnFailure: false },
  );
  if (details.failed) {
    throw new Error(`property failed: seed=${details.seed} path=${details.counterexamplePath}\n${fc.defaultReportMessage(details)}`);
  }
}

/**
 * Arbitrary text as a third party might write it: any Unicode, including the characters that
 * trip parsers (backticks, brackets, control characters, line separators, a byte order mark).
 */
export const anyText = (maxLength = 400): fc.Arbitrary<string> => fc.oneof(
  { weight: 3, arbitrary: fc.string({ unit: 'grapheme', maxLength }) },
  { weight: 2, arbitrary: fc.string({ unit: fc.constantFrom('`', '#', '-', '*', '[', ']', ' ', 'x', 'X', '\n', '\r', '\t', '\u00a0', '\u2028', '\ufeff', '"', ',', ';', '\\', 'a'), maxLength }) },
  { weight: 1, arbitrary: fc.string({ unit: 'binary', maxLength }) },
);

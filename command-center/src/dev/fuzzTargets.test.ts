// The Jazzer.js fuzz targets (fuzz/targets/*.fuzz.ts) run every night in .github/workflows/fuzz.yml,
// not here. This test keeps them runnable between nights: every target loads, accepts the empty
// input, every committed seed in fuzz/corpus/<target>/, and a handful of random inputs without
// throwing, and the nightly workflow's matrix names every target. A target that breaks on a push
// is caught here, not discovered at 3 a.m. as a false crash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..', '..');
const targetsDir = join(packageRoot, 'fuzz', 'targets');
const targets = readdirSync(targetsDir).filter((f) => f.endsWith('.fuzz.ts')).map((f) => f.slice(0, -'.fuzz.ts'.length)).sort();

test('there are fuzz targets, each with a seed corpus and a dictionary', () => {
  assert.ok(targets.length >= 8, `found ${targets.join(', ')}`);
  for (const t of targets) {
    const corpus = join(packageRoot, 'fuzz', 'corpus', t);
    assert.ok(existsSync(corpus) && readdirSync(corpus).length > 0, `${t} has no seeds in fuzz/corpus/${t} (npm run fuzz:seeds)`);
    assert.ok(existsSync(join(packageRoot, 'fuzz', 'dict', `${t}.dict`)), `${t} has no dictionary in fuzz/dict`);
  }
});

test('the nightly workflow fuzzes every target', () => {
  const workflow = readFileSync(join(packageRoot, '..', '.github', 'workflows', 'fuzz.yml'), 'utf8');
  const matrix = /target:\s*\[([^\]]*)\]/.exec(workflow);
  assert.ok(matrix, 'fuzz.yml has no target matrix');
  const listed = matrix[1].split(',').map((s) => s.trim()).filter(Boolean).sort();
  assert.deepEqual(listed, targets);
});

// Review of #112: RegExp, the reference the pattern target compares against, backtracks for
// longer than the fuzzer's per-input timeout on this 35-byte input, after Polaris's own matcher
// has answered in under a millisecond. The reference now runs under its own budget, so the target
// finishes quickly and reports nothing: a slow reference is not a finding about our code.
test('the pattern target finishes fast when the reference RegExp would hang', async () => {
  const { fuzz } = await import('../../fuzz/targets/pattern.fuzz.ts');
  const { oracleTimeouts, stopOracle } = await import('../../fuzz/targets/regexOracle.ts');
  const before = oracleTimeouts();
  const start = Date.now();
  fuzz(Buffer.from(`^((a*)*)*$\0${'a'.repeat(23)}!`));
  assert.ok(Date.now() - start < 3000, `took ${Date.now() - start} ms`);
  assert.equal(oracleTimeouts(), before + 1, 'the reference ran out of budget once');
  // The oracle still compares where RegExp answers in time, with a fresh worker after the timeout.
  fuzz(Buffer.from('^a+b$\0aaab'));
  await stopOracle();
});

test('the regex oracle answers true, false, syntax, or timeout, and never throws', async () => {
  const { regexWithin, stopOracle } = await import('../../fuzz/targets/regexOracle.ts');
  assert.equal(regexWithin('^a+$', 'aaa'), true);
  assert.equal(regexWithin('^a+$', 'aab'), false);
  assert.equal(regexWithin('(', 'x'), 'syntax');
  assert.equal(regexWithin('^((a*)*)*$', `${'a'.repeat(23)}!`, 100), 'timeout');
  assert.equal(regexWithin('^a+$', 'aaa'), true, 'a new worker serves the call after a timeout');
  await stopOracle();
});

test('every committed rules seed is a rule the validator accepts', async () => {
  const { validateRuleDefinition } = await import('../automation/rules.ts');
  const dir = join(packageRoot, 'fuzz', 'corpus', 'rules');
  const triggers = new Set<string>();
  for (const name of readdirSync(dir)) {
    const def = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    const result = validateRuleDefinition(def);
    assert.ok(result.ok, `${name} is rejected: ${result.errors.join('; ')}`);
    triggers.add(def.trigger.type);
  }
  assert.ok(triggers.has('event'), 'no rules seed has an event trigger');
  assert.ok(triggers.has('schedule'), 'no rules seed has a schedule trigger');
});

for (const t of targets) {
  test(`fuzz target ${t} runs on the empty input, its seeds, and random bytes`, async () => {
    const mod = await import(`../../fuzz/targets/${t}.fuzz.ts`) as { fuzz: (data: Buffer) => void | Promise<void> };
    assert.equal(typeof mod.fuzz, 'function', `${t} exports no fuzz function`);
    await mod.fuzz(Buffer.alloc(0));
    const corpus = join(packageRoot, 'fuzz', 'corpus', t);
    for (const seed of readdirSync(corpus)) await mod.fuzz(readFileSync(join(corpus, seed)));
    for (let i = 0; i < 20; i++) await mod.fuzz(randomBytes(1 + (i * 7) % 64));
  });
}

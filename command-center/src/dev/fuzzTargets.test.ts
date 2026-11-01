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

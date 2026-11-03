import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteForCmd, realExec } from './exec.ts';

test('quoteForCmd passes safe arguments through, quotes spaces, and refuses cmd metacharacters', () => {
  assert.equal(quoteForCmd('run'), 'run');
  assert.equal(quoteForCmd('C:\\dev\\polaris\\dist'), 'C:\\dev\\polaris\\dist');
  assert.equal(quoteForCmd('--prefix=a/b-c.d'), '--prefix=a/b-c.d');
  assert.equal(quoteForCmd('C:\\Program Files\\x'), '"C:\\Program Files\\x"');
  for (const bad of ['50%', 'say "hi"', 'a^b', 'a&b', 'a|b', 'a<b', 'a>b', 'a!b', 'a\nb', 'a\rb']) {
    assert.throws(() => quoteForCmd(bad), /cmd\.exe metacharacter/, bad);
  }
});

test('realExec with raw keeps stdout byte for byte, and without it the line collector folds a CR', async () => {
  const script = 'process.stdout.write(Buffer.from([0x61,0x0d,0x0a,0xff,0x00,0x62]))';
  const bytes = Buffer.from([0x61, 0x0d, 0x0a, 0xff, 0x00, 0x62]);
  const raw = await realExec()(process.execPath, ['-e', script], { raw: true });
  assert.equal(raw.code, 0, raw.stderr);
  assert.deepEqual(Buffer.from(raw.stdout, 'latin1'), bytes);
  const folded = await realExec()(process.execPath, ['-e', script]);
  assert.notDeepEqual(Buffer.from(folded.stdout, 'latin1'), bytes);
  assert.ok(!folded.stdout.includes('\r'));
});

test('realExec hands an argument with an ampersand over whole when the program is not a .cmd shim', async () => {
  const path = 'C:\\Work & Projects\\polaris\\dist.next';
  const r = await realExec('win32')(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', path]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, path);
});

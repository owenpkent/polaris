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

test('realExec hands an argument with an ampersand over whole when the program is not a .cmd shim', async () => {
  const path = 'C:\\Work & Projects\\polaris\\dist.next';
  const r = await realExec('win32')(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', path]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, path);
});

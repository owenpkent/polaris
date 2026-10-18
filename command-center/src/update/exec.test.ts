import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteForCmd } from './exec.ts';

test('quoteForCmd passes safe arguments through, quotes spaces, and refuses cmd metacharacters', () => {
  assert.equal(quoteForCmd('run'), 'run');
  assert.equal(quoteForCmd('C:\\dev\\polaris\\dist'), 'C:\\dev\\polaris\\dist');
  assert.equal(quoteForCmd('--prefix=a/b-c.d'), '--prefix=a/b-c.d');
  assert.equal(quoteForCmd('C:\\Program Files\\x'), '"C:\\Program Files\\x"');
  for (const bad of ['50%', 'say "hi"', 'a^b', 'a&b', 'a|b', 'a<b', 'a>b', 'a!b', 'a\nb', 'a\rb']) {
    assert.throws(() => quoteForCmd(bad), /cmd\.exe metacharacter/, bad);
  }
});

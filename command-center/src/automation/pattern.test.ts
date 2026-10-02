import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PatternError, compilePattern } from './pattern.ts';

// Where a pattern is accepted, the engine must answer exactly as JavaScript does. Each entry is
// a pattern and the inputs it is checked against, and the expected answer comes from RegExp.
const AGREEMENT: [string, string[]][] = [
  ['abc', ['abc', 'xabcx', 'ab', '', 'ABC']],
  ['^abc$', ['abc', 'xabc', 'abcx', 'abc\n']],
  ['a.c', ['abc', 'a\nc', 'ac', 'a c', 'a\u{1F600}c']],
  ['a|b|c', ['a', 'c', 'd', '']],
  ['^(ab|cd)+$', ['abcd', 'abcdab', 'abc', '']],
  ['^(a|aa)+$', ['aaaa', 'aaaaa!', 'a']],
  ['(a+)+b', ['aaab', 'aaa', 'b']],
  ['(a*)*b', ['b', 'aaab', 'aaa']],
  ['x*', ['', 'xxx', 'y']],
  ['^x*$', ['', 'xxx', 'y', 'xxy']],
  ['^x+$', ['', 'x', 'xxx', 'xy']],
  ['^x?y$', ['y', 'xy', 'xxy']],
  ['^a{3}$', ['aaa', 'aa', 'aaaa']],
  ['^a{2,}$', ['a', 'aa', 'aaaaa']],
  ['^a{2,4}$', ['a', 'aa', 'aaaa', 'aaaaa']],
  ['^a{2,4}?$', ['aa', 'aaaaa']],
  ['^(ab){2}$', ['abab', 'ab', 'ababab']],
  ['a{', ['a{', 'a']],
  ['a{1,x}', ['a{1,x}', 'a']],
  ['^\\d+$', ['123', '12a', '']],
  ['\\D', ['123', '12a']],
  ['^\\w+$', ['hello_1', 'hello world', 'café']],
  ['\\W', ['abc', 'a c']],
  ['\\s', ['a b', 'ab', 'a b', 'a﻿b', 'a​b']],
  ['^\\S+$', ['abc', 'a b']],
  ['\\bword\\b', ['a word here', 'swordfish', 'word', 'words']],
  ['\\Bord', ['sword', 'ord', 'w ord']],
  ['^[abc]+$', ['abcabc', 'abd', '']],
  ['^[^abc]+$', ['xyz', 'xaz', '']],
  ['^[a-z0-9_-]+$', ['snake_case-1', 'Snake', 'a-']],
  ['^[a-]+$', ['a-a', 'ab']],
  ['^[-a]+$', ['-a-', 'b']],
  ['^[\\d\\s]+$', ['1 2 3', '1a2']],
  ['^[\\]\\\\]+$', [']\\', 'a']],
  ['^[\\-x]+$', ['-x', 'y']],
  ['[]', ['a', '']],
  ['^[^]$', ['a', '\n', 'ab']],
  ['[\\b]', ['a\bb', 'ab']],
  ['\\.', ['a.b', 'ab']],
  ['\\(\\)', ['()', '(']],
  ['\\/', ['a/b', 'ab']],
  ['\\n', ['a\nb', 'ab']],
  ['\\t\\r\\f\\v', ['\t\r\f\v', '\t']],
  ['\\x41', ['A', 'a']],
  ['\\u00e9', ['café', 'cafe']],
  ['\\0', ['a\0b', 'ab']],
  ['(?:ab)+c', ['ababc', 'abc', 'ac']],
  ['(?<name>ab)c', ['abc', 'ac']],
  ['^$', ['', 'a']],
  ['$', ['', 'abc']],
  ['^', ['', 'abc']],
  ['()', ['', 'a']],
  ['a||b', ['', 'c', 'a']],
  ['^urgent: .+$', ['urgent: fix it', 'urgent:', 'not urgent: x']],
  ['(fix|bug)\\s*#?\\d+', ['fix #12', 'bug42', 'fix', 'Fix 12']],
  ['^\u{1F600}+$', ['\u{1F600}\u{1F600}', '\u{1F600}a']],
];

test('the engine agrees with RegExp on every supported pattern', () => {
  let checked = 0;
  for (const [pattern, inputs] of AGREEMENT) {
    const compiled = compilePattern(pattern);
    const native = new RegExp(pattern);
    for (const input of inputs) {
      assert.equal(compiled.test(input), native.test(input), `/${pattern}/ against ${JSON.stringify(input)}`);
      checked++;
    }
  }
  assert.ok(checked > 150);
});

test('a pattern that would make RegExp backtrack for hours answers at once', () => {
  const inputs = ['a'.repeat(80) + '!', 'a'.repeat(1000), 'a'.repeat(1000) + '!'];
  const patterns = ['^(a|aa)+$', '^(a+)+$', '^(a*)*$', '^(a|a)*$', '(a|aa)*b', '^(a?){40}a{40}$', '(x+x+)+y'];
  const started = Date.now();
  for (const pattern of patterns) {
    const compiled = compilePattern(pattern);
    for (const input of inputs) compiled.test(input);
  }
  // On a backtracking engine the first pattern alone would not finish in the life of the process.
  assert.ok(Date.now() - started < 2000, `matching took ${Date.now() - started}ms`);
  assert.equal(compilePattern('^(a|aa)+$').test('a'.repeat(80) + '!'), false);
  assert.equal(compilePattern('^(a|aa)+$').test('a'.repeat(80)), true);
});

test('unsupported syntax is refused with a message that names it', () => {
  const cases: [string, RegExp][] = [
    ['(a)\\1', /backreference/],
    ['(?=a)b', /lookahead/],
    ['(?!a)b', /lookahead/],
    ['(?<=a)b', /lookbehind/],
    ['(?<!a)b', /lookbehind/],
    ['\\p{L}', /\\p/],
    ['\\k<x>', /unsupported escape/],
    ['a{101}', /101|above 100/],
    ['a{5,2}', /out of order/],
    ['*a', /nothing to repeat/],
    ['a**', /nothing to repeat/],
    ['^*', /quantifier cannot follow/],
    ['(ab', /missing/],
    ['ab)', /unmatched/],
    ['[abc', /unexpectedly/],
    ['[z-a]', /range out of order/],
    ['\\x4', /hex digits/],
    ['a\\', /unexpectedly/],
  ];
  for (const [pattern, message] of cases) {
    assert.throws(() => compilePattern(pattern), (e: unknown) => e instanceof PatternError && message.test(e.message), `expected /${pattern}/ to be refused`);
  }
});

test('nested repeat counts cannot expand the pattern without limit', () => {
  assert.throws(() => compilePattern('((a{100}){100}){100}'), /too complex/);
  assert.doesNotThrow(() => compilePattern('(a{10}){10}'));
});

test('a compiled pattern is reused, and the cache stays bounded', () => {
  assert.equal(compilePattern('reuse-me'), compilePattern('reuse-me'));
  for (let i = 0; i < 500; i++) compilePattern(`fill-${i}`);
  assert.ok(compilePattern('after-fill').test('after-fill'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAgentName } from './agentName.ts';

test('normalizeAgentName accepts letters, digits, spaces, hyphens, underscores, and dots', () => {
  assert.equal(normalizeAgentName('scribe'), 'scribe');
  assert.equal(normalizeAgentName('Claude Code'), 'Claude Code');
  assert.equal(normalizeAgentName('ops-2'), 'ops-2');
  assert.equal(normalizeAgentName('ops_2.bot'), 'ops_2.bot');
});

test('normalizeAgentName trims surrounding whitespace before validating', () => {
  assert.equal(normalizeAgentName('  scribe  '), 'scribe');
});

test('normalizeAgentName rejects an empty or whitespace-only name', () => {
  assert.equal(normalizeAgentName(''), null);
  assert.equal(normalizeAgentName('   '), null);
});

test('normalizeAgentName rejects a name over 40 characters', () => {
  assert.equal(normalizeAgentName('a'.repeat(40)), 'a'.repeat(40));
  assert.equal(normalizeAgentName('a'.repeat(41)), null);
});

test('normalizeAgentName rejects control characters that survive the trim (not just leading/trailing whitespace)', () => {
  assert.equal(normalizeAgentName('scri\nbe'), null);
  assert.equal(normalizeAgentName('scri\tbe'), null);
  assert.equal(normalizeAgentName('scri\u0000be'), null);
});

test('normalizeAgentName trims a trailing newline away like any other whitespace', () => {
  // trim() removes it before the character class is ever checked, same as a trailing space.
  assert.equal(normalizeAgentName('scribe\n'), 'scribe');
});

test('normalizeAgentName rejects angle brackets and other punctuation outside the allowed set', () => {
  assert.equal(normalizeAgentName('<script>'), null);
  assert.equal(normalizeAgentName('scribe@bot'), null);
  assert.equal(normalizeAgentName('scribe!'), null);
  assert.equal(normalizeAgentName('a/b'), null);
});

test('normalizeAgentName rejects anything that is not a string', () => {
  assert.equal(normalizeAgentName(undefined), null);
  assert.equal(normalizeAgentName(null), null);
  assert.equal(normalizeAgentName(42), null);
  assert.equal(normalizeAgentName(['scribe']), null);
  assert.equal(normalizeAgentName({ name: 'scribe' }), null);
});

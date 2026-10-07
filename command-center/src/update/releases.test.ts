import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTES_MAX_LENGTH, parseReleaseTarget, releaseTag, releaseTagVersion, releaseTags, sanitizeNotes } from './releases.ts';

test('a release tag is v + exactly MAJOR.MINOR.PATCH', () => {
  assert.equal(releaseTagVersion('v2.1.0'), '2.1.0');
  assert.equal(releaseTagVersion('v10.20.30'), '10.20.30');
  for (const bad of ['2.1.0', 'V2.1.0', 'v2.1', 'v2.1.0-rc.1', 'v2.1.0+build', 'release-2.1.0', 'v2.1.0.1', 'latest', '', 'v']) {
    assert.equal(releaseTagVersion(bad), null, JSON.stringify(bad));
  }
  assert.equal(releaseTag('2.1.0'), 'v2.1.0');
});

test('releaseTags keeps the release tags only, newest first, and sorts as numbers', () => {
  const tags = releaseTags(['v2.9.0', 'not-a-release', 'v2.10.0', 'v1.0.0', 'v2.10.0-rc.1', '', 'v3.0.0', 'v2.9.0 ']);
  assert.deepEqual(tags.map((t) => t.tag), ['v3.0.0', 'v2.10.0', 'v2.9.0', 'v2.9.0', 'v1.0.0']);
  assert.deepEqual(tags[1], { tag: 'v2.10.0', version: '2.10.0' });
  assert.deepEqual(releaseTags([]), []);
});

test('--to accepts v2.1.0 or 2.1.0 and nothing else', () => {
  assert.equal(parseReleaseTarget('v2.1.0'), '2.1.0');
  assert.equal(parseReleaseTarget('2.1.0'), '2.1.0');
  assert.equal(parseReleaseTarget(' v2.1.0 '), '2.1.0');
  for (const bad of ['vv2.1.0', '2.1', 'main', 'v2.1.0-rc.1', '', 'latest']) assert.equal(parseReleaseTarget(bad), null, JSON.stringify(bad));
});

test('sanitizeNotes strips control characters, keeps tabs and newlines, and caps the length', () => {
  assert.equal(sanitizeNotes('Release one\r\n\r\nSecond\tpara\u0001\u001b[31mred\u009f\u007f\n'), 'Release one\n\nSecond\tpara[31mred');
  assert.equal(sanitizeNotes('  padded  '), 'padded');
  assert.equal(sanitizeNotes(''), '');
  const long = 'x'.repeat(NOTES_MAX_LENGTH + 100);
  assert.equal(sanitizeNotes(long).length, NOTES_MAX_LENGTH);
  const emoji = `${'y'.repeat(NOTES_MAX_LENGTH - 1)}\u{1F600}`;
  const cut = sanitizeNotes(emoji);
  assert.equal(cut.length, NOTES_MAX_LENGTH - 1, 'a surrogate pair is dropped whole, never split');
  assert.ok(!/[\uD800-\uDFFF]$/.test(cut));
  assert.equal(sanitizeNotes('Fixes \u{1F600} emoji pass through'), 'Fixes \u{1F600} emoji pass through');
});

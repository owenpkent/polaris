import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, isNewerVersion, isVersion, packageVersion, parseVersion } from './version.ts';

test('a version is exactly MAJOR.MINOR.PATCH', () => {
  assert.deepEqual(parseVersion('2.0.0'), [2, 0, 0]);
  assert.deepEqual(parseVersion('10.20.30'), [10, 20, 30]);
  for (const bad of ['v2.0.0', '2.0', '2', '2.0.0.1', '2.0.0-rc.1', '2.0.0+build', ' 2.0.0', '2.0.0\n', '2.a.0', '', 'latest']) {
    assert.equal(parseVersion(bad), null, JSON.stringify(bad));
    assert.equal(isVersion(bad), false, JSON.stringify(bad));
  }
});

test('versions compare as number tuples, not as strings', () => {
  assert.equal(compareVersions([2, 10, 0], [2, 9, 0]), 1);
  assert.equal(compareVersions([2, 9, 0], [2, 10, 0]), -1);
  assert.equal(compareVersions([3, 0, 0], [2, 99, 99]), 1);
  assert.equal(compareVersions([2, 0, 1], [2, 0, 0]), 1);
  assert.equal(compareVersions([2, 0, 0], [2, 0, 0]), 0);
});

test('only a well-formed, strictly newer target is newer', () => {
  assert.equal(isNewerVersion('2.1.0', '2.0.0'), true);
  assert.equal(isNewerVersion('2.10.0', '2.9.3'), true);
  assert.equal(isNewerVersion('2.0.0', '2.0.0'), false, 'the same is not newer');
  assert.equal(isNewerVersion('1.9.9', '2.0.0'), false, 'older is not newer');
  assert.equal(isNewerVersion('v2.1.0', '2.0.0'), false, 'a malformed target is never installed');
  assert.equal(isNewerVersion('2.1.0', 'dev'), false, 'a malformed running version is never replaced');
  assert.equal(isNewerVersion('2.1.0-rc.1', '2.0.0'), false, 'a prerelease is not a version');
});

test('packageVersion reads the version field and nothing else', () => {
  assert.equal(packageVersion('{"name":"x","version":"2.0.0"}'), '2.0.0');
  assert.equal(packageVersion('{"name":"x"}'), null);
  assert.equal(packageVersion('{"version":2}'), null);
  assert.equal(packageVersion('not json'), null);
  assert.equal(packageVersion('null'), null);
});

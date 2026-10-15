import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultDbPath, loadConfig, realDbPaths } from './config.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('CC_TZ sets the timezone', () => {
  assert.equal(loadConfig({ CC_TZ: 'America/Chicago' }).timezone, 'America/Chicago');
});

test('without CC_TZ the timezone is the machine\'s own', () => {
  assert.equal(loadConfig({}).timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
});

test('a CC_TZ the machine does not know stops the start and names the variable', () => {
  assert.throws(() => loadConfig({ CC_TZ: 'America/Chicgo' }), /CC_TZ.*America\/Chicgo/);
});

test('CC_UPDATE_RESTART is carried as typed, trimmed, and unset when empty', () => {
  assert.equal(loadConfig({ CC_UPDATE_RESTART: ' systemd:polaris ' }).updateRestart, 'systemd:polaris');
  assert.equal(loadConfig({ CC_UPDATE_RESTART: '' }).updateRestart, undefined);
  assert.equal(loadConfig({}).updateRestart, undefined);
});

test('the default database is polaris.db, or constellation.db only when that is all there is (pre-rename install)', () => {
  const root = join('r', 'repo');
  const current = resolve(root, 'command-center', 'data', 'polaris.db');
  const legacy = resolve(root, 'command-center', 'data', 'constellation.db');
  assert.equal(defaultDbPath(root, () => false), current);
  assert.equal(defaultDbPath(root, (p) => p === legacy), legacy);
  assert.equal(defaultDbPath(root, () => true), current);
  assert.deepEqual(realDbPaths(root), [current, legacy]);
  const tmp = mkdtempSync(join(tmpdir(), 'cc-config-'));
  try {
    mkdirSync(join(tmp, 'command-center', 'data'), { recursive: true });
    writeFileSync(join(tmp, 'command-center', 'data', 'constellation.db'), '');
    assert.equal(loadConfig({ CC_REPO_ROOT: tmp }).dbPath, resolve(tmp, 'command-center', 'data', 'constellation.db'));
    assert.equal(loadConfig({ CC_REPO_ROOT: tmp, CC_DB: join(tmp, 'x.db') }).dbPath, resolve(tmp, 'x.db'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

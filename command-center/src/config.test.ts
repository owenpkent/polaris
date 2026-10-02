import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.ts';

test('CC_TZ sets the timezone', () => {
  assert.equal(loadConfig({ CC_TZ: 'America/Chicago' }).timezone, 'America/Chicago');
});

test('without CC_TZ the timezone is the machine\'s own', () => {
  assert.equal(loadConfig({}).timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
});

test('a CC_TZ the machine does not know stops the start and names the variable', () => {
  assert.throws(() => loadConfig({ CC_TZ: 'America/Chicgo' }), /CC_TZ.*America\/Chicgo/);
});

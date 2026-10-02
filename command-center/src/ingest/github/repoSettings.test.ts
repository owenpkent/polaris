import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../../core/index.ts';
import { getRepoSettings, isReadChecklistsEnabled, isSyncIssuesEnabled, setRepoSettings } from './repoSettings.ts';

test('an unconfigured repo defaults to both switches on', () => {
  const store = openStore(':memory:');
  assert.deepEqual(getRepoSettings(store, 'owenpkent/Octavium'), { syncIssues: true, readChecklists: true });
  assert.equal(isSyncIssuesEnabled(store, 'owenpkent/Octavium'), true);
  assert.equal(isReadChecklistsEnabled(store, 'owenpkent/Octavium'), true);
});

test('setRepoSettings persists a partial patch and leaves the other switch at its default', () => {
  const store = openStore(':memory:');
  const result = setRepoSettings(store, 'owenpkent/Octavium', { syncIssues: false });
  assert.deepEqual(result, { syncIssues: false, readChecklists: true });
  assert.deepEqual(getRepoSettings(store, 'owenpkent/Octavium'), { syncIssues: false, readChecklists: true });
});

test('lookups are case-insensitive on the full name', () => {
  const store = openStore(':memory:');
  setRepoSettings(store, 'OwenPKent/Octavium', { readChecklists: false });
  assert.equal(isReadChecklistsEnabled(store, 'owenpkent/octavium'), false);
  assert.equal(isReadChecklistsEnabled(store, 'OWENPKENT/OCTAVIUM'), false);
});

test('settings for one repo do not affect another', () => {
  const store = openStore(':memory:');
  setRepoSettings(store, 'owenpkent/Octavium', { syncIssues: false, readChecklists: false });
  assert.deepEqual(getRepoSettings(store, 'owenpkent/Other'), { syncIssues: true, readChecklists: true });
});

test('a second patch merges onto the first rather than replacing it', () => {
  const store = openStore(':memory:');
  setRepoSettings(store, 'owenpkent/Octavium', { syncIssues: false });
  setRepoSettings(store, 'owenpkent/Octavium', { readChecklists: false });
  assert.deepEqual(getRepoSettings(store, 'owenpkent/Octavium'), { syncIssues: false, readChecklists: false });
});

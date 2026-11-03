import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../core/index.ts';
import { importTasks } from './taskImport.ts';

test('importTasks: the new tasks go to the top in the file order, and the result reports where they landed', () => {
  const store = openStore(':memory:');
  const before = store.createTask({ title: 'Made before the import' });
  const result = importTasks(store, 'First line\nSecond line\nThird line\n');
  const titles = store.searchTasks({ orderBy: 'position' }).map((t) => t.title);
  assert.deepEqual(titles, ['First line', 'Second line', 'Third line', 'Made before the import']);
  const positions = result.created.map((t) => t.position);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'the returned tasks carry their final numbers');
  assert.ok(positions.every((p) => p < before.position));
});

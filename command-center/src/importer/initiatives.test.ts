import { dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openStore } from '../core/index.ts';
import { importInitiativeFiles } from './initiatives.ts';

const here = dirname(fileURLToPath(import.meta.url));
const initiativesRepoRoot = join(here, 'fixtures', 'initiatives-repo');

const fresh = () => openStore(':memory:');

test('importInitiativeFiles: Tasks/Success Criteria become tasks with nested subtasks, README/_TEMPLATE skipped', () => {
  const store = fresh();
  const counts = importInitiativeFiles(store, initiativesRepoRoot);
  assert.equal(counts.created, 1); // only sample-initiative.md; README.md and _TEMPLATE.md are skipped
  assert.equal(store.listProjects({ includeArchived: true }).length, 1);

  const project = store.getProject('initiative-sample-initiative')!;
  assert.equal(project.category, 'initiative');
  const tasks = store.searchTasks({ projectId: project.id, sourceType: ['initiative_md'], limit: 200 });
  assert.equal(tasks.length, 5); // 4 under Tasks (incl. 1 nested) + 1 under Success Criteria

  const setUp = tasks.find((t) => t.title === 'Set up the fixture')!;
  assert.equal(setUp.status, 'done'); // was [x]
  const parent = tasks.find((t) => t.title === 'Write the parent task')!;
  const child = tasks.find((t) => t.title === 'Write the nested subtask')!;
  assert.equal(child.parentId, parent.id); // nested checkbox became a subtask
  assert.equal(parent.status, 'open');
});

test('importInitiativeFiles: re-import with no changes produces zero task.* events', () => {
  const store = fresh();
  importInitiativeFiles(store, initiativesRepoRoot);
  const before = store.lastEventId();
  const second = importInitiativeFiles(store, initiativesRepoRoot);
  assert.equal(second.tasks.created, 0);
  assert.equal(second.tasks.updated, 0);
  assert.equal(second.tasks.gone, 0);
  const kinds = store.eventsSince(before).map((e) => e.kind);
  assert.deepEqual(kinds.filter((k) => k.startsWith('task.')), []);
});

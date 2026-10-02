import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../core/index.ts';
import { importChecklistContent } from './todo.ts';

const TODO_V1 = [
  '# Fixture TODO',
  '',
  '## Phase 1',
  '',
  '- [x] Set up project scaffolding',
  '- [ ] Write the parser',
  '  - [ ] Handle nested checkboxes',
  '  - [x] Handle checked nested checkboxes',
  '- [ ] Ship the beta',
  '',
  '## Phase 2',
  '',
  '- [ ] Second phase item',
  '',
].join('\n');

function freshStoreWithProject() {
  const store = openStore(':memory:');
  const project = store.upsertProject({ slug: 'fixture-proj', name: 'Fixture Proj' });
  return { store, project };
}

test('importChecklistContent: creates tasks, assigns nearest heading as section, wires nested checkbox as subtask', () => {
  const { store, project } = freshStoreWithProject();
  const result = importChecklistContent(store, project, 'TODO.md', TODO_V1);
  assert.equal(result.created, 6);
  assert.equal(result.gone, 0);

  const tasks = store.searchTasks({ projectId: project.id, sourceType: ['todo_md'], limit: 50 });
  assert.equal(tasks.length, 6);

  const scaffolding = tasks.find((t) => t.title === 'Set up project scaffolding')!;
  assert.equal(scaffolding.status, 'done'); // owner-authored [x] bypasses the inbox

  const parser = tasks.find((t) => t.title === 'Write the parser')!;
  const nested = tasks.find((t) => t.title === 'Handle nested checkboxes')!;
  const nestedDone = tasks.find((t) => t.title === 'Handle checked nested checkboxes')!;
  assert.equal(nested.parentId, parser.id);
  assert.equal(nestedDone.parentId, parser.id);
  assert.equal(nested.status, 'open');
  assert.equal(nestedDone.status, 'done');

  const sections = store.listSections(project.id).map((s) => s.name).sort();
  assert.deepEqual(sections, ['Phase 1', 'Phase 2']);
  assert.equal(store.getTask(parser.id)!.sectionId, store.listSections(project.id).find((s) => s.name === 'Phase 1')!.id);
});

test('importChecklistContent: second import with unchanged content produces zero task.* events', () => {
  const { store, project } = freshStoreWithProject();
  importChecklistContent(store, project, 'TODO.md', TODO_V1);
  const before = store.lastEventId();
  const second = importChecklistContent(store, project, 'TODO.md', TODO_V1);
  assert.equal(second.created, 0);
  assert.equal(second.updated, 0);
  assert.equal(second.gone, 0);
  assert.equal(second.unchanged, 6);
  const kinds = store.eventsSince(before).map((e) => e.kind);
  assert.deepEqual(kinds.filter((k) => k.startsWith('task.')), []);
});

test('importChecklistContent: checking a box completes the task; unchecking a done box reopens it', () => {
  const { store, project } = freshStoreWithProject();
  importChecklistContent(store, project, 'TODO.md', TODO_V1);

  const toggled = TODO_V1
    .replace('- [ ] Ship the beta', '- [x] Ship the beta') // check it
    .replace('- [x] Set up project scaffolding', '- [ ] Set up project scaffolding'); // uncheck it

  const result = importChecklistContent(store, project, 'TODO.md', toggled);
  assert.equal(result.updated, 2); // content_hash changed for both lines (checked state is part of the hash)

  const tasks = store.searchTasks({ projectId: project.id, sourceType: ['todo_md'], limit: 50 });
  assert.equal(tasks.find((t) => t.title === 'Ship the beta')!.status, 'done');
  assert.equal(tasks.find((t) => t.title === 'Set up project scaffolding')!.status, 'open');
});

test('importChecklistContent: a line removed from the content drops (gone-sweeps) the task', () => {
  const { store, project } = freshStoreWithProject();
  importChecklistContent(store, project, 'TODO.md', TODO_V1);

  const withoutOne = TODO_V1.split('\n').filter((l) => !l.includes('Second phase item')).join('\n');
  const result = importChecklistContent(store, project, 'TODO.md', withoutOne);
  assert.equal(result.gone, 1);

  const secondPhase = store.searchTasks({ projectId: project.id, sourceType: ['todo_md'], limit: 50 }).find((t) => t.title === 'Second phase item');
  assert.equal(secondPhase!.status, 'dropped');
});

// ---------------------------------------------------------- multi-file checklist import

const MULTI_FILES: [file: string, content: string][] = [
  ['TODO.md', ['## Phase 1', '', '- [ ] Todo item'].join('\n')],
  ['README.md', ['## Setup', '', '- [ ] Readme item'].join('\n')],
  ['CLAUDE.md', ['- [ ] Claude item (no heading)'].join('\n')],
  ['docs/ROADMAP.md', ['## Later', '', '- [ ] Roadmap item'].join('\n')],
];

test('importChecklistContent: each file gets its own source id prefix, so two files in one project do not collide', () => {
  const store = openStore(':memory:');
  const project = store.upsertProject({ slug: 'octavium', name: 'Octavium' });
  const results = MULTI_FILES.map(([file, content]) => importChecklistContent(store, project, file, content));
  assert.ok(results.every((r) => r.created === 1));

  const tasks = store.searchTasks({ projectId: project.id, sourceType: ['todo_md'], limit: 50 });
  assert.equal(tasks.length, 4);
  assert.deepEqual(tasks.map((t) => t.title).sort(), ['Claude item (no heading)', 'Readme item', 'Roadmap item', 'Todo item'].sort());

  const roadmap = tasks.find((t) => t.title === 'Roadmap item')!;
  assert.ok(roadmap.sourceId!.startsWith('octavium:docs/ROADMAP.md:'));
  const readme = tasks.find((t) => t.title === 'Readme item')!;
  assert.equal(store.getTask(readme.id)!.sectionId, store.listSections(project.id).find((s) => s.name === 'Setup')!.id);
});

test('importChecklistContent: gone-sweep is scoped per file -- removing a checkbox from one file never drops another file\'s task', () => {
  const store = openStore(':memory:');
  const project = store.upsertProject({ slug: 'octavium', name: 'Octavium' });
  for (const [file, content] of MULTI_FILES) importChecklistContent(store, project, file, content);

  const readmeWithoutItem = ['## Setup', ''].join('\n'); // drop the README item
  const results = MULTI_FILES.map(([file, content]) =>
    importChecklistContent(store, project, file, file === 'README.md' ? readmeWithoutItem : content),
  );
  const readmeResult = results.find((r) => r.file === 'README.md')!;
  assert.equal(readmeResult.gone, 1);
  for (const r of results) if (r.file !== 'README.md') assert.equal(r.gone, 0);

  const tasks = store.searchTasks({ projectId: project.id, sourceType: ['todo_md'], status: ['open'], limit: 50 });
  assert.deepEqual(tasks.map((t) => t.title).sort(), ['Claude item (no heading)', 'Roadmap item', 'Todo item'].sort());
  const readmeTask = store.searchTasks({ projectId: project.id, sourceType: ['todo_md'], limit: 50 }).find((t) => t.title === 'Readme item')!;
  assert.equal(readmeTask.status, 'dropped');
});

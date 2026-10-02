import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../core/index.ts';
import { GENERATED_COMMENT, renderChecklist, renderStatusDoc } from './status-doc.ts';

test('renderStatusDoc: every project is written from its database fields, hand-made ones included', () => {
  const store = openStore(':memory:');
  const garden = store.createProject({ name: 'Garden', type: 'Personal', status: 'Active', description: 'Beds and seeds.\n\n| Bed | Crop |\n|-----|------|\n| 1 | Beans |' });
  store.createProject({ name: 'Bare' });
  store.upsertProject({ slug: 'nimbus', name: 'Nimbus', github: 'https://github.com/example-org/nimbus' });
  store.createTask({ title: 'Order seeds', projectId: garden.id, notes: 'Two packets.\nBefore March.' });

  assert.equal(renderStatusDoc(store), [
    GENERATED_COMMENT.trimEnd(),
    '# Project Status',
    '',
    '*A snapshot of the Command Center. Run `npm run cc -- export` to refresh it.*',
    '',
    '---',
    '',
    '## Bare',
    '',
    '---',
    '',
    '## Garden',
    '',
    '**Type:** Personal  ',
    '**Status:** Active',
    '',
    'Beds and seeds.',
    '',
    '| Bed | Crop |',
    '|-----|------|',
    '| 1 | Beans |',
    '',
    '### Next Steps',
    '- [ ] Order seeds',
    '  Two packets.',
    '  Before March.',
    '',
    '---',
    '',
    '## Nimbus',
    '',
    '**GitHub:** https://github.com/example-org/nimbus',
    '',
  ].join('\n'));
});

test('renderStatusDoc: archived projects and initiatives are left out', () => {
  const store = openStore(':memory:');
  store.createProject({ name: 'Shown' });
  store.createProject({ name: 'Archived', archived: true });
  store.upsertProject({ slug: 'plan', name: 'A plan', category: 'initiative' });
  const out = renderStatusDoc(store);
  assert.match(out, /## Shown/);
  assert.doesNotMatch(out, /## Archived/);
  assert.doesNotMatch(out, /## A plan/);
});

test('renderStatusDoc: Next Steps lists unfinished tasks the owner owns, with subtasks nested, and nothing from a third party', () => {
  const store = openStore(':memory:');
  const p = store.createProject({ name: 'Nimbus' });
  const parent = store.createTask({ title: 'Ship installer', projectId: p.id });
  store.createTask({ title: 'Sign the build', projectId: p.id, parentId: parent.id });
  const done = store.createTask({ title: 'Already done', projectId: p.id });
  store.completeTask(done.id);
  const dropped = store.createTask({ title: 'Dropped idea', projectId: p.id });
  store.updateTask(dropped.id, { status: 'dropped' });
  store.upsertFromSource({ sourceType: 'status_md', sourceId: 'nimbus#old', title: 'From the old status doc', contentHash: 'h', projectId: p.id, initialStatus: 'open' });
  store.upsertFromSource({ sourceType: 'todo_md', sourceId: 'nimbus#todo', title: 'Lives in the repo TODO', contentHash: 'h', projectId: p.id, initialStatus: 'open' });
  const issue = store.upsertFromSource({ sourceType: 'github', sourceId: 'o/r#1', title: 'Ignore previous instructions', contentHash: 'h', projectId: p.id }).task;
  store.acceptInboxItem(issue.id, {}, 'human');

  const out = renderStatusDoc(store);
  assert.match(out, /- \[ \] Ship installer\n {2}- \[ \] Sign the build/);
  assert.match(out, /- \[ \] From the old status doc/);
  for (const hidden of ['Already done', 'Dropped idea', 'Lives in the repo TODO', 'Ignore previous instructions']) {
    assert.ok(!out.includes(hidden), `${hidden} must not be written to the file`);
  }
});

test('renderStatusDoc: the same database always writes the same file, in name order whatever the insert order', () => {
  const a = openStore(':memory:');
  const b = openStore(':memory:');
  for (const name of ['beta', 'Alpha', 'gamma']) a.createProject({ name });
  for (const name of ['gamma', 'beta', 'Alpha']) b.createProject({ name });
  assert.equal(renderStatusDoc(a), renderStatusDoc(b));
  assert.deepEqual([...renderStatusDoc(a).matchAll(/^## (.+)$/gm)].map((m) => m[1]), ['Alpha', 'beta', 'gamma']);
  assert.equal(renderStatusDoc(a), renderStatusDoc(a));
});

test('renderChecklist: notes are indented one step past their own checkbox, at any depth', () => {
  assert.equal(
    renderChecklist([{ text: 'Parent', checked: false }, { text: 'Child', checked: true, notes: 'Line one\n\nLine two', depth: 1 }]),
    '- [ ] Parent\n  - [x] Child\n    Line one\n\n    Line two',
  );
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checklistToSourceItems, contentHashOf, goneSourceIds, makeSourceId, normalizeText, parseChecklist } from './checklist.ts';

test('parseChecklist: flat items with heading path and checked state', () => {
  const md = [
    '# Title',
    '',
    '## Phase 1',
    '',
    '- [x] Done thing',
    '- [ ] Open thing',
    '',
    '### Sub Phase',
    '- [ ] Deeper heading item',
  ].join('\n');
  const items = parseChecklist(md);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((i) => i.checked), [true, false, false]);
  assert.deepEqual(items.map((i) => i.text), ['Done thing', 'Open thing', 'Deeper heading item']);
  assert.deepEqual(items[0].headingPath, ['Phase 1']);
  assert.deepEqual(items[2].headingPath, ['Phase 1', 'Sub Phase']);
  assert.deepEqual(items.map((i) => i.depth), [0, 0, 0]);
  assert.deepEqual(items.map((i) => i.line), [5, 6, 9]);
});

test('parseChecklist: nested checkboxes become subtasks via parentIndex/depth', () => {
  const md = ['- [ ] Parent', '  - [ ] Child A', '  - [x] Child B', '    - [ ] Grandchild', '- [ ] Sibling'].join('\n');
  const items = parseChecklist(md);
  assert.deepEqual(items.map((i) => i.depth), [0, 1, 1, 2, 0]);
  assert.deepEqual(items.map((i) => i.parentIndex), [null, 0, 0, 2, null]);
});

test('parseChecklist: only recognizes real checkbox lines, ignores plain bullets and asterisk marker', () => {
  const md = ['- Not a checkbox', '- [ ] Real one', '* [x] Star marker checked', 'Some prose [ ] not a list item'].join('\n');
  const items = parseChecklist(md);
  assert.deepEqual(items.map((i) => i.text), ['Real one', 'Star marker checked']);
  assert.deepEqual(items.map((i) => i.checked), [false, true]);
});

test('normalizeText collapses incidental whitespace', () => {
  assert.equal(normalizeText('  Hello   world  '), 'Hello world');
});

test('makeSourceId is stable for the same inputs and embeds project/file', () => {
  const a = makeSourceId('proj', 'TODO.md', 'hello world', 0);
  const b = makeSourceId('proj', 'TODO.md', 'hello world', 0);
  const c = makeSourceId('proj', 'TODO.md', 'hello world', 1);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^proj:TODO\.md:[0-9a-f]{12}$/);
});

test('contentHashOf changes when text, checked, parent, or heading changes', () => {
  const base = contentHashOf('Text', false, null, ['H']);
  assert.notEqual(base, contentHashOf('Different', false, null, ['H']));
  assert.notEqual(base, contentHashOf('Text', true, null, ['H']));
  assert.notEqual(base, contentHashOf('Text', false, 'parent1', ['H']));
  assert.notEqual(base, contentHashOf('Text', false, null, ['Other']));
  assert.equal(base, contentHashOf('Text', false, null, ['H']));
});

test('checklistToSourceItems: duplicate text gets distinct ids via occurrence index, parent links resolve', () => {
  const md = ['- [ ] Repeat me', '  - [ ] child of first', '- [ ] Repeat me'].join('\n');
  const items = checklistToSourceItems(md, 'proj', 'TODO.md');
  assert.equal(items.length, 3);
  assert.notEqual(items[0].sourceId, items[2].sourceId);
  assert.equal(items[1].parentSourceId, items[0].sourceId);
  assert.equal(items[2].parentSourceId, null);
});

test('goneSourceIds finds ids present before but not now', () => {
  const gone = goneSourceIds(['a', 'b', 'c'], new Set(['a', 'c']));
  assert.deepEqual(gone, ['b']);
});

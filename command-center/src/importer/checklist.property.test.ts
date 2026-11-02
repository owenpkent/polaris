// Property tests for the checklist parser (importer/checklist.ts). It reads README, todo and docs
// files from tracked GitHub repos, so it must cope with any text and keep the structure it reports
// consistent: line numbers, parent links, depths, and stable source ids.
//
// The harness is in dev/property.ts. Replay a failure with the seed and path it prints:
//   CC_PROPERTY_SEED=<seed> CC_PROPERTY_PATH=<path> node --test src/importer/checklist.property.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { check, anyText } from '../dev/property.ts';
import { checklistToSourceItems, goneSourceIds, normalizeText, parseChecklist } from './checklist.ts';

const lineCount = (text: string): number => text.split(/\r\n|\r|\n/).length;

// Checklist-shaped text is far likelier to reach the nesting and notes code than random text.
const checklistish = fc.array(
  fc.tuple(fc.constantFrom('', '  ', '    ', '\t'), fc.constantFrom('- [ ] ', '- [x] ', '* [X] ', '## ', '### ', '```', '   ', ''), fc.string({ maxLength: 12 })),
  { maxLength: 30 },
).map((rows) => rows.map(([indent, mark, text]) => `${indent}${mark}${text}`).join('\n'));
const text = fc.oneof(anyText(), checklistish);

test('property: parseChecklist never throws', () => {
  check(text, (t) => { parseChecklist(t); });
});

test('property: item lines are 1-based, strictly increasing, and inside the document', () => {
  check(text, (t) => {
    const lines = parseChecklist(t).map((i) => i.line);
    const max = lineCount(t);
    lines.forEach((l, i) => {
      assert.ok(l >= 1 && l <= max, `line ${l} outside 1..${max}`);
      if (i > 0) assert.ok(l > lines[i - 1], 'lines must increase');
    });
  });
});

test('property: parent links point backwards and depth is the parent depth plus one', () => {
  check(text, (t) => {
    const items = parseChecklist(t);
    items.forEach((item, i) => {
      if (item.parentIndex === null) return assert.equal(item.depth, 0);
      assert.ok(item.parentIndex >= 0 && item.parentIndex < i, 'parent must come earlier');
      assert.equal(item.depth, items[item.parentIndex].depth + 1);
    });
  });
});

test('property: a heading path is a list of non-empty strings', () => {
  check(text, (t) => {
    for (const item of parseChecklist(t)) {
      assert.ok(Array.isArray(item.headingPath));
      assert.ok(item.headingPath.every((h) => typeof h === 'string' && h.length > 0));
    }
  });
});

test('property: an item is checked only when its source line has [x] or [X]', () => {
  check(text, (t) => {
    const lines = t.split(/\r\n|\r|\n/);
    for (const item of parseChecklist(t)) {
      if (item.checked) assert.match(lines[item.line - 1], /\[[xX]\]/);
    }
  });
});

test('property: source items are deterministic and their source ids are unique in a file', () => {
  check(text, (t) => {
    const a = checklistToSourceItems(t, 'proj', 'TODO.md');
    assert.deepEqual(checklistToSourceItems(t, 'proj', 'TODO.md'), a);
    assert.equal(new Set(a.map((i) => i.sourceId)).size, a.length);
  });
});

test('property: appending a plain line never removes or reorders existing items', () => {
  check(text, (t) => {
    const before = parseChecklist(t);
    const after = parseChecklist(`${t}\nplain text`);
    assert.deepEqual(after.map((i) => i.text), before.map((i) => i.text));
  });
});

test('property: normalizeText is idempotent', () => {
  check(anyText(), (t) => {
    assert.equal(normalizeText(normalizeText(t)), normalizeText(t));
  });
});

test('property: goneSourceIds is exactly the previous ids that are not in the current set', () => {
  check(fc.tuple(fc.array(fc.string({ maxLength: 4 }), { maxLength: 12 }), fc.array(fc.string({ maxLength: 4 }), { maxLength: 12 })), ([prev, current]) => {
    const set = new Set(current);
    assert.deepEqual(goneSourceIds(prev, set), prev.filter((id) => !set.has(id)));
  });
});

// Property tests for the bulk task text parser (importer/taskText.ts), which reads text the owner
// pasted or an agent sent: lines, bullets, checkboxes, or CSV. Whatever it is given, it must return
// rows with a title, a parent that exists, and a line number that does not run backwards.
//
// The harness is in dev/property.ts. Replay a failure with the seed and path it prints:
//   CC_PROPERTY_SEED=<seed> CC_PROPERTY_PATH=<path> node --test src/importer/taskText.property.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { check, anyText } from '../dev/property.ts';
import { MAX_IMPORT_ROWS, parseTaskText, type ImportFormat } from './taskText.ts';

const formats: ImportFormat[] = ['auto', 'csv', 'lines'];
const csvish = fc.array(fc.array(fc.string({ maxLength: 8 }), { minLength: 1, maxLength: 5 }).map((c) => c.join(',')), { maxLength: 10 })
  .map((rows) => `title,priority,due\n${rows.join('\n')}`);
const input = fc.tuple(fc.oneof(anyText(), csvish), fc.constantFrom(...formats));

test('property: parseTaskText never throws', () => {
  check(input, ([t, f]) => { parseTaskText(t, f); });
});

test('property: rows are bounded, titled, and have valid parents', () => {
  check(input, ([t, f]) => {
    const { rows, format } = parseTaskText(t, f);
    assert.ok(format === 'csv' || format === 'lines');
    assert.ok(rows.length <= MAX_IMPORT_ROWS);
    rows.forEach((row, i) => {
      assert.ok(row.title.trim().length > 0, 'title must not be blank');
      assert.ok(row.parentIndex === null || (row.parentIndex >= 0 && row.parentIndex < i), 'parent must come earlier');
    });
  });
});

test('property: row lines start at 1 and never go backwards; error lines are not negative', () => {
  check(input, ([t, f]) => {
    const { rows, errors } = parseTaskText(t, f);
    rows.forEach((row, i) => {
      assert.ok(row.line >= 1);
      if (i > 0) assert.ok(row.line >= rows[i - 1].line);
    });
    assert.ok(errors.every((e) => e.line >= 0));
  });
});

test('property: in lines format every title is a piece of the source text', () => {
  check(anyText(), (t) => {
    for (const row of parseTaskText(t, 'lines').rows) assert.ok(t.includes(row.title), `title ${JSON.stringify(row.title)} not in the text`);
  });
});

test('property: well-formed bullet lines give one row each, in order, with their titles', () => {
  const line = fc.tuple(fc.constantFrom('', '  ', '    '), fc.constantFrom('', ' ', 'x', 'X'), fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,9}( [A-Za-z0-9]{1,6}){0,3}$/), fc.boolean());
  check(fc.array(line, { minLength: 1, maxLength: 20 }), (list) => {
    const text = list.map(([indent, mark, title, boxed]) => `${indent}- ${boxed ? `[${mark}] ` : ''}${title}`).join('\n');
    const { rows, errors } = parseTaskText(text, 'lines');
    assert.deepEqual(errors, []);
    assert.deepEqual(rows.map((r) => r.title), list.map((l) => l[2]));
    rows.forEach((r, i) => {
      assert.equal(r.line, i + 1);
      const [, mark, , boxed] = list[i];
      assert.equal(r.status === 'done', boxed && mark.toLowerCase() === 'x');
    });
  });
});

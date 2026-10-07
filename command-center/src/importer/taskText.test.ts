import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskText } from './taskText.ts';

test('lines: bullets, checkboxes, nesting, headings and fences', () => {
  const text = ['# Plan', '- [ ] Write spec', '  - Draft outline', '\t* [x] Review', '2) Ship', '```', '- not a task', '```', '', '   Late child'].join('\n');
  const r = parseTaskText(text, 'lines');
  assert.equal(r.format, 'lines');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.rows.map((x) => [x.line, x.title, x.parentIndex, x.status]), [
    [2, 'Write spec', null, undefined],
    [3, 'Draft outline', 0, undefined],
    [4, 'Review', 1, 'done'],
    [5, 'Ship', null, undefined],
    [10, 'Late child', 3, undefined],
  ]);
});

test('lines: tab counts as four columns and a sibling pops the stack', () => {
  const r = parseTaskText('a\n    b\n\tc\n        d\ne', 'lines');
  assert.deepEqual(r.rows.map((x) => x.parentIndex), [null, 0, 0, 2, null]);
});

test('csv: quoting, doubled quotes, newlines in quotes, BOM and CRLF', () => {
  const text = '﻿Title,Notes,Priority\r\n"Buy milk, eggs","say ""hi""\nline2",p1\r\n\r\nPlain,,low\r\n';
  const r = parseTaskText(text, 'auto');
  assert.equal(r.format, 'csv');
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows[0].title, 'Buy milk, eggs');
  assert.equal(r.rows[0].notes, 'say "hi"\nline2');
  assert.equal(r.rows[0].priority, 'urgent');
  assert.equal(r.rows[0].line, 2);
  assert.equal(r.rows[1].line, 5);
  assert.equal(r.rows[1].priority, 'low');
  assert.equal(r.rows[1].notes, undefined);
});

test('csv: semicolon and tab delimiters, header aliases, ignored columns', () => {
  const tsv = parseTaskText('Task\tDue Date\tAssigned_To\tEstimate\tColor\nA\t2026-10-01\tsam\t1h30m\tred', 'auto');
  assert.equal(tsv.format, 'csv');
  assert.deepEqual(tsv.rows[0], { line: 2, title: 'A', dueAt: '2026-10-01', assignee: 'sam', estimateMinutes: 90, parentIndex: null });
  assert.deepEqual(tsv.ignoredColumns, ['Color']);
  const semi = parseTaskText('name;status\nB;in progress\nC;todo\nD;Completed', 'csv');
  assert.deepEqual(semi.rows.map((r) => r.status), ['in_progress', 'open', 'done']);
});

test('csv: bad values are row errors with line numbers, not throws', () => {
  const r = parseTaskText('title,status,priority,due,estimate\nok,open,high,2026-10-02T09:30:00Z,45\nbad,nope,huge,tomorrow,soon\n,open,,,', 'csv');
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.errors.filter((e) => e.line === 3).length, 4);
  assert.deepEqual(r.errors.filter((e) => e.line === 4).map((e) => e.message), ['title is empty']);
});

test('csv: an unterminated quoted field is an error on the line it opened, not a record', () => {
  const text = 'title,notes\nFirst,"unterminated\nSecond,notes\n';
  for (const format of ['csv', 'auto'] as const) {
    const r = parseTaskText(text, format);
    assert.equal(r.format, 'csv');
    assert.deepEqual(r.rows, []);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].line, 2);
    assert.match(r.errors[0].message, /quoted field is never closed/);
  }
  // The line is where the quote opened, even when earlier fields spanned lines.
  const later = parseTaskText('title,notes\n"a\nb",fine\nc,"open\nd,e', 'csv');
  assert.deepEqual(later.rows, []);
  assert.deepEqual(later.errors.map((e) => e.line), [4]);
  // A closed quote at the end of the text is still a record.
  const closed = parseTaskText('title,notes\nFirst,"two\nlines"', 'csv');
  assert.deepEqual(closed.errors, []);
  assert.equal(closed.rows[0].notes, 'two\nlines');
});

test('csv: a missing title column is an error', () => {
  const r = parseTaskText('foo,bar\n1,2', 'csv');
  assert.equal(r.rows.length, 0);
  assert.match(r.errors[0].message, /title column/);
});

test('auto: two cells without a title header stay lines', () => {
  assert.equal(parseTaskText('Buy milk, eggs\nfoo', 'auto').format, 'lines');
});

test('estimates: minutes, m, h, h+m, decimal hours', () => {
  const r = parseTaskText('title,estimate\na,90\nb,90m\nc,1h\nd,1h30m\ne,1.5h', 'csv');
  assert.deepEqual(r.rows.map((x) => x.estimateMinutes), [90, 90, 60, 90, 90]);
});

test('more than 1000 rows is an error', () => {
  const r = parseTaskText(Array.from({ length: 1001 }, (_, i) => `t${i}`).join('\n'), 'lines');
  assert.equal(r.rows.length, 1000);
  assert.deepEqual(r.errors, [{ line: 1001, message: 'more than 1000 rows' }]);
});

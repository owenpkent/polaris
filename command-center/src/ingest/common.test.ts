import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../core/index.ts';
import { contentHash, emptyReport, formatReport, previewUpsert, tallyUpsert, type SyncReport } from './common.ts';

test('contentHash is deterministic for the same fields in the same order', () => {
  const a = contentHash('title', 'notes', 1, true);
  const b = contentHash('title', 'notes', 1, true);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('contentHash is sensitive to field order', () => {
  const a = contentHash('one', 'two');
  const b = contentHash('two', 'one');
  assert.notEqual(a, b);
});

test('contentHash distinguishes null/undefined/empty-string fields via a separator', () => {
  // Field order matters and fields are joined with a NUL separator, so ('a','') and ('a', undefined)
  // hash the same (both become "a\0\0"), but ('a') alone (no second field) hashes differently.
  const withEmptyString = contentHash('a', '');
  const withUndefined = contentHash('a', undefined);
  const withNull = contentHash('a', null);
  const singleField = contentHash('a');
  assert.equal(withEmptyString, withUndefined);
  assert.equal(withEmptyString, withNull);
  assert.notEqual(withEmptyString, singleField);
});

test('contentHash with no fields is stable', () => {
  assert.equal(contentHash(), contentHash());
});

test('emptyReport starts every counter at zero and is not partial', () => {
  const r = emptyReport('github');
  assert.equal(r.source, 'github');
  assert.equal(r.scanned, 0);
  assert.equal(r.created, 0);
  assert.equal(r.updated, 0);
  assert.equal(r.unchanged, 0);
  assert.equal(r.suppressed, 0);
  assert.equal(r.goneCompleted, 0);
  assert.deepEqual(r.errors, []);
  assert.equal(r.partial, false);
  assert.equal(r.apiCalls, 0);
  assert.equal(r.checked, undefined);
});

test('tallyUpsert increments scanned and the named action bucket', () => {
  const r = emptyReport('git_local');
  tallyUpsert(r, 'created');
  tallyUpsert(r, 'created');
  tallyUpsert(r, 'updated');
  tallyUpsert(r, 'unchanged');
  tallyUpsert(r, 'suppressed');
  assert.equal(r.scanned, 5);
  assert.equal(r.created, 2);
  assert.equal(r.updated, 1);
  assert.equal(r.unchanged, 1);
  assert.equal(r.suppressed, 1);
  assert.equal(r.goneCompleted, 0);
});

test('formatReport with no checked count uses the scanned= form and lists no errors', () => {
  const r = emptyReport('code_todo');
  r.created = 2;
  const text = formatReport(r);
  assert.match(text, /^sync code_todo: scanned=0 created=2 updated=0 unchanged=0 suppressed=0 goneCompleted=0 apiCalls=0$/);
});

test('formatReport with a checked count uses the "checked X, found Y" form and pluralizes nouns', () => {
  const r = emptyReport('git_local');
  r.scanned = 1;
  r.created = 1;
  r.checked = { count: 5, noun: 'repo', foundNoun: 'issue' };
  const text = formatReport(r);
  assert.match(text, /^sync git_local: checked 5 repos, found 1 issue \(/);
});

test('formatReport singularizes a count of exactly one', () => {
  const r = emptyReport('git_local');
  r.checked = { count: 1, noun: 'repo', foundNoun: 'issue' };
  const text = formatReport(r);
  assert.match(text, /checked 1 repo, found 0 issues/);
});

test('formatReport appends a PARTIAL SYNC warning line when partial is true', () => {
  const r = emptyReport('github');
  r.partial = true;
  const text = formatReport(r);
  assert.match(text, /PARTIAL SYNC: disappearance detection was skipped/);
});

test('formatReport lists each error on its own indented line', () => {
  const r: SyncReport = { ...emptyReport('github'), errors: ['boom one', 'boom two'] };
  const text = formatReport(r);
  const lines = text.split('\n');
  assert.ok(lines.includes('  error: boom one'));
  assert.ok(lines.includes('  error: boom two'));
});

test('formatReport lists each skipped entry on its own indented line, before any errors', () => {
  const r: SyncReport = { ...emptyReport('repo_files'), skipped: ['octavium: o/r cannot be read'], errors: ['boom'] };
  const text = formatReport(r);
  const lines = text.split('\n');
  assert.ok(lines.includes('  skipped: octavium: o/r cannot be read'));
  assert.ok(lines.indexOf('  skipped: octavium: o/r cannot be read') < lines.indexOf('  error: boom'));
});

test('previewUpsert reports created for a source item with no existing task', () => {
  const s = openStore(':memory:');
  const result = previewUpsert(s, { sourceType: 'gmail', sourceId: 'thread-1', title: 'Follow up', contentHash: 'h1' });
  assert.equal(result, 'created');
});

test('previewUpsert reports unchanged when the incoming snapshot matches the existing task', () => {
  const s = openStore(':memory:');
  s.upsertFromSource({ sourceType: 'gmail', sourceId: 'thread-1', title: 'Follow up', notes: 'body', dueAt: '2026-09-20', priority: 'high', contentHash: 'h1' });
  const result = previewUpsert(s, { sourceType: 'gmail', sourceId: 'thread-1', title: 'Follow up', notes: 'body', dueAt: '2026-09-20', priority: 'high', contentHash: 'h2' });
  assert.equal(result, 'unchanged');
});

test('previewUpsert reports updated when the incoming title differs from the existing task', () => {
  const s = openStore(':memory:');
  s.upsertFromSource({ sourceType: 'gmail', sourceId: 'thread-1', title: 'Follow up', contentHash: 'h1' });
  const result = previewUpsert(s, { sourceType: 'gmail', sourceId: 'thread-1', title: 'Follow up ASAP', contentHash: 'h2' });
  assert.equal(result, 'updated');
});

test('previewUpsert treats a missing notes/dueAt/priority on the incoming item as its default, not as unchanged by accident', () => {
  const s = openStore(':memory:');
  s.upsertFromSource({ sourceType: 'gmail', sourceId: 'thread-1', title: 'Follow up', notes: 'body', dueAt: '2026-09-20', priority: 'high', contentHash: 'h1' });
  // Incoming item omits notes/dueAt/priority entirely, so the comparison snapshot defaults to
  // '' / null / 'none', which differs from the existing task's stored fields.
  const result = previewUpsert(s, { sourceType: 'gmail', sourceId: 'thread-1', title: 'Follow up', contentHash: 'h2' });
  assert.equal(result, 'updated');
});

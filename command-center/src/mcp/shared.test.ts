import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundError, openStore, PRIORITIES, TASK_STATUSES, ValidationError } from '../core/index.ts';
import {
  addDays,
  DEFAULT_SEARCH_STATUSES,
  ok,
  err,
  guard,
  ORDER_BY_VALUES,
  OPEN_STATUSES,
  PRIORITY_VALUES,
  resolveProject,
  resolveProjectByGithubRepo,
  resolveSectionRead,
  resolveSectionWrite,
  SOURCE_TYPE_VALUES,
  TASK_STATUS_VALUES,
} from './shared.ts';

// ---- the hand-kept enum lists must stay in sync with core/types.ts ----

test('TASK_STATUS_VALUES matches core TASK_STATUSES exactly, in order', () => {
  assert.deepEqual(TASK_STATUS_VALUES, TASK_STATUSES);
});

test('PRIORITY_VALUES matches core PRIORITIES exactly, in order', () => {
  assert.deepEqual(PRIORITY_VALUES, PRIORITIES);
});

test('DEFAULT_SEARCH_STATUSES excludes done and dropped only', () => {
  assert.deepEqual(DEFAULT_SEARCH_STATUSES, ['inbox', 'open', 'in_progress', 'waiting']);
  const asStrings: readonly string[] = DEFAULT_SEARCH_STATUSES;
  assert.ok(!asStrings.includes('done'));
  assert.ok(!asStrings.includes('dropped'));
});

test('OPEN_STATUSES is exactly open/in_progress/waiting', () => {
  assert.deepEqual(OPEN_STATUSES, ['open', 'in_progress', 'waiting']);
});

test('ORDER_BY_VALUES lists the five supported sort keys', () => {
  assert.deepEqual([...ORDER_BY_VALUES].sort(), ['created', 'due', 'position', 'priority', 'updated']);
});

test('SOURCE_TYPE_VALUES is a non-empty list including github and manual', () => {
  assert.ok(SOURCE_TYPE_VALUES.includes('github'));
  assert.ok(SOURCE_TYPE_VALUES.includes('manual'));
});

// ---- ok / err / guard ----

test('ok(text) returns a text-only content block with no structuredContent key', () => {
  const result = ok('hello');
  assert.deepEqual(result, { content: [{ type: 'text', text: 'hello' }] });
  assert.ok(!('structuredContent' in result));
});

test('ok(text, structured) attaches the structured payload alongside the text', () => {
  const result = ok('hello', { count: 3 });
  assert.deepEqual(result, { content: [{ type: 'text', text: 'hello' }], structuredContent: { count: 3 } });
});

test('err(message) returns an isError result with the message as its only content', () => {
  const result = err('something broke');
  assert.deepEqual(result, { isError: true, content: [{ type: 'text', text: 'something broke' }] });
});

test('guard returns the function result unchanged on success', () => {
  const result = guard(() => ok('fine'));
  assert.deepEqual(result, ok('fine'));
});

test('guard maps a thrown NotFoundError to an isError result prefixed "Not found:"', () => {
  const result = guard(() => { throw new NotFoundError('task x'); });
  assert.deepEqual(result, err('Not found: task x'));
});

test('guard maps a thrown ValidationError to an isError result prefixed "Invalid:"', () => {
  const result = guard(() => { throw new ValidationError('bad date'); });
  assert.deepEqual(result, err('Invalid: bad date'));
});

test('guard maps an ordinary Error to an isError result prefixed "Error:"', () => {
  const result = guard(() => { throw new Error('boom'); });
  assert.deepEqual(result, err('Error: boom'));
});

test('guard maps a thrown non-Error value to an isError result using String(e)', () => {
  const result = guard(() => { throw 'a plain string throw'; });
  assert.deepEqual(result, err('Error: a plain string throw'));
});

test('guard never lets an exception propagate to the caller (tools never throw)', () => {
  assert.doesNotThrow(() => guard(() => { throw new Error('anything'); }));
});

// ---- resolveProject ----

test('resolveProject returns the project when findProject matches', () => {
  const s = openStore(':memory:');
  const p = s.upsertProject({ slug: 'nimbus', name: 'Project Nimbus' });
  assert.equal(resolveProject(s, 'nimbus').id, p.id);
});

test('resolveProject throws NotFoundError with the ref in the message when no project matches', () => {
  const s = openStore(':memory:');
  assert.throws(() => resolveProject(s, 'ghost'), (e: unknown) => e instanceof NotFoundError && /ghost/.test((e as Error).message));
});

// ---- resolveProjectByGithubRepo ----

test('resolveProjectByGithubRepo matches owner/repo and every github.com URL form, without regard to case', () => {
  const s = openStore(':memory:');
  const p = s.upsertProject({ slug: 'octavium', name: 'Octavium', github: 'https://github.com/owenpkent/Octavium' });
  for (const ref of ['owenpkent/Octavium', 'OWENPKENT/octavium', 'https://github.com/owenpkent/Octavium', 'https://github.com/owenpkent/Octavium.git', 'git@github.com:owenpkent/Octavium.git', '  owenpkent/Octavium  ']) {
    assert.equal(resolveProjectByGithubRepo(s, ref)?.id, p.id, ref);
  }
});

test('resolveProjectByGithubRepo returns undefined for another repo, a project with no repo, an archived project, and text that is not a repo', () => {
  const s = openStore(':memory:');
  s.upsertProject({ slug: 'octavium', name: 'Octavium', github: 'https://github.com/owenpkent/Octavium' });
  s.upsertProject({ slug: 'garden', name: 'Garden' });
  s.upsertProject({ slug: 'old', name: 'Old', github: 'https://github.com/owenpkent/old', archived: true });
  for (const ref of ['owenpkent/other', 'someone-else/Octavium', 'owenpkent/old', 'Garden', 'C:/Users/Sam/dev/Octavium', '']) {
    assert.equal(resolveProjectByGithubRepo(s, ref), undefined, ref);
  }
});

// ---- resolveSectionRead / resolveSectionWrite ----

test('resolveSectionRead finds a section by id', () => {
  const s = openStore(':memory:');
  const p = s.upsertProject({ slug: 'nimbus', name: 'Nimbus' });
  const section = s.ensureSection(p.id, 'Backlog');
  assert.equal(resolveSectionRead(s, p.id, section.id).id, section.id);
});

test('resolveSectionRead finds a section by case-insensitive name', () => {
  const s = openStore(':memory:');
  const p = s.upsertProject({ slug: 'nimbus', name: 'Nimbus' });
  const section = s.ensureSection(p.id, 'Backlog');
  assert.equal(resolveSectionRead(s, p.id, 'BACKLOG').id, section.id);
});

test('resolveSectionRead throws NotFoundError for an unknown ref and never creates a section', () => {
  const s = openStore(':memory:');
  const p = s.upsertProject({ slug: 'nimbus', name: 'Nimbus' });
  assert.throws(() => resolveSectionRead(s, p.id, 'Nope'), NotFoundError);
  assert.deepEqual(s.listSections(p.id), []);
});

test('resolveSectionRead does not find a section belonging to a different project', () => {
  const s = openStore(':memory:');
  const p1 = s.upsertProject({ slug: 'a', name: 'A' });
  const p2 = s.upsertProject({ slug: 'b', name: 'B' });
  const section = s.ensureSection(p1.id, 'Backlog');
  assert.throws(() => resolveSectionRead(s, p2.id, section.id), NotFoundError);
});

test('resolveSectionWrite finds an existing section by name without creating a duplicate', () => {
  const s = openStore(':memory:');
  const p = s.upsertProject({ slug: 'nimbus', name: 'Nimbus' });
  const section = s.ensureSection(p.id, 'Backlog');
  const resolved = resolveSectionWrite(s, p.id, 'backlog');
  assert.equal(resolved.id, section.id);
  assert.equal(s.listSections(p.id).length, 1);
});

test('resolveSectionWrite creates a new section when no match exists', () => {
  const s = openStore(':memory:');
  const p = s.upsertProject({ slug: 'nimbus', name: 'Nimbus' });
  const created = resolveSectionWrite(s, p.id, 'New Section');
  assert.equal(created.name, 'New Section');
  assert.equal(s.listSections(p.id).length, 1);
});

// ---- addDays (mcp/shared.ts variant: truncates to the date portion first) ----

test('addDays adds a day to a plain date string', () => {
  assert.equal(addDays('2026-09-10', 1), '2026-09-11');
});

test('addDays truncates a full ISO datetime to its date portion before adding', () => {
  // Unlike automation/dates.ts's addDays (which assumes a bare date and throws on a datetime),
  // this variant slices to the first 10 characters first, so it accepts a datetime but silently
  // drops the time-of-day.
  assert.equal(addDays('2026-09-10T23:59:59Z', 1), '2026-09-11');
});

test('addDays supports negative offsets and month/year rollover', () => {
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
});

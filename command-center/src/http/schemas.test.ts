import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ValidationError } from '../core/index.ts';
import {
  commentBodySchema,
  dependencyBodySchema,
  inboxAcceptBodySchema,
  inboxRejectBodySchema,
  moveTaskBodySchema,
  newTaskBodySchema,
  parseBody,
  ruleCreateBodySchema,
  rulePatchBodySchema,
  ruleRunBodySchema,
  taskPatchBodySchema,
} from './schemas.ts';

// ---- newTaskBodySchema ----

test('newTaskBodySchema accepts the minimal shape: title only', () => {
  const r = newTaskBodySchema.safeParse({ title: 'Ship it' });
  assert.equal(r.success, true);
  if (r.success) assert.deepEqual(r.data, { title: 'Ship it' });
});

test('newTaskBodySchema accepts every documented field at once', () => {
  const body = {
    title: 'Full task',
    notes: 'some notes',
    projectId: 'p1',
    sectionId: 's1',
    parentId: null,
    status: 'open',
    priority: 'high',
    dueAt: '2026-09-20',
    startAt: null,
    estimateMinutes: 30,
    recurrence: 'FREQ=WEEKLY',
    isMilestone: true,
    customFields: { effort: 3, tag: 'x', flag: true, cleared: null },
    sourceType: 'github',
    sourceId: 'gh-1',
    sourceUrl: 'https://example.com',
    confidence: 0.5,
    project: 'nimbus',
    section: 'Backlog',
    blockedBy: ['t1', 't2'],
  };
  const r = newTaskBodySchema.safeParse(body);
  assert.equal(r.success, true);
  if (r.success) assert.deepEqual(r.data, body);
});

test('newTaskBodySchema rejects a missing title', () => {
  const r = newTaskBodySchema.safeParse({});
  assert.equal(r.success, false);
  if (!r.success) assert.match(r.error.issues[0].path.join('.') + ': ' + r.error.issues[0].message, /title/);
});

test('newTaskBodySchema rejects an empty-string title with its custom message', () => {
  const r = newTaskBodySchema.safeParse({ title: '' });
  assert.equal(r.success, false);
  if (!r.success) assert.equal(r.error.issues[0].message, 'title is required');
});

test('newTaskBodySchema rejects an unknown key (strict mode)', () => {
  const r = newTaskBodySchema.safeParse({ title: 'x', bogus: 1 });
  assert.equal(r.success, false);
  if (!r.success) assert.match(r.error.issues[0].message, /Unrecognized key/);
});

test('newTaskBodySchema rejects a status value outside TASK_STATUS_VALUES', () => {
  const r = newTaskBodySchema.safeParse({ title: 'x', status: 'archived' });
  assert.equal(r.success, false);
});

for (const status of ['inbox', 'open', 'in_progress', 'waiting', 'done', 'dropped']) {
  test(`newTaskBodySchema accepts status "${status}"`, () => {
    assert.equal(newTaskBodySchema.safeParse({ title: 'x', status }).success, true);
  });
}

test('newTaskBodySchema rejects a priority value outside PRIORITY_VALUES', () => {
  assert.equal(newTaskBodySchema.safeParse({ title: 'x', priority: 'critical' }).success, false);
});

for (const priority of ['none', 'low', 'medium', 'high', 'urgent']) {
  test(`newTaskBodySchema accepts priority "${priority}"`, () => {
    assert.equal(newTaskBodySchema.safeParse({ title: 'x', priority }).success, true);
  });
}

test('newTaskBodySchema rejects a negative estimateMinutes', () => {
  assert.equal(newTaskBodySchema.safeParse({ title: 'x', estimateMinutes: -1 }).success, false);
});

test('newTaskBodySchema accepts estimateMinutes of exactly 0 (boundary)', () => {
  assert.equal(newTaskBodySchema.safeParse({ title: 'x', estimateMinutes: 0 }).success, true);
});

test('newTaskBodySchema rejects a non-integer estimateMinutes', () => {
  assert.equal(newTaskBodySchema.safeParse({ title: 'x', estimateMinutes: 1.5 }).success, false);
});

test('newTaskBodySchema accepts a null estimateMinutes', () => {
  assert.equal(newTaskBodySchema.safeParse({ title: 'x', estimateMinutes: null }).success, true);
});

test('newTaskBodySchema enforces confidence in [0, 1] inclusive', () => {
  assert.equal(newTaskBodySchema.safeParse({ title: 'x', confidence: 0 }).success, true);
  assert.equal(newTaskBodySchema.safeParse({ title: 'x', confidence: 1 }).success, true);
  assert.equal(newTaskBodySchema.safeParse({ title: 'x', confidence: -0.0001 }).success, false);
  assert.equal(newTaskBodySchema.safeParse({ title: 'x', confidence: 1.0001 }).success, false);
  assert.equal(newTaskBodySchema.safeParse({ title: 'x', confidence: null }).success, true);
});

test('newTaskBodySchema rejects a sourceType outside SOURCE_TYPE_VALUES', () => {
  assert.equal(newTaskBodySchema.safeParse({ title: 'x', sourceType: 'slack' }).success, false);
});

test('newTaskBodySchema accepts a null sourceType', () => {
  assert.equal(newTaskBodySchema.safeParse({ title: 'x', sourceType: null }).success, true);
});

test('newTaskBodySchema customFields accepts string/number/boolean/null values and rejects an object/array value', () => {
  assert.equal(newTaskBodySchema.safeParse({ title: 'x', customFields: { a: 'x', b: 1, c: true, d: null } }).success, true);
  assert.equal(newTaskBodySchema.safeParse({ title: 'x', customFields: { a: {} } }).success, false);
  assert.equal(newTaskBodySchema.safeParse({ title: 'x', customFields: { a: [1] } }).success, false);
  assert.equal(newTaskBodySchema.safeParse({ title: 'x', customFields: { a: undefined } }).success, false);
});

test('newTaskBodySchema rejects blockedBy that is not an array', () => {
  assert.equal(newTaskBodySchema.safeParse({ title: 'x', blockedBy: 'not-an-array' }).success, false);
});

test('newTaskBodySchema accepts an empty blockedBy array', () => {
  assert.equal(newTaskBodySchema.safeParse({ title: 'x', blockedBy: [] }).success, true);
});

test('newTaskBodySchema rejects an empty-string project/section ref (min length 1)', () => {
  assert.equal(newTaskBodySchema.safeParse({ title: 'x', project: '' }).success, false);
  assert.equal(newTaskBodySchema.safeParse({ title: 'x', section: '' }).success, false);
});

test('newTaskBodySchema hostile input: title is not a string', () => {
  assert.equal(newTaskBodySchema.safeParse({ title: 123 }).success, false);
  assert.equal(newTaskBodySchema.safeParse({ title: null }).success, false);
  assert.equal(newTaskBodySchema.safeParse({ title: ['x'] }).success, false);
});

test('newTaskBodySchema hostile input: a very long title is still just a string, no max length enforced', () => {
  const title = 'x'.repeat(100_000);
  assert.equal(newTaskBodySchema.safeParse({ title }).success, true);
});

// ---- taskPatchBodySchema ----

test('taskPatchBodySchema accepts an empty patch', () => {
  const r = taskPatchBodySchema.safeParse({});
  assert.equal(r.success, true);
  if (r.success) assert.deepEqual(r.data, {});
});

test('taskPatchBodySchema rejects an empty-string title but allows other fields to be optional', () => {
  assert.equal(taskPatchBodySchema.safeParse({ title: '' }).success, false);
  assert.equal(taskPatchBodySchema.safeParse({ title: 'ok' }).success, true);
});

test('taskPatchBodySchema does not accept sourceType/sourceId (create-only fields)', () => {
  assert.equal(taskPatchBodySchema.safeParse({ sourceType: 'github' }).success, false);
  assert.equal(taskPatchBodySchema.safeParse({ sourceId: 'x' }).success, false);
});

test('taskPatchBodySchema does accept sourceUrl and confidence (patchable)', () => {
  assert.equal(taskPatchBodySchema.safeParse({ sourceUrl: 'https://x', confidence: 0.9 }).success, true);
});

test('taskPatchBodySchema accepts a status change including terminal statuses', () => {
  assert.equal(taskPatchBodySchema.safeParse({ status: 'done' }).success, true);
  assert.equal(taskPatchBodySchema.safeParse({ status: 'dropped' }).success, true);
});

test('taskPatchBodySchema rejects an unknown field', () => {
  assert.equal(taskPatchBodySchema.safeParse({ notAField: 1 }).success, false);
});

// ---- moveTaskBodySchema ----

test('moveTaskBodySchema accepts an empty move (no-op)', () => {
  assert.equal(moveTaskBodySchema.safeParse({}).success, true);
});

test('moveTaskBodySchema accepts null project/section/parentId to clear them', () => {
  assert.equal(moveTaskBodySchema.safeParse({ project: null, section: null, parentId: null }).success, true);
});

test('moveTaskBodySchema requires position to be an integer', () => {
  assert.equal(moveTaskBodySchema.safeParse({ position: 1 }).success, true);
  assert.equal(moveTaskBodySchema.safeParse({ position: 1.5 }).success, false);
});

test('moveTaskBodySchema allows a negative position', () => {
  assert.equal(moveTaskBodySchema.safeParse({ position: -5 }).success, true);
});

// ---- commentBodySchema ----

test('commentBodySchema requires a non-empty body string', () => {
  assert.equal(commentBodySchema.safeParse({ body: 'hello' }).success, true);
  assert.equal(commentBodySchema.safeParse({ body: '' }).success, false);
  assert.equal(commentBodySchema.safeParse({}).success, false);
});

test('commentBodySchema rejects extra keys', () => {
  assert.equal(commentBodySchema.safeParse({ body: 'hi', author: 'human' }).success, false);
});

// ---- dependencyBodySchema ----

test('dependencyBodySchema requires a non-empty blockerId', () => {
  assert.equal(dependencyBodySchema.safeParse({ blockerId: 't1' }).success, true);
  assert.equal(dependencyBodySchema.safeParse({ blockerId: '' }).success, false);
  assert.equal(dependencyBodySchema.safeParse({}).success, false);
});

// ---- inboxAcceptBodySchema / inboxRejectBodySchema ----

test('inboxAcceptBodySchema accepts an empty body (accept as-is)', () => {
  assert.equal(inboxAcceptBodySchema.safeParse({}).success, true);
});

test('inboxAcceptBodySchema validates priority against PRIORITY_VALUES', () => {
  assert.equal(inboxAcceptBodySchema.safeParse({ priority: 'high' }).success, true);
  assert.equal(inboxAcceptBodySchema.safeParse({ priority: 'nonsense' }).success, false);
});

test('inboxAcceptBodySchema rejects empty-string project/section/title', () => {
  assert.equal(inboxAcceptBodySchema.safeParse({ project: '' }).success, false);
  assert.equal(inboxAcceptBodySchema.safeParse({ section: '' }).success, false);
  assert.equal(inboxAcceptBodySchema.safeParse({ title: '' }).success, false);
});

test('inboxAcceptBodySchema accepts a null dueAt to clear it', () => {
  assert.equal(inboxAcceptBodySchema.safeParse({ dueAt: null }).success, true);
});

test('inboxRejectBodySchema accepts an empty body, a null reason, or a string reason', () => {
  assert.equal(inboxRejectBodySchema.safeParse({}).success, true);
  assert.equal(inboxRejectBodySchema.safeParse({ reason: null }).success, true);
  assert.equal(inboxRejectBodySchema.safeParse({ reason: 'stale' }).success, true);
});

test('inboxRejectBodySchema rejects a non-string, non-null reason', () => {
  assert.equal(inboxRejectBodySchema.safeParse({ reason: 5 }).success, false);
});

// ---- rule schemas ----
// Rules are automation; see project safety rule "rules created by an agent are saved disabled".
// These schemas only validate shape -- the disabled-by-default behavior lives in the store/route,
// not here -- but `enabled` is a plain optional boolean with no special-casing in the schema itself.

test('ruleCreateBodySchema requires a non-empty name and an object definition', () => {
  assert.equal(ruleCreateBodySchema.safeParse({ name: 'r', definition: {} }).success, true);
  assert.equal(ruleCreateBodySchema.safeParse({ name: '', definition: {} }).success, false);
  assert.equal(ruleCreateBodySchema.safeParse({ definition: {} }).success, false);
});

test('ruleCreateBodySchema requires definition to be a plain object, not an array or a primitive', () => {
  assert.equal(ruleCreateBodySchema.safeParse({ name: 'r', definition: [] }).success, false);
  assert.equal(ruleCreateBodySchema.safeParse({ name: 'r', definition: 'nope' }).success, false);
  assert.equal(ruleCreateBodySchema.safeParse({ name: 'r' }).success, false);
});

test('ruleCreateBodySchema accepts an arbitrary-shaped definition (validated elsewhere)', () => {
  const r = ruleCreateBodySchema.safeParse({
    name: 'r',
    definition: { trigger: { type: 'schedule', condition: 'overdue' }, conditions: [], actions: [{ type: 'notify', message: 'hi' }] },
    enabled: true,
  });
  assert.equal(r.success, true);
});

test('rulePatchBodySchema accepts a partial patch of any subset of fields', () => {
  assert.equal(rulePatchBodySchema.safeParse({}).success, true);
  assert.equal(rulePatchBodySchema.safeParse({ enabled: true }).success, true);
  assert.equal(rulePatchBodySchema.safeParse({ name: 'renamed' }).success, true);
  assert.equal(rulePatchBodySchema.safeParse({ name: '' }).success, false);
});

test('ruleRunBodySchema accepts an empty body, an optional ruleId, and a boolean dryRun', () => {
  assert.equal(ruleRunBodySchema.safeParse({}).success, true);
  assert.equal(ruleRunBodySchema.safeParse({ ruleId: 'r1' }).success, true);
  assert.equal(ruleRunBodySchema.safeParse({ dryRun: true }).success, true);
  assert.equal(ruleRunBodySchema.safeParse({ dryRun: 'true' }).success, false);
});

// ---- parseBody ----

test('parseBody returns the parsed data on success', () => {
  const data = parseBody(commentBodySchema, { body: 'hi' });
  assert.deepEqual(data, { body: 'hi' });
});

test('parseBody treats an undefined body as {} (so a schema with only optional fields succeeds)', () => {
  const data = parseBody(ruleRunBodySchema, undefined);
  assert.deepEqual(data, {});
});

test('parseBody throws ValidationError (not the raw zod error) on failure', () => {
  assert.throws(() => parseBody(commentBodySchema, {}), ValidationError);
});

test('parseBody joins multiple issues with "; " and prefixes each with its field path', () => {
  try {
    parseBody(newTaskBodySchema, { title: '', priority: 'nope' });
    assert.fail('expected parseBody to throw');
  } catch (e) {
    assert.ok(e instanceof ValidationError);
    assert.match(e.message, /title: title is required/);
    assert.match(e.message, /priority: /);
    assert.ok(e.message.includes('; '));
  }
});

test('parseBody labels a root-level issue (no field path) as "body"', () => {
  try {
    parseBody(newTaskBodySchema, null);
    assert.fail('expected parseBody to throw');
  } catch (e) {
    assert.ok(e instanceof ValidationError);
    assert.match(e.message, /^body: /);
  }
});

test('parseBody rejects a non-object body (string, array, number) against an object schema', () => {
  assert.throws(() => parseBody(newTaskBodySchema, 'a string'), ValidationError);
  assert.throws(() => parseBody(newTaskBodySchema, ['array']), ValidationError);
  assert.throws(() => parseBody(newTaskBodySchema, 42), ValidationError);
});

test('parseBody rejects a hostile "__proto__" key as an unrecognized key, not silently dropping it', () => {
  // Using a computed key forces a real own property (the object-literal shorthand `__proto__: x`
  // is special-cased by the spec to set the prototype instead); this is the shape JSON.parse
  // produces for a body like {"body":"hi","__proto__":"polluted"} coming over the wire.
  const hostile: Record<string, unknown> = { body: 'hi' };
  Object.defineProperty(hostile, '__proto__', { value: 'polluted', enumerable: true, configurable: true });
  assert.deepEqual(Object.keys(hostile), ['body', '__proto__']);
  try {
    parseBody(commentBodySchema, hostile);
    assert.fail('expected parseBody to throw on the unrecognized __proto__ key');
  } catch (e) {
    assert.ok(e instanceof ValidationError);
    assert.match((e as ValidationError).message, /Unrecognized key/);
  }
});

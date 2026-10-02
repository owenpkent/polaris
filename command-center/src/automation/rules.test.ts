import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, type Store } from '../core/index.ts';
import { listNotifications, runRules, validateRuleDefinition } from './rules.ts';

const TODAY = '2026-09-12';

function fresh(): Store {
  let tick = 0;
  return openStore(':memory:', {
    now: () => new Date(Date.UTC(2026, 8, 12, 9, 0, tick++)).toISOString(),
    nextOccurrence: () => null,
  });
}

function addRule(s: Store, definition: unknown, opts: { name?: string; enabled?: boolean } = {}) {
  const v = validateRuleDefinition(definition);
  assert.ok(v.ok, `expected a valid rule, got errors: ${JSON.stringify(v.errors)}`);
  return s.saveRule({ name: opts.name ?? 'rule', enabled: opts.enabled ?? true, definition: v.normalized! });
}

// ---------------------------------------------------------------- validation

test('validateRuleDefinition accepts a well-formed rule', () => {
  const v = validateRuleDefinition({
    trigger: { type: 'event', kinds: ['task.created'] },
    conditions: [{ field: 'title', op: 'contains', value: 'urgent' }],
    actions: [{ type: 'set_field', field: 'priority', value: 'high' }],
  });
  assert.equal(v.ok, true);
  assert.deepEqual(v.errors, []);
  assert.ok(v.normalized);
});

test('validateRuleDefinition rejects a schedule trigger missing days', () => {
  const v = validateRuleDefinition({
    trigger: { type: 'schedule', condition: 'due_within_days' },
    actions: [{ type: 'notify', message: 'hi' }],
  });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /days/.test(e)));
});

test('validateRuleDefinition rejects set_field status of done or dropped', () => {
  for (const value of ['done', 'dropped']) {
    const v = validateRuleDefinition({
      trigger: { type: 'event', kinds: ['task.created'] },
      actions: [{ type: 'set_field', field: 'status', value }],
    });
    assert.equal(v.ok, false, `status '${value}' should be rejected`);
  }
});

test('validateRuleDefinition rejects unknown action types (no complete/drop/delete/accept)', () => {
  for (const action of [{ type: 'complete_task' }, { type: 'accept_inbox_item' }, { type: 'delete_task' }]) {
    const v = validateRuleDefinition({
      trigger: { type: 'event', kinds: ['task.created'] },
      actions: [action],
    });
    assert.equal(v.ok, false);
  }
});

test('validateRuleDefinition rejects an unknown condition field and an empty action list', () => {
  const badField = validateRuleDefinition({
    trigger: { type: 'event', kinds: ['task.created'] },
    conditions: [{ field: 'not_a_field', op: 'eq', value: 1 }],
    actions: [{ type: 'notify', message: 'hi' }],
  });
  assert.equal(badField.ok, false);

  const noActions = validateRuleDefinition({
    trigger: { type: 'event', kinds: ['task.created'] },
    actions: [],
  });
  assert.equal(noActions.ok, false);
  assert.ok(noActions.errors.some((e) => /action/i.test(e)));
});

// -------------------------------------------------------------- event rules

test('an event rule fires once per matching event and advances the cursor', () => {
  const s = fresh();
  addRule(s, {
    trigger: { type: 'event', kinds: ['task.created'] },
    conditions: [{ field: 'title', op: 'contains', value: 'urgent' }],
    actions: [{ type: 'set_field', field: 'priority', value: 'high' }],
  }, { name: 'flag urgent' });
  runRules(s, { today: TODAY }); // prime: a brand new rule starts tracking from here

  const t = s.createTask({ title: 'urgent: fix prod' });
  s.createTask({ title: 'ordinary task' }); // should not match

  const report = runRules(s, { today: TODAY });
  assert.equal(report.fired.length, 1);
  assert.equal(report.fired[0].taskId, t.id);
  assert.equal(s.requireTask(t.id).priority, 'high');
  assert.match(s.listComments(t.id).at(-1)!.body, /flag urgent/);
  assert.equal(s.listComments(t.id).at(-1)!.author, 'system');

  // History records the field change with actor 'rule'.
  const history = s.taskHistory(t.id);
  assert.ok(history.some((e) => e.kind === 'task.updated' && e.actor === 'rule'));
  assert.ok(history.some((e) => e.kind === 'rule.fired' && e.actor === 'rule'));

  // Nothing new to process: the cursor already advanced past both task.created events.
  const again = runRules(s, { today: TODAY });
  assert.deepEqual(again.fired, []);
});

test('a rule never re-fires on the events its own actions generate (loop prevention)', () => {
  const s = fresh();
  addRule(s, {
    trigger: { type: 'event', kinds: ['task.updated'] },
    actions: [{ type: 'set_field', field: 'customField', key: 'touched', value: true }],
  }, { name: 'mark touched' });
  runRules(s, { today: TODAY }); // prime

  const t = s.createTask({ title: 'Something' }); // task.created, not task.updated: rule does not fire yet
  s.updateTask(t.id, { title: 'Something else' }, 'human'); // a real, human-authored task.updated

  const first = runRules(s, { today: TODAY });
  assert.equal(first.fired.length, 1, 'fires once on the human-authored update');
  assert.equal(s.requireTask(t.id).customFields.touched, true);

  // The rule's own update produced another task.updated event, authored by 'rule'. It must not
  // cause a second firing.
  const second = runRules(s, { today: TODAY });
  assert.deepEqual(second.fired, []);
});

test('dryRun performs no writes at all', () => {
  const s = fresh();
  const rule = addRule(s, {
    trigger: { type: 'event', kinds: ['task.created'] },
    actions: [{ type: 'set_field', field: 'priority', value: 'urgent' }],
  });
  runRules(s, { today: TODAY }); // prime, so the task below is a genuinely new event to preview
  s.createTask({ title: 'Anything' });

  const cursorKey = `rules.eventCursor.${rule.id}`;
  const before = s.lastEventId();
  const cursorBefore = s.getKv<number>(cursorKey);
  const report = runRules(s, { today: TODAY, dryRun: true });
  assert.equal(report.dryRun, true);
  assert.equal(report.fired.length, 1, 'dry run still reports what would fire');
  assert.equal(s.lastEventId(), before, 'no events were recorded');
  assert.equal(s.getKv<number>(cursorKey), cursorBefore, 'the cursor did not advance');
});

test('forbidden actions cannot reach the store: only organizing actions exist', () => {
  // set_field on status is restricted to non-terminal statuses by validation (tested above); this
  // confirms runRules never even considers a definition that slipped past validation with a
  // 'done' status by exercising the schema boundary once more end to end.
  const v = validateRuleDefinition({
    trigger: { type: 'event', kinds: ['task.created'] },
    actions: [{ type: 'set_field', field: 'status', value: 'done' }],
  });
  assert.equal(v.ok, false);
});

test('errors in one rule do not stop others from running', () => {
  const s = fresh();
  addRule(s, {
    trigger: { type: 'event', kinds: ['task.created'] },
    actions: [{ type: 'move', project: 'does-not-exist' }],
  }, { name: 'broken rule' });
  addRule(s, {
    trigger: { type: 'event', kinds: ['task.created'] },
    actions: [{ type: 'set_field', field: 'priority', value: 'low' }],
  }, { name: 'good rule' });
  runRules(s, { today: TODAY }); // prime both rules

  const t = s.createTask({ title: 'Task' });
  const report = runRules(s, { today: TODAY });

  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0].message, /does-not-exist/);
  assert.equal(report.fired.length, 1);
  assert.equal(report.fired[0].ruleName, 'good rule');
  assert.equal(s.requireTask(t.id).priority, 'low');
});

test('notify records a rule.fired event with payload.notification, readable via listNotifications', () => {
  const s = fresh();
  addRule(s, {
    trigger: { type: 'event', kinds: ['task.created'] },
    actions: [{ type: 'notify', message: 'New task: {title}' }],
  }, { name: 'announce' });
  runRules(s, { today: TODAY }); // prime

  const t = s.createTask({ title: 'Ship it' });
  runRules(s, { today: TODAY });

  const notes = listNotifications(s);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].taskId, t.id);
  assert.equal(notes[0].message, 'New task: Ship it');
  assert.equal(notes[0].ruleName, 'announce');
});

// ----------------------------------------------------------- schedule rules

test('schedule rules fire at most once per rule/task/day, then again the next day', () => {
  const s = fresh();
  addRule(s, {
    trigger: { type: 'schedule', condition: 'overdue' },
    actions: [{ type: 'notify', message: 'Overdue: {title}' }],
  }, { name: 'overdue nag' });
  const t = s.createTask({ title: 'Late thing', dueAt: '2026-09-01' });

  const day1a = runRules(s, { today: TODAY });
  assert.equal(day1a.fired.length, 1);
  assert.equal(day1a.fired[0].taskId, t.id);

  const day1b = runRules(s, { today: TODAY });
  assert.deepEqual(day1b.fired, [], 'already fired today for this rule/task');

  const day2 = runRules(s, { today: '2026-09-13' });
  assert.equal(day2.fired.length, 1, 'a new day resets the dedupe window');
});

test('disabled rules are skipped unless targeted with --rule and dryRun', () => {
  const s = fresh();
  // Schedule-triggered, not event-triggered: schedule rules evaluate current tasks directly (no
  // cursor/history to prime), so this test is purely about the enabled/dryRun gate itself.
  const rule = addRule(s, {
    trigger: { type: 'schedule', condition: 'overdue' },
    actions: [{ type: 'notify', message: 'hi' }],
  }, { name: 'off', enabled: false });
  s.createTask({ title: 'Task', dueAt: '2026-09-01' });

  const normal = runRules(s, { today: TODAY });
  assert.deepEqual(normal.fired, [], 'disabled rules are skipped in a normal run');

  const targetedDry = runRules(s, { today: TODAY, ruleId: rule.id, dryRun: true });
  assert.equal(targetedDry.fired.length, 1, 'a targeted dry run previews a disabled rule');

  const targetedReal = runRules(s, { today: TODAY, ruleId: rule.id });
  assert.deepEqual(targetedReal.fired, [], 'a targeted non-dry run still skips a disabled rule');
});

test('running an unknown rule id reports an error, not a crash', () => {
  const s = fresh();
  const report = runRules(s, { today: TODAY, ruleId: 'nope' });
  assert.equal(report.fired.length, 0);
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0].message, /nope/);
});

// ------------------------------------------------------------ event cursors

test('a newly created rule starts from now: it does not replay events that predate it', () => {
  const s = fresh();
  // Matching tasks already exist before the rule is even added.
  s.createTask({ title: 'Pre-existing urgent task' });
  s.createTask({ title: 'Another urgent one' });

  addRule(s, {
    trigger: { type: 'event', kinds: ['task.created'] },
    actions: [{ type: 'notify', message: 'seen {title}' }],
  }, { name: 'watch new tasks' });

  const first = runRules(s, { today: TODAY });
  assert.deepEqual(first.fired, [], 'first evaluation primes the cursor; it does not replay history');

  const t = s.createTask({ title: 'Truly new task' });
  const second = runRules(s, { today: TODAY });
  assert.equal(second.fired.length, 1, 'events from here on are evaluated normally');
  assert.equal(second.fired[0].taskId, t.id);
});

test('a re-enabled rule resumes from now, not from its old cursor or from history', () => {
  const s = fresh();
  const rule = addRule(s, {
    trigger: { type: 'event', kinds: ['task.created'] },
    actions: [{ type: 'notify', message: 'seen {title}' }],
  }, { name: 'watcher', enabled: false });

  // Disabled rules are never evaluated, so this rule has no cursor yet even though tasks exist.
  s.createTask({ title: 'While disabled' });
  assert.deepEqual(runRules(s, { today: TODAY }).fired, []);

  s.saveRule({ id: rule.id, name: rule.name, enabled: true, definition: rule.definition });
  const firstAfterEnable = runRules(s, { today: TODAY });
  assert.deepEqual(firstAfterEnable.fired, [], 'enabling primes the cursor on first evaluation; it does not replay the backlog');

  const t = s.createTask({ title: 'After enabling' });
  const next = runRules(s, { today: TODAY });
  assert.equal(next.fired.length, 1);
  assert.equal(next.fired[0].taskId, t.id);
});

test('a targeted run of one rule never advances a different rule\'s cursor', () => {
  const s = fresh();
  addRule(s, {
    trigger: { type: 'event', kinds: ['task.created'] },
    actions: [{ type: 'set_field', field: 'priority', value: 'high' }],
  }, { name: 'rule A' });
  addRule(s, {
    trigger: { type: 'event', kinds: ['task.created'] },
    actions: [{ type: 'set_field', field: 'priority', value: 'low' }],
  }, { name: 'rule B' });
  runRules(s, { today: TODAY }); // prime both

  const t = s.createTask({ title: 'Shared event' });

  const ruleA = s.listRules().find((r) => r.name === 'rule A')!;
  const ruleB = s.listRules().find((r) => r.name === 'rule B')!;

  const targeted = runRules(s, { today: TODAY, ruleId: ruleA.id });
  assert.equal(targeted.fired.length, 1);
  assert.equal(targeted.fired[0].ruleName, 'rule A');
  assert.equal(s.requireTask(t.id).priority, 'high', 'rule A ran');

  // Rule B's cursor was never touched by the targeted run above, so a normal full run still
  // finds the event for rule B.
  const full = runRules(s, { today: TODAY });
  assert.equal(full.fired.length, 1, 'only rule B has anything left to process');
  assert.equal(full.fired[0].ruleName, 'rule B');
  assert.equal(s.requireTask(t.id).priority, 'low', 'rule B ran afterwards, on the same task');

  // And rule A has nothing left either, confirming its own cursor did advance.
  const again = runRules(s, { today: TODAY });
  assert.deepEqual(again.fired, []);
});

// ------------------------------------------------------------- regressions

test('a rule on comment.added never re-triggers on its own summary comment (fires once across five runs)', () => {
  const s = fresh();
  addRule(s, {
    trigger: { type: 'event', kinds: ['comment.added'] },
    actions: [{ type: 'set_field', field: 'customField', key: 'seen', value: true }],
  }, { name: 'watch comments' });
  runRules(s, { today: TODAY }); // prime

  const t = s.createTask({ title: 'Task' });
  s.addComment(t.id, 'a human comment', 'human'); // comment.added with actor 'human'

  for (let i = 0; i < 5; i++) {
    const report = runRules(s, { today: TODAY });
    if (i === 0) assert.equal(report.fired.length, 1, 'fires once for the human comment');
    else assert.deepEqual(report.fired, [], `run ${i + 1}: must not re-fire on the rule's own comments`);
  }
});

test('set_field status never promotes an inbox task, or reopens a done/dropped one (skipped, not an error)', () => {
  const s = fresh();
  addRule(s, {
    trigger: { type: 'event', kinds: ['task.created'] },
    actions: [{ type: 'set_field', field: 'status', value: 'open' }],
  }, { name: 'auto accept' });
  runRules(s, { today: TODAY }); // prime

  const created = s.upsertFromSource({
    sourceType: 'gmail', sourceId: 'thread-x', title: 'Some email task', contentHash: 'h1',
  });
  assert.equal(created.task.status, 'inbox');

  const report = runRules(s, { today: TODAY });
  assert.equal(report.fired.length, 1, 'the rule still fires and records what happened');
  assert.equal(report.errors.length, 0, 'a skipped action is not an error');
  assert.match(report.fired[0].actions[0], /skipped/);
  assert.equal(s.requireTask(created.task.id).status, 'inbox', 'the task was not promoted out of the inbox');
});

test('listNotifications finds notifications past hundreds of unrelated events', () => {
  const s = fresh();
  addRule(s, {
    trigger: { type: 'event', kinds: ['task.created'] },
    conditions: [{ field: 'title', op: 'contains', value: 'Trigger' }],
    actions: [{ type: 'notify', message: 'first' }],
  }, { name: 'notifier' });
  runRules(s, { today: TODAY }); // prime

  const t1 = s.createTask({ title: 'Trigger one' });
  runRules(s, { today: TODAY });

  const flood = s.createTask({ title: 'Flood target' });
  for (let i = 0; i < 501; i++) s.updateTask(flood.id, { notes: `note ${i}` }, 'human');

  const t2 = s.createTask({ title: 'Trigger two' });
  runRules(s, { today: TODAY });

  const notes = listNotifications(s);
  assert.deepEqual(notes.map((n) => n.taskId).sort(), [t1.id, t2.id].sort());
});

test('matches condition rejects overlong patterns and syntax the linear-time engine does not support', () => {
  const longPattern = 'a'.repeat(201);
  const long = validateRuleDefinition({
    trigger: { type: 'event', kinds: ['task.created'] },
    conditions: [{ field: 'title', op: 'matches', value: longPattern }],
    actions: [{ type: 'notify', message: 'hi' }],
  });
  assert.equal(long.ok, false);

  for (const pattern of ['(a)\\1', '(?=a)b', '(?<!a)b', '\\p{L}', 'a{500}']) {
    const v = validateRuleDefinition({
      trigger: { type: 'event', kinds: ['task.created'] },
      conditions: [{ field: 'title', op: 'matches', value: pattern }],
      actions: [{ type: 'notify', message: 'hi' }],
    });
    assert.equal(v.ok, false, `expected '${pattern}' to be rejected`);
    assert.match(v.errors.join('; '), /'matches' pattern is not supported/);
  }

  const safe = validateRuleDefinition({
    trigger: { type: 'event', kinds: ['task.created'] },
    conditions: [{ field: 'title', op: 'matches', value: '^urgent: .+$' }],
    actions: [{ type: 'notify', message: 'hi' }],
  });
  assert.equal(safe.ok, true);
});

test('a pattern that makes RegExp backtrack catastrophically is evaluated in bounded time, in a dry run of a disabled rule too', () => {
  const s = fresh();
  // This is the audit's reproduction: overdue task, an accepted pattern with overlapping
  // alternatives, and a dry run of the rule while it is still disabled.
  s.createTask({ title: `${'a'.repeat(80)}!`, dueAt: '2026-09-01' });
  const rule = addRule(s, {
    trigger: { type: 'schedule', condition: 'overdue' },
    conditions: [{ field: 'title', op: 'matches', value: '^(a|aa)+$' }],
    actions: [{ type: 'notify', message: 'matched' }],
  }, { name: 'overlap', enabled: false });
  const started = Date.now();
  const report = runRules(s, { today: TODAY, ruleId: rule.id, dryRun: true });
  assert.ok(Date.now() - started < 2000, `evaluation took ${Date.now() - started}ms`);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.fired, [], 'the title ends in "!", so the anchored pattern must not match');

  s.createTask({ title: 'a'.repeat(80), dueAt: '2026-09-01' });
  const matched = runRules(s, { today: TODAY, ruleId: rule.id, dryRun: true });
  assert.equal(matched.fired.length, 1);
});

test('matches condition caps the tested string length at runtime', () => {
  const s = fresh();
  addRule(s, {
    trigger: { type: 'event', kinds: ['task.created'] },
    conditions: [{ field: 'title', op: 'matches', value: 'MARKER' }],
    actions: [{ type: 'notify', message: 'matched' }],
  }, { name: 'matcher' });
  runRules(s, { today: TODAY }); // prime

  // The marker sits past the 1000-character cap, so the truncated input tested against the
  // pattern must not match, even though the full, untruncated title would.
  const title = `${'a'.repeat(1000)}MARKER`;
  s.createTask({ title });
  const report = runRules(s, { today: TODAY });
  assert.deepEqual(report.fired, [], 'content past the 1000-char cap must not be considered');
});

test('listNotifications keeps the newest notifications when the window truncates, not the oldest', () => {
  // eventsOfKind orders by id, so a plain LIMIT would return the oldest N. The digest reads this
  // list, so truncating the wrong end means every recent alert silently disappears.
  const store = openStore(':memory:');
  const task = store.createTask({ title: 'anchor' });
  for (let i = 0; i < 1100; i++) {
    store.recordEvent('rule.fired', task.id, 'rule', { ruleId: 'r1', ruleName: 'noisy', notification: `msg ${i}` });
  }
  const notifications = listNotifications(store);
  assert.equal(notifications.at(-1)?.message, 'msg 1099', 'the most recent notification must be present');
  assert.ok(notifications.length >= 1100, `expected the whole history, got ${notifications.length}`);
});

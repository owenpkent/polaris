import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, type Store } from '../core/index.ts';
import { buildDigest, markDigestDelivered } from './digest.ts';
import { validateRuleDefinition } from './rules.ts';

const TODAY = '2026-09-12';

function seed(): Store {
  let clock = `${TODAY}T08:00:00.000Z`;
  const s = openStore(':memory:', { now: () => clock, nextOccurrence: () => null });

  const p = s.upsertProject({ slug: 'nimbus', name: 'Project Nimbus' });

  s.upsertFromSource({
    sourceType: 'gmail', sourceId: 'thread-1', title: 'Send the film cut', dueAt: '2026-09-18',
    sourceUrl: 'https://mail.google.com/thread-1', contentHash: 'h1',
  });

  s.createTask({ title: 'Overdue report', projectId: p.id, dueAt: '2026-09-05', priority: 'high' });
  s.createTask({ title: 'Due today', projectId: p.id, dueAt: TODAY });
  s.createTask({ title: 'Due this week', projectId: p.id, dueAt: '2026-09-16' });
  s.createTask({ title: 'Waiting on vendor', projectId: p.id, status: 'waiting' });
  s.createTask({ title: 'Launch', projectId: p.id, isMilestone: true, dueAt: '2026-09-30' });
  s.createTask({ title: 'Milestone too far out', projectId: p.id, isMilestone: true, dueAt: '2026-11-01' });

  clock = '2026-09-11T18:00:00.000Z'; // within the true 24h window ending at nowIso (2026-09-12T08:00Z)
  s.createTask({ title: 'Shipped yesterday', projectId: p.id, status: 'done' });

  clock = '2026-08-01T00:00:00.000Z'; // long ago
  s.createTask({ title: 'Shipped ages ago', projectId: p.id, status: 'done' });

  clock = `${TODAY}T08:00:00.000Z`;
  s.setKv('sync.github.lastAt', '2026-09-12T07:00:00.000Z');

  return s;
}

test('buildDigest never writes to the store', () => {
  const s = seed();
  const before = s.lastEventId();
  buildDigest(s, { today: TODAY, nowIso: `${TODAY}T08:00:00.000Z` });
  assert.equal(s.lastEventId(), before);
  assert.equal(s.getKv('digest.lastAt'), undefined);
});

test('buildDigest sections and counts reflect the seeded store', () => {
  const s = seed();
  const digest = buildDigest(s, { today: TODAY, nowIso: `${TODAY}T08:00:00.000Z` });

  assert.equal(digest.date, TODAY);
  assert.equal(digest.counts.inbox, 1);
  assert.equal(digest.counts.overdue, 1);
  assert.equal(digest.counts.today, 2, 'due today + overdue both count as due-or-before-today');
  assert.equal(digest.counts.upcoming, 1);
  assert.equal(digest.counts.waiting, 1);
  assert.equal(digest.counts.milestones, 1, 'only the milestone within 30 days counts');
  assert.equal(digest.counts.completed, 1, 'only the recent completion counts');
  assert.equal(digest.counts.notifications, 0);

  assert.match(digest.markdown, /# Command Center Digest - 2026-09-12/);
  assert.match(digest.markdown, /Send the film cut/);
  assert.match(digest.markdown, /gmail/);
  assert.match(digest.markdown, /https:\/\/mail\.google\.com\/thread-1/);
  assert.match(digest.markdown, /Overdue report/);
  assert.match(digest.markdown, /Project Nimbus/);
  assert.match(digest.markdown, /\[high\]/);
  assert.match(digest.markdown, /Shipped yesterday/);
  assert.doesNotMatch(digest.markdown, /Shipped ages ago/);
  assert.doesNotMatch(digest.markdown, /Milestone too far out/);
  assert.match(digest.markdown, /github: 2026-09-12T07:00:00\.000Z/);
  assert.match(digest.markdown, /repo-files: never/);
  // Jobs that no longer exist must not be reported as stale forever.
  assert.doesNotMatch(digest.markdown, /^- (git|gmail|drive|calendar): /m);
});

test('empty sections render one short line, not an empty heading', () => {
  const s = openStore(':memory:', { now: () => `${TODAY}T00:00:00.000Z`, nextOccurrence: () => null });
  const digest = buildDigest(s, { today: TODAY, nowIso: `${TODAY}T08:00:00.000Z` });
  assert.match(digest.markdown, /\*\*Inbox:\*\* nothing to triage\./);
  assert.match(digest.markdown, /\*\*Overdue:\*\* none\./);
  assert.match(digest.markdown, /\*\*Notifications:\*\* none since the last digest\./);
  assert.doesNotMatch(digest.markdown, /## Overdue/);
});

test('markDigestDelivered writes kv, and later digests only report notifications since then', () => {
  const s = seed();
  const rule = (() => {
    const v = validateRuleDefinition({
      trigger: { type: 'event', kinds: ['task.created'] },
      actions: [{ type: 'notify', message: 'hello {title}' }],
    });
    assert.ok(v.ok);
    return s.saveRule({ name: 'greeter', enabled: true, definition: v.normalized! });
  })();
  void rule;

  markDigestDelivered(s, `${TODAY}T08:30:00.000Z`);
  assert.equal(s.getKv<string>('digest.lastAt'), `${TODAY}T08:30:00.000Z`);
});

test('completed section uses a true 24 hour window anchored on nowIso', () => {
  let clock = '2026-09-12T11:59:00.000Z';
  const s = openStore(':memory:', { now: () => clock, nextOccurrence: () => null });

  clock = '2026-09-11T12:01:00.000Z'; // 23h58m before nowIso: inside the window
  const justInside = s.createTask({ title: 'Just inside', status: 'done' }).id;

  clock = '2026-09-11T11:59:00.000Z'; // 24h01m before nowIso: outside the window
  const justOutside = s.createTask({ title: 'Just outside', status: 'done' }).id;

  const digest = buildDigest(s, { today: TODAY, nowIso: '2026-09-12T12:00:00.000Z' });
  const ids = new Set(digest.markdown.match(/\[t_[a-z0-9]+\]/g) ?? []);
  assert.ok(ids.has(`[${justInside}]`));
  assert.ok(!ids.has(`[${justOutside}]`));
  assert.equal(digest.counts.completed, 1);
});

test('buildDigest defaults nowIso to the current instant when omitted', () => {
  const s = openStore(':memory:', { now: () => new Date().toISOString(), nextOccurrence: () => null });
  const t = s.createTask({ title: 'Just finished' });
  s.completeTask(t.id);
  const digest = buildDigest(s, { today: TODAY });
  assert.equal(digest.counts.completed, 1);
});

// ---- goals section ----

test('goals: the section is left out entirely until a goal exists', () => {
  const store = openStore(':memory:');
  const digest = buildDigest(store, { today: '2026-09-18', nowIso: '2026-09-18T12:00:00.000Z' });
  assert.doesNotMatch(digest.markdown, /Goals/);
  assert.equal(digest.counts.goals, undefined);
});

test('goals: a healthy goal is listed with its status and progress and no attention flag', () => {
  const store = openStore(':memory:', { now: () => '2026-09-17T09:00:00.000Z' });
  const goal = store.createGoal({ title: 'Ship the installer', periodLabel: '2026 Q4' });
  const done = store.createTask({ title: 'Buy the certificate' });
  const open = store.createTask({ title: 'Sign the build' });
  store.linkGoal(goal.id, { taskId: done.id });
  store.linkGoal(goal.id, { taskId: open.id });
  store.completeTask(done.id);

  const digest = buildDigest(store, { today: '2026-09-18', nowIso: '2026-09-18T12:00:00.000Z' });
  assert.match(digest.markdown, /## Goals \(1, 0 need attention\)/);
  const goalLines = digest.markdown.split('\n').filter((l) => l.includes('Ship the installer'));
  assert.deepEqual(goalLines, [`- [${goal.id}] Ship the installer (2026 Q4): on track, 1 of 2 done (50%)`]);
  assert.equal(digest.counts.goals, 1);
  assert.equal(digest.counts.goalsNeedingAttention, 0);
});

test('goals: a goal with no open task is flagged as stalled', () => {
  const store = openStore(':memory:', { now: () => '2026-09-17T09:00:00.000Z' });
  store.createGoal({ title: 'Grow the audience' });
  const digest = buildDigest(store, { today: '2026-09-18', nowIso: '2026-09-18T12:00:00.000Z' });
  assert.match(digest.markdown, /Grow the audience: on track, nothing to measure yet\. Needs attention: stalled: no open task/);
  assert.equal(digest.counts.goalsNeedingAttention, 1);
});

test('goals: no status update for 14 days is flagged, 13 days is not', () => {
  const store = openStore(':memory:', { now: () => '2026-09-01T09:00:00.000Z' });
  const goal = store.createGoal({ title: 'Finish the screenplay' });
  const task = store.createTask({ title: 'Write act two' });
  store.linkGoal(goal.id, { taskId: task.id });

  const day13 = buildDigest(store, { today: '2026-09-14', nowIso: '2026-09-14T12:00:00.000Z' });
  assert.doesNotMatch(day13.markdown, /no status update/);
  const day14 = buildDigest(store, { today: '2026-09-15', nowIso: '2026-09-15T12:00:00.000Z' });
  assert.match(day14.markdown, /Needs attention: no status update in 14 days/);
});

test('goals: a manual goal shows its value, and goals needing attention are listed first', () => {
  const store = openStore(':memory:', { now: () => '2026-09-17T09:00:00.000Z' });
  const healthy = store.createGoal({ title: 'Healthy goal' });
  const task = store.createTask({ title: 'Keep going' });
  store.linkGoal(healthy.id, { taskId: task.id });
  store.createGoal({ title: 'Subscribers', progressMode: 'manual', currentValue: 250, targetValue: 1000, unit: 'subscribers', status: 'at_risk' });

  const digest = buildDigest(store, { today: '2026-09-18', nowIso: '2026-09-18T12:00:00.000Z' });
  assert.match(digest.markdown, /Subscribers: at risk, 250 of 1000 subscribers \(25%\)\. Needs attention: stalled: no open task/);
  assert.ok(digest.markdown.indexOf('Subscribers') < digest.markdown.indexOf('Healthy goal'), 'the flagged goal comes first');
});

test('goals: achieved and dropped goals are not in the digest', () => {
  const store = openStore(':memory:', { now: () => '2026-09-17T09:00:00.000Z' });
  store.createGoal({ title: 'Already done', status: 'achieved' });
  store.createGoal({ title: 'Gave up', status: 'dropped' });
  const digest = buildDigest(store, { today: '2026-09-18', nowIso: '2026-09-18T12:00:00.000Z' });
  assert.doesNotMatch(digest.markdown, /Already done|Gave up|## Goals/);
});

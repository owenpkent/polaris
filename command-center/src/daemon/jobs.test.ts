import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { App } from '../app.ts';
import { openStore } from '../core/index.ts';
import { emptyReport } from '../ingest/common.ts';
import { memorySecretStore } from '../ingest/secrets.ts';
import { dueAtStartup, JOBS, reportLine, runJob, SkippedError, type JobDefinition } from './jobs.ts';

// A self-contained fake App: no real repo/dev paths, no real database file, no network. Only the
// 'rules' job (pure, local, no I/O beyond the in-memory store) is ever actually run from JOBS;
// every other scenario below uses a synthetic JobDefinition so nothing here can start a real
// GitHub/Google sync or write outside a temp directory.
function fakeApp(today = '2026-09-12'): App {
  const store = openStore(':memory:');
  return {
    config: { repoRoot: 'C:/cc-test-no-such-dir', dbPath: ':memory:', timezone: 'UTC', dashboardDir: 'C:/cc-test-no-such-dir' },
    store,
    secrets: memorySecretStore(),
    today: () => today,
    close: () => store.db.close(),
  };
}

// ---- JOBS catalog invariants ----

test('JOBS is non-empty and every job name is unique', () => {
  assert.ok(JOBS.length > 0);
  const names = JOBS.map((j) => j.name);
  assert.equal(new Set(names).size, names.length);
});

test('every job has a non-empty name and summary, and a run function', () => {
  for (const j of JOBS) {
    assert.equal(typeof j.name, 'string');
    assert.ok(j.name.length > 0);
    assert.equal(typeof j.summary, 'string');
    assert.ok(j.summary.length > 0, `${j.name} has an empty summary`);
    assert.equal(typeof j.run, 'function');
  }
});

test('every job declares exactly one of everyMs or dailyAt, never both and never neither', () => {
  for (const j of JOBS) {
    const hasEvery = j.everyMs !== undefined;
    const hasDaily = j.dailyAt !== undefined;
    assert.notEqual(hasEvery, hasDaily, `${j.name} must set exactly one of everyMs/dailyAt`);
  }
});

test('everyMs cadences are positive and within a sane range (1 minute to 24 hours)', () => {
  for (const j of JOBS) {
    if (j.everyMs === undefined) continue;
    assert.ok(Number.isFinite(j.everyMs) && j.everyMs > 0, `${j.name}.everyMs must be positive`);
    assert.ok(j.everyMs >= 60_000, `${j.name}.everyMs is under a minute`);
    assert.ok(j.everyMs <= 24 * 60 * 60_000, `${j.name}.everyMs is over a day`);
  }
});

test('dailyAt cadences are HH:MM 24-hour times', () => {
  for (const j of JOBS) {
    if (j.dailyAt === undefined) continue;
    assert.match(j.dailyAt, /^([01]\d|2[0-3]):[0-5]\d$/, `${j.name}.dailyAt "${j.dailyAt}" is not HH:MM`);
  }
});

test('the rules job runs at least once a minute (fast enough to matter for automation timeliness)', () => {
  const rules = JOBS.find((j) => j.name === 'rules');
  assert.ok(rules);
  assert.equal(rules!.everyMs, 60_000);
});

test('the digest job is scheduled once a day, not on a short interval', () => {
  const digest = JOBS.find((j) => j.name === 'digest');
  assert.ok(digest);
  assert.equal(digest!.everyMs, undefined);
  assert.match(digest!.dailyAt!, /^\d{2}:\d{2}$/);
});

test('every job name is a short lowercase token suitable for a kv key and a CLI arg', () => {
  for (const j of JOBS) {
    assert.match(j.name, /^[a-z][a-z-]*[a-z]$/, `${j.name} should be lowercase, hyphenated`);
  }
});

// ---- SkippedError ----

test('SkippedError is a distinct Error subclass', () => {
  const e = new SkippedError('google auth not configured');
  assert.ok(e instanceof Error);
  assert.ok(e instanceof SkippedError);
  assert.equal(e.message, 'google auth not configured');
});

// ---- runJob bookkeeping (synthetic jobs only; never touches JOBS' real network/file jobs) ----

function syntheticJob(overrides: Partial<JobDefinition> & Pick<JobDefinition, 'run'>): JobDefinition {
  return { name: 'synthetic', summary: 'a test job', everyMs: 60_000, ...overrides };
}

test('runJob on success: returns ok, records lastAt and clears lastError in the store', async () => {
  const app = fakeApp();
  const job = syntheticJob({ name: 'good', run: async () => 'all good' });
  const outcome = await runJob(app, job);
  assert.equal(outcome.name, 'good');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.skipped, false);
  assert.equal(outcome.message, 'all good');
  assert.ok(outcome.ms >= 0);
  assert.ok(app.store.getKv<string>('sync.good.lastAt'));
  assert.equal(app.store.getKv('sync.good.lastError'), null);
  app.close();
});

test('runJob on failure: returns ok:false, records lastError, and does not set lastAt', async () => {
  const app = fakeApp();
  const job = syntheticJob({ name: 'bad', run: async () => { throw new Error('kaboom'); } });
  const outcome = await runJob(app, job);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.skipped, false);
  assert.match(outcome.message, /^bad: FAILED kaboom$/);
  assert.match(app.store.getKv<string>('sync.bad.lastError') ?? '', /kaboom/);
  assert.equal(app.store.getKv('sync.bad.lastAt'), undefined);
  app.close();
});

test('runJob on a SkippedError: reports ok:true, skipped:true, and clears lastError (not a failure)', async () => {
  const app = fakeApp();
  const job = syntheticJob({ name: 'skippy', run: async () => { throw new SkippedError('google auth not configured'); } });
  const outcome = await runJob(app, job);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.skipped, true);
  assert.equal(outcome.message, 'skippy: skipped (google auth not configured)');
  assert.equal(app.store.getKv('sync.skippy.lastError'), null);
  app.close();
});

test('the import job without an initiatives/ folder is skipped, not failed, and touches nothing', async () => {
  // fakeApp's repoRoot does not exist, so there is no initiatives/ to read: the public repo and an
  // installed desktop app look the same. The job reads only that folder, so it is safe to run here.
  const app = fakeApp();
  const importJob = JOBS.find((j) => j.name === 'import')!;
  const outcome = await runJob(app, importJob);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.skipped, true);
  assert.match(outcome.message, /^import: skipped \(no initiatives folder at /);
  assert.equal(app.store.getKv('sync.import.lastError'), null);
  assert.equal(app.store.listProjects({ includeArchived: true }).length, 0);
  app.close();
});

test('runJob never throws, even when the job throws a non-Error value', async () => {
  const app = fakeApp();
  const job = syntheticJob({ name: 'weird', run: async () => { throw 'a plain string'; } });
  const outcome = await runJob(app, job);
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /a plain string/);
  app.close();
});

test('runJob truncates a very long error message in the stored kv value but not in the returned outcome', async () => {
  const app = fakeApp();
  const longMessage = 'x'.repeat(3000);
  const job = syntheticJob({ name: 'verbose', run: async () => { throw new Error(longMessage); } });
  const outcome = await runJob(app, job);
  assert.equal(outcome.ok, false);
  assert.ok(outcome.message.length > 2000, 'the returned outcome message should not be truncated');
  const stored = app.store.getKv<string>('sync.verbose.lastError');
  assert.ok(stored);
  assert.equal(stored!.length, 2000);
  app.close();
});

test('runJob overwrites a previous failure once a later run succeeds', async () => {
  const app = fakeApp();
  const failing = syntheticJob({ name: 'flaky', run: async () => { throw new Error('first try fails'); } });
  await runJob(app, failing);
  assert.match(app.store.getKv<string>('sync.flaky.lastError') ?? '', /first try fails/);

  const succeeding = syntheticJob({ name: 'flaky', run: async () => 'now it works' });
  const outcome = await runJob(app, succeeding);
  assert.equal(outcome.ok, true);
  assert.equal(app.store.getKv('sync.flaky.lastError'), null);
  app.close();
});

test('runJob passes the log function through to the job body', async () => {
  const app = fakeApp();
  const lines: string[] = [];
  const job = syntheticJob({ name: 'logger', run: async (_app, log) => { log('line one'); log('line two'); return 'done'; } });
  await runJob(app, job, (line) => lines.push(line));
  assert.deepEqual(lines, ['line one', 'line two']);
  app.close();
});

test('runJob defaults to a no-op logger when none is passed', async () => {
  const app = fakeApp();
  const job = syntheticJob({ name: 'silent', run: async (_app, log) => { log('should not throw even though nothing listens'); return 'ok'; } });
  await assert.doesNotReject(runJob(app, job));
  app.close();
});

// ---- the real 'rules' job, the only JOBS entry exercised here (pure/local, no network) ----

test('the real "rules" job from JOBS runs against a fresh store with nothing to fire and reports zero fired', async () => {
  const app = fakeApp();
  const rules = JOBS.find((j) => j.name === 'rules')!;
  const outcome = await runJob(app, rules);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.message, 'rules: 0 fired');
  app.close();
});

test('running the real "rules" job never enables or completes anything on its own (propose, do not act)', async () => {
  const app = fakeApp();
  const rule = app.store.saveRule({
    name: 'agent-created rule',
    enabled: false,
    definition: { trigger: { type: 'schedule', condition: 'overdue' }, conditions: [], actions: [{ type: 'notify', message: 'hi' }] },
  });
  app.store.createTask({ title: 'overdue thing', dueAt: '2020-01-01' }, 'human');
  const rulesJob = JOBS.find((j) => j.name === 'rules')!;
  await runJob(app, rulesJob);
  // A disabled rule stays disabled; running the scheduled job body is not a way to enable it.
  assert.equal(app.store.getRule(rule.id)?.enabled, false);
  app.close();
});

test('runJob: a GitHub sync with no sign-in is a skipped job, not a failed one', async () => {
  // The report shape the GitHub syncs return when resolveGithubAuth throws GithubNotSignedInError.
  const report = { ...emptyReport('github'), partial: true, errors: ['skipped: Not signed in to GitHub. Connect the GitHub App from the GitHub page in the dashboard.'] };
  const job: JobDefinition = { name: 'github', summary: 'x', everyMs: 60_000, async run() { return reportLine(report); } };
  const outcome = await runJob({ store: openStore(':memory:') } as unknown as App, job);
  assert.equal(outcome.ok, true, 'a skip is not a failure, so no lastError is recorded');
  assert.equal(outcome.skipped, true);
  assert.match(outcome.message, /Not signed in to GitHub/);
});

// ---- startup pass ----

test('dueAtStartup: interval jobs always, plain daily jobs never, a catchUp daily job only when its last success is over a day old', () => {
  const app = fakeApp();
  try {
    const run = async () => '';
    const now = new Date('2026-09-21T12:00:00Z');
    assert.equal(dueAtStartup(app, { name: 'i', summary: 's', everyMs: 60_000, run }, now), true);
    assert.equal(dueAtStartup(app, { name: 'd', summary: 's', dailyAt: '07:30', run }, now), false);

    const job: JobDefinition = { name: 'c', summary: 's', dailyAt: '03:15', catchUp: true, run };
    assert.equal(dueAtStartup(app, job, now), true, 'never run');
    app.store.setKv('sync.c.lastAt', '2026-09-21T03:15:00Z');
    assert.equal(dueAtStartup(app, job, now), false, 'ran this morning');
    app.store.setKv('sync.c.lastAt', '2026-09-19T03:15:00Z');
    assert.equal(dueAtStartup(app, job, now), true, 'machine was off for two nights');
  } finally {
    app.close();
  }
});

test('the backup job catches up at startup, and the digest does not', () => {
  assert.equal(JOBS.find((j) => j.name === 'backup')?.catchUp, true);
  assert.equal(JOBS.find((j) => j.name === 'digest')?.catchUp, undefined);
});

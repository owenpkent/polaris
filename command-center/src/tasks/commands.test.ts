import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeApp } from '../http/test-support.ts';
import { commands } from './commands.ts';

const cmd = (name: string) => commands.find((c) => c.name === name)!;

test('thread post and thread show: the owner opens a thread from the command line and reads it back', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const task = app.store.createTask({ title: 'Why does the solver stall?' }, 'human');
  const out: string[] = [];
  const ctx = { openApp: () => ({ ...app, close: () => undefined }), stdout: (s: string) => out.push(s), stderr: () => undefined };

  assert.equal(await cmd('thread show').run([task.id], ctx), 0);
  assert.match(out.at(-1)!, /^No thread on t_/);

  assert.equal(await cmd('thread post').run([task.id, '--type', 'claim', '--confidence', 'low', 'It', 'is', 'a', 'cache', 'miss.'], ctx), 0);
  const thread = app.store.getThreadForTask(task.id)!;
  const [claim] = app.store.listPosts(thread.id);
  assert.equal(claim.author, 'human');
  assert.equal(claim.body, 'It is a cache miss.');
  assert.equal(claim.confidence, 'low');
  assert.match(out.at(-1)!, new RegExp(`${claim.id} claim owner confidence low \\[open\\]\\n    It is a cache miss\\.$`));

  assert.equal(await cmd('thread post').run([task.id, '--type', 'objection', '--refs', claim.id, '--reply-to', claim.id, 'Profile', 'says', 'no.'], ctx), 0);
  const [, objection] = app.store.listPosts(thread.id);
  assert.deepEqual(objection.refs, [claim.id]);
  assert.equal(objection.parentPostId, claim.id);

  assert.equal(await cmd('thread show').run([task.id], ctx), 0);
  assert.match(out.at(-1)!, /^Why does the solver stall\? \(th_[0-9a-z]+\) on \[ \] t_/);
  assert.match(out.at(-1)!, /open, 2 post\(s\)/);
  assert.ok(out.at(-1)!.includes(`refs ${claim.id}`));
  assert.equal(await cmd('thread show').run([task.id, '--after', claim.id, '--json'], ctx), 0);
  assert.deepEqual(JSON.parse(out.at(-1)!).posts.map((p: { id: string }) => p.id), [objection.id]);

  assert.throws(() => cmd('thread post').run([task.id, '--type', 'verdict', 'x'], ctx), /--type must be one of/);
  assert.throws(() => cmd('thread post').run([task.id, '--type', 'claim'], ctx), /body is required/);
  assert.equal(app.store.listPosts(thread.id).length, 2);
});

test('thread list, judge, pin, set, close, reopen, fork, and search: the owner\'s stage 2 controls from the command line', async (t) => {
  const app = fakeApp();
  t.after(() => app.close());
  const task = app.store.createTask({ title: 'Why does the solver stall?' }, 'human');
  const thread = app.store.createThread(task.id, null, 'human');
  const claim = app.store.addPost(thread.id, { type: 'claim', body: 'Cache miss.' }, 'agent', { actor: 'agent', name: 'scribe' });
  const summary = app.store.addPost(thread.id, { type: 'summary', body: 'Where we are.' }, 'agent', { actor: 'agent', name: 'scribe' });
  const out: string[] = [];
  const ctx = { openApp: () => ({ ...app, close: () => undefined }), stdout: (s: string) => out.push(s), stderr: () => undefined };

  assert.equal(await cmd('thread judge').run([claim.id, 'accepted'], ctx), 0);
  assert.match(out.at(-1)!, /\[accepted\]/);
  assert.equal(app.store.getPost(claim.id)!.status, 'accepted');
  assert.throws(() => cmd('thread judge').run([claim.id, 'done'], ctx), /status must be one of/);
  assert.throws(() => cmd('thread judge').run([summary.id, 'accepted'], ctx), /carries no status/);

  assert.equal(await cmd('thread pin').run([task.id, summary.id], ctx), 0);
  assert.equal(app.store.getThread(thread.id)!.pinnedPostId, summary.id);
  assert.equal(await cmd('thread show').run([task.id], ctx), 0);
  assert.match(out.at(-1)!, /\nPinned state:\n/);
  assert.equal(await cmd('thread pin').run([task.id, 'none'], ctx), 0);
  assert.equal(app.store.getThread(thread.id)!.pinnedPostId, null);

  assert.equal(await cmd('thread set').run([task.id, '--hide-authors', 'on', '--daily-cap', '4'], ctx), 0);
  assert.match(out.at(-1)!, /authors hidden, daily cap 4\./);
  assert.throws(() => cmd('thread set').run([task.id, '--daily-cap', 'lots'], ctx), /positive whole number/);
  assert.throws(() => cmd('thread set').run([task.id, '--hide-authors', 'maybe'], ctx), /on or off/);
  assert.throws(() => cmd('thread set').run([task.id], ctx), /Nothing to change/);
  assert.equal(await cmd('thread set').run([task.id, '--daily-cap', 'none', '--hide-authors', 'off'], ctx), 0);
  assert.match(out.at(-1)!, /authors shown, daily cap none\./);

  assert.equal(await cmd('thread list').run([], ctx), 0);
  assert.match(out.at(-1)!, new RegExp(`^${thread.id}  open  ${task.id}  Why does the solver stall\\?  posts 2  open claims 0  unanswered objections 0  accepted results 0  0 day\\(s\\) since a verdict$`));
  assert.throws(() => cmd('thread list').run(['--status', 'stale'], ctx), /open or closed/);

  assert.equal(await cmd('thread close').run([task.id], ctx), 0);
  assert.match(out.at(-1)!, /^Closed th_/);
  assert.equal(await cmd('thread list').run(['--status', 'open'], ctx), 0);
  assert.equal(out.at(-1), 'No threads.');
  assert.equal(await cmd('thread reopen').run([task.id], ctx), 0);
  assert.equal(app.store.getThread(thread.id)!.status, 'open');

  assert.equal(await cmd('thread fork').run([task.id, 'Approach', 'B'], ctx), 0);
  assert.match(out.at(-1)!, /^Closed th_[0-9a-z]+; continued in th_[0-9a-z]+ on \[ \] t_[0-9a-z]+ Approach B$/);
  const forked = app.store.getThread(thread.id)!;
  assert.equal(forked.status, 'closed');
  assert.ok(forked.successorThreadId);
  assert.throws(() => cmd('thread fork').run([task.id], ctx), /title for the fork/);

  assert.equal(await cmd('thread search').run(['--type', 'claim', '--status', 'accepted', 'cache'], ctx), 0);
  assert.match(out.at(-1)!, new RegExp(`^${task.id} Why does the solver stall\\? / Why does the solver stall\\?\\n.*${claim.id} claim agent scribe \\[accepted\\]`));
  assert.equal(await cmd('thread search').run(['nothing', 'like', 'it'], ctx), 0);
  assert.equal(out.at(-1), 'No posts match.');
  assert.equal(await cmd('thread search').run(['--json', '--task', task.id], ctx), 0);
  assert.equal(JSON.parse(out.at(-1)!).length, 2);
  assert.throws(() => cmd('thread search').run(['--type', 'verdict'], ctx), /--type must be one of/);
});

test('tasks import: dry run, real run, and a failing file from the command line', async (t) => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const app = fakeApp();
  t.after(() => app.close());
  const dir = mkdtempSync(join(tmpdir(), 'cc-import-'));
  const good = join(dir, 'good.txt');
  const bad = join(dir, 'bad.csv');
  writeFileSync(good, '- A\n  - B\n');
  writeFileSync(bad, 'title,due\nx,soon\n');
  const out: string[] = [];
  const err: string[] = [];
  const ctx = { openApp: () => ({ ...app, close: () => undefined }), stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) };

  assert.equal(await cmd('tasks import').run([good, '--dry-run'], ctx), 0);
  assert.match(out.at(-1)!, /Dry run: 2 task\(s\)/);
  assert.equal(app.store.countTasks({}), 0);

  assert.equal(await cmd('tasks import').run([good], ctx), 0);
  assert.match(out.at(-1)!, /Created 2 task\(s\) from lines/);
  assert.equal(app.store.countTasks({}), 2);

  assert.equal(await cmd('tasks import').run([bad, '--format', 'csv'], ctx), 1);
  assert.match(err.at(-1)!, /^line 2: invalid due date/);
  assert.equal(app.store.countTasks({}), 2);
  assert.throws(() => cmd('tasks import').run([good, '--format', 'xml'], ctx), /--format must be/);
});

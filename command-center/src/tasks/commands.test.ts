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

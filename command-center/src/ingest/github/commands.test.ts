import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openApp } from '../../app.ts';
import { warnIfNotLoopback } from '../../http/commands.ts';
import { commands } from './commands.ts';

const webhookCommand = commands.find((c) => c.name === 'github webhook')!;

async function runWebhook(args: string[]): Promise<{ out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const previous = process.env.GITHUB_WEBHOOK_SECRET;
  process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
  try {
    const done = webhookCommand.run(args, {
      openApp: () => openApp({ dbPath: ':memory:' }),
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
    });
    while (!out.some((line) => line.includes('listening on'))) await new Promise((r) => setTimeout(r, 5));
    process.emit('SIGTERM');
    assert.equal(await done, 0);
  } finally {
    if (previous === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
    else process.env.GITHUB_WEBHOOK_SECRET = previous;
  }
  return { out, err };
}

test('github webhook: binds to loopback by default', async () => {
  const { out, err } = await runWebhook(['--port', '0']);
  assert.match(out.join('\n'), /listening on 127\.0\.0\.1:\d+/);
  assert.deepEqual(err, []);
});

// The warning itself, checked without binding a public interface in a test.
test('github webhook: shares serve\'s warning for a non-loopback host', () => {
  const err: string[] = [];
  warnIfNotLoopback('0.0.0.0', (s) => err.push(s));
  warnIfNotLoopback('127.0.0.1', (s) => err.push(s));
  assert.equal(err.length, 1);
  assert.match(err[0], /not a loopback address/);
});

test('github webhook: refuses to start without a secret', async () => {
  const previous = process.env.GITHUB_WEBHOOK_SECRET;
  delete process.env.GITHUB_WEBHOOK_SECRET;
  try {
    const err: string[] = [];
    const code = await webhookCommand.run([], { openApp: () => { throw new Error('not opened'); }, stdout: () => {}, stderr: (s) => err.push(s) });
    assert.equal(code, 1);
    assert.match(err.join('\n'), /GITHUB_WEBHOOK_SECRET is not set/);
  } finally {
    if (previous !== undefined) process.env.GITHUB_WEBHOOK_SECRET = previous;
  }
});

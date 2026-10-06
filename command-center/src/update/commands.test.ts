import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commands, DEFAULT_PORT, parseUpdateArgs } from './commands.ts';

const here = dirname(fileURLToPath(import.meta.url));
const update = commands.find((c) => c.name === 'update')!;

test('the update command is registered, with --check, --yes, and --port in its usage', () => {
  assert.ok(update);
  assert.match(update.usage ?? '', /--check/);
  assert.match(update.usage ?? '', /--yes/);
  assert.match(update.usage ?? '', /--port/);
  const cli = readFileSync(join(here, '..', 'cli.ts'), 'utf8');
  assert.match(cli, /from '\.\/update\/commands\.ts'/);
});

test('flags: --check, --yes, --port, and nothing else', () => {
  assert.deepEqual(parseUpdateArgs([]), { checkOnly: false, yes: false, port: DEFAULT_PORT });
  assert.deepEqual(parseUpdateArgs(['--check']), { checkOnly: true, yes: false, port: 8788 });
  assert.deepEqual(parseUpdateArgs(['--yes', '--port', '8790']), { checkOnly: false, yes: true, port: 8790 });
  assert.deepEqual(parseUpdateArgs(['--port=8790']), { checkOnly: false, yes: false, port: 8790 });
  assert.throws(() => parseUpdateArgs(['--port', 'eighty']), /--port must be a port number/);
  assert.throws(() => parseUpdateArgs(['--port', '0']), /--port must be a port number/);
  assert.throws(() => parseUpdateArgs(['--port', '70000']), /--port must be a port number/);
  assert.throws(() => parseUpdateArgs(['--release']), /Unknown option --release/);
  assert.throws(() => parseUpdateArgs(['v2.1.0']), /takes no arguments/);
});

test('a bad flag is reported and nothing runs', async () => {
  const err: string[] = [];
  const code = await update.run(['--port', 'x'], { openApp: () => { throw new Error('must not open the store'); }, stdout: () => {}, stderr: (l) => err.push(l) });
  assert.equal(code, 1);
  assert.match(err.join('\n'), /--port must be a port number/);
});

test('commands.ts starts no program itself: no child_process, and run.ts behind a dynamic import only', () => {
  const source = readFileSync(join(here, 'commands.ts'), 'utf8');
  assert.ok(!source.includes('child_process'));
  assert.ok(!/^import .* from '\.\/run\.ts';$/m.test(source), 'no static import of run.ts');
  assert.ok(!/^import .* from '\.\/(exec|git|restart|health)\.ts';$/m.test(source), 'none of the modules that run programs');
  assert.match(source, /await import\('\.\/run\.ts'\)/);
});

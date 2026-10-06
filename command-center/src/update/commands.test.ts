import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commands, DEFAULT_PORT, parseUpdateArgs } from './commands.ts';

const here = dirname(fileURLToPath(import.meta.url));
const update = commands.find((c) => c.name === 'update')!;

test('the update command is registered, with every flag in its usage', () => {
  assert.ok(update);
  for (const flag of ['--release', '--to vX.Y.Z', '--check', '--trust-signers', '--yes', '--port']) assert.ok((update.usage ?? '').includes(flag), flag);
  const cli = readFileSync(join(here, '..', 'cli.ts'), 'utf8');
  assert.match(cli, /from '\.\/update\/commands\.ts'/);
});

const main = { kind: 'main' } as const;

test('flags: --release, --to, --check, --trust-signers, --yes, --port, and nothing else', () => {
  assert.deepEqual(parseUpdateArgs([]), { target: main, checkOnly: false, trustSigners: false, yes: false, port: DEFAULT_PORT });
  assert.deepEqual(parseUpdateArgs(['--check']), { target: main, checkOnly: true, trustSigners: false, yes: false, port: 8788 });
  assert.deepEqual(parseUpdateArgs(['--yes', '--port', '8790']), { target: main, checkOnly: false, trustSigners: false, yes: true, port: 8790 });
  assert.deepEqual(parseUpdateArgs(['--port=8790']), { target: main, checkOnly: false, trustSigners: false, yes: false, port: 8790 });
  assert.deepEqual(parseUpdateArgs(['--release']), { target: { kind: 'release' }, checkOnly: false, trustSigners: false, yes: false, port: 8788 });
  assert.deepEqual(parseUpdateArgs(['--release', '--yes']).target, { kind: 'release' });
  assert.deepEqual(parseUpdateArgs(['--to', 'v2.1.0']).target, { kind: 'to', version: '2.1.0' });
  assert.deepEqual(parseUpdateArgs(['--to=2.1.0']).target, { kind: 'to', version: '2.1.0' });
  assert.deepEqual(parseUpdateArgs(['--trust-signers']), { target: main, checkOnly: false, trustSigners: true, yes: false, port: 8788 });
  assert.deepEqual(parseUpdateArgs(['--trust-signers', '--yes']).trustSigners, true);
  assert.throws(() => parseUpdateArgs(['--port', 'eighty']), /--port must be a port number/);
  assert.throws(() => parseUpdateArgs(['--port', '0']), /--port must be a port number/);
  assert.throws(() => parseUpdateArgs(['--port', '70000']), /--port must be a port number/);
  assert.throws(() => parseUpdateArgs(['--to']), /--to needs a release version like v2\.1\.0/);
  assert.throws(() => parseUpdateArgs(['--to', 'main']), /--to needs a release version/);
  assert.throws(() => parseUpdateArgs(['--to', 'v2.1.0-rc.1']), /--to needs a release version/);
  assert.throws(() => parseUpdateArgs(['--to', 'v2.1.0', '--release']), /Use one of them/);
  assert.throws(() => parseUpdateArgs(['--trust-signers', '--check']), /--trust-signers stands alone/);
  assert.throws(() => parseUpdateArgs(['--trust-signers', '--release']), /--trust-signers stands alone/);
  assert.throws(() => parseUpdateArgs(['--auto']), /Unknown option --auto/);
  assert.throws(() => parseUpdateArgs(['v2.1.0']), /takes no arguments.*--to v2\.1\.0/);
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
  assert.ok(!/^import .* from '\.\/(exec|git|restart|health|signers)\.ts';$/m.test(source), 'none of the modules that run programs');
  assert.match(source, /await import\('\.\/run\.ts'\)/);
});

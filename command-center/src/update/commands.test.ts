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
  for (const flag of ['--release', '--to vX.Y.Z', '--check', '--trust-signers', '--auto', '--yes', '--port']) assert.ok((update.usage ?? '').includes(flag), flag);
  const cli = readFileSync(join(here, '..', 'cli.ts'), 'utf8');
  assert.match(cli, /from '\.\/update\/commands\.ts'/);
});

const main = { kind: 'main' } as const;

test('flags: --release, --to, --check, --trust-signers, --auto, --yes, --port, and nothing else', () => {
  const plain = { target: main, checkOnly: false, trustSigners: false, auto: false, yes: false, port: DEFAULT_PORT };
  assert.deepEqual(parseUpdateArgs([]), plain);
  assert.deepEqual(parseUpdateArgs(['--check']), { ...plain, checkOnly: true });
  assert.deepEqual(parseUpdateArgs(['--yes', '--port', '8790']), { ...plain, yes: true, port: 8790 });
  assert.deepEqual(parseUpdateArgs(['--port=8790']), { ...plain, port: 8790 });
  assert.deepEqual(parseUpdateArgs(['--release']), { ...plain, target: { kind: 'release' } });
  assert.deepEqual(parseUpdateArgs(['--auto']), { ...plain, auto: true });
  assert.deepEqual(parseUpdateArgs(['--auto', '--port', '8790']), { ...plain, auto: true, port: 8790 });
  assert.deepEqual(parseUpdateArgs(['--release', '--yes']).target, { kind: 'release' });
  assert.deepEqual(parseUpdateArgs(['--to', 'v2.1.0']).target, { kind: 'to', version: '2.1.0' });
  assert.deepEqual(parseUpdateArgs(['--to=2.1.0']).target, { kind: 'to', version: '2.1.0' });
  assert.deepEqual(parseUpdateArgs(['--trust-signers']), { ...plain, trustSigners: true });
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
  for (const other of ['--release', '--to v2.1.0', '--check', '--trust-signers', '--yes']) assert.throws(() => parseUpdateArgs(['--auto', ...other.split(' ')]), /--auto stands alone/, other);
  assert.throws(() => parseUpdateArgs(['--schedule']), /Unknown option --schedule/);
  assert.throws(() => parseUpdateArgs(['v2.1.0']), /takes no arguments.*--to v2\.1\.0/);
});

test('a bad flag is reported and nothing runs', async () => {
  const err: string[] = [];
  const code = await update.run(['--port', 'x'], { openApp: () => { throw new Error('must not open the store'); }, stdout: () => {}, stderr: (l) => err.push(l) });
  assert.equal(code, 1);
  assert.match(err.join('\n'), /--port must be a port number/);
});

test('commands.ts starts no program itself: no child_process, and run.ts and auto.ts behind a dynamic import only', () => {
  const source = readFileSync(join(here, 'commands.ts'), 'utf8');
  assert.ok(!source.includes('child_process'));
  assert.ok(!/^import .* from '\.\/(run|auto)\.ts';$/m.test(source), 'no static import of run.ts or auto.ts');
  assert.ok(!/^import .* from '\.\/(exec|git|restart|health|signers)\.ts';$/m.test(source), 'none of the modules that run programs');
  assert.match(source, /await import\('\.\/run\.ts'\)/);
  assert.match(source, /await import\('\.\/auto\.ts'\)/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { fileSecretStore, memorySecretStore, windowsDpapiSecretStore, windowsPowerShellEnv, type SecretStore } from './secrets.ts';

test('memorySecretStore: basic get/set/delete round trip', async () => {
  const store = memorySecretStore();
  assert.equal(await store.get('k'), undefined);
  await store.set('k', 'v');
  assert.equal(await store.get('k'), 'v');
  await store.delete('k');
  assert.equal(await store.get('k'), undefined);
});

test('windowsDpapiSecretStore: round-trips through an injected fake powershell without a real process, and the plaintext never appears as a script/argv literal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-dpapi-'));
  try {
    const calls: { script: string; stdin: string }[] = [];
    const fakeCiphers = new Map<string, string>();
    const runPowerShell = async (script: string, stdin: string): Promise<string> => {
      calls.push({ script, stdin });
      if (script.includes('ConvertFrom-SecureString -SecureString')) {
        // "encrypt": stdin is the value as base64. Remember it behind an opaque token, return the token as ciphertext.
        const token = `CIPHER(${Buffer.from(stdin).toString('hex')})`;
        fakeCiphers.set(token, stdin);
        return token;
      }
      // "decrypt": reverse the token back to the base64 the real script would print.
      return fakeCiphers.get(stdin.trim()) ?? '';
    };
    const store = windowsDpapiSecretStore({ baseDir: dir, runPowerShell });

    await store.set('google-refresh-token', 'super-secret-value');
    assert.equal(await store.get('google-refresh-token'), 'super-secret-value');

    // The secret must travel over stdin, never embedded in the script text itself.
    for (const call of calls) assert.doesNotMatch(call.script, /super-secret-value/);
    await assert.rejects(store.set('empty', ''), /empty value/);

    await store.delete('google-refresh-token');
    assert.equal(await store.get('google-refresh-token'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('windowsDpapiSecretStore: get on a missing key returns undefined without invoking powershell', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-dpapi-'));
  try {
    let invoked = false;
    const store = windowsDpapiSecretStore({ baseDir: dir, runPowerShell: async () => { invoked = true; return ''; } });
    assert.equal(await store.get('nope'), undefined);
    assert.equal(invoked, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fileSecretStore: round trip across instances, keys kept apart, no partial file left', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-secrets-'));
  try {
    const file = join(dir, 'nested', 'secrets.json');
    const store = fileSecretStore(file);
    assert.equal(await store.get('a'), undefined);
    await store.set('a', 'one');
    await store.set('b', 'two');
    await store.set('a', 'rotated');
    const reopened = fileSecretStore(file);
    assert.equal(await reopened.get('a'), 'rotated');
    assert.equal(await reopened.get('b'), 'two');
    await reopened.delete('a');
    await reopened.delete('never-set');
    assert.equal(await store.get('a'), undefined);
    assert.equal(await store.get('b'), 'two');
    assert.deepEqual(readdirSync(join(dir, 'nested')), ['secrets.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fileSecretStore: delete on a store that was never written creates nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-secrets-'));
  try {
    const file = join(dir, 'secrets.json');
    await fileSecretStore(file).delete('k');
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Windows has no permission bits to set or check, so these two only mean something elsewhere.
test('fileSecretStore: the file is written owner-only', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-secrets-'));
  try {
    const file = join(dir, 'secrets.json');
    await fileSecretStore(file).set('k', 'v');
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fileSecretStore: a file others can read is refused, for reads and for writes', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-secrets-'));
  try {
    const file = join(dir, 'secrets.json');
    const store = fileSecretStore(file);
    await store.set('k', 'v');
    chmodSync(file, 0o644);
    await assert.rejects(store.get('k'), /chmod 600/);
    await assert.rejects(store.set('k', 'w'), /chmod 600/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The daemon and a CLI command are separate processes. Promise.all in one process would prove
// nothing: the file operations are synchronous, so they could never interleave.
test('fileSecretStore: writers in separate processes lose nothing and leave only the secret file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-secrets-race-'));
  try {
    const file = join(dir, 'secrets.json');
    const startFile = join(dir, 'go');
    const script = fileURLToPath(new URL('./fixtures/secret-writer.ts', import.meta.url));
    const writers = ['a', 'b', 'c'];
    const perWriter = 25;
    const runs = writers.map((prefix) => new Promise<{ failed: string[] }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--no-warnings', script, file, prefix, String(perWriter), startFile], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`writer ${prefix} exited ${code}: ${err}`))));
    }));
    await new Promise((r) => setTimeout(r, 300)); // let every writer reach the start line
    writeFileSync(startFile, '');
    const results = await Promise.all(runs);

    assert.deepEqual(results.flatMap((r) => r.failed), [], 'no write may fail');
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    assert.equal(Object.keys(saved).length, writers.length * perWriter, 'no acknowledged write may be lost');
    for (const prefix of writers) assert.equal(saved[`${prefix}-0`], `value-${prefix}-0`);
    assert.deepEqual(readdirSync(dir).sort(), ['go', 'secrets.json'], 'no lock or staging file left behind');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fileSecretStore: a lock left by a dead process is taken over, a live one makes the writer give up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-secrets-lock-'));
  try {
    const file = join(dir, 'secrets.json');
    const lock = `${file}.lock`;
    writeFileSync(lock, '');
    await assert.rejects(fileSecretStore(file, { lockTimeoutMs: 100 }).set('k', 'v'), /locked by another process/);
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(lock), true, 'a lock that may be live is never removed');

    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(lock, longAgo, longAgo);
    await fileSecretStore(file, { lockTimeoutMs: 100 }).set('k', 'v');
    assert.deepEqual(readdirSync(dir), ['secrets.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fileSecretStore: a staging file left by another writer is never touched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-secrets-staging-'));
  try {
    const file = join(dir, 'secrets.json');
    const theirs = `${file}.99999.abcdef.partial`;
    writeFileSync(theirs, 'another writer is halfway');
    await fileSecretStore(file).set('k', 'v');
    assert.equal(readFileSync(theirs, 'utf8'), 'another writer is halfway');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('has: true only for a stored key, in the memory store and the file store, before and after delete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-secrets-has-'));
  try {
    for (const store of [memorySecretStore(), fileSecretStore(join(dir, 'secrets.json'))]) {
      assert.equal(await store.has('k'), false);
      await store.set('k', 'v');
      assert.equal(await store.has('k'), true);
      assert.equal(await store.has('other'), false);
      await store.delete('k');
      assert.equal(await store.has('k'), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('windowsDpapiSecretStore.has looks for the file and never runs PowerShell', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-secrets-dpapi-has-'));
  try {
    let runs = 0;
    const store = windowsDpapiSecretStore({ baseDir: dir, runPowerShell: async (_script, stdin) => { runs++; return stdin; } });
    assert.equal(await store.has('k'), false);
    await store.set('k', 'v');
    const afterSet = runs;
    assert.equal(await store.has('k'), true);
    assert.equal(runs, afterSet, 'has did not decrypt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Started from PowerShell 7, this process carries a PSModulePath that makes Windows PowerShell 5.1
// fail to load its own security module. That is how the UI tests failed in CI on 2026-09-21.
test('windowsPowerShellEnv drops PSModulePath in any letter case and keeps everything else', () => {
  const env = windowsPowerShellEnv({ PSModulePath: 'C:/pwsh7/Modules', psmodulepath: 'x', PATH: 'C:/Windows', APPDATA: 'C:/Users/x/AppData/Roaming' });
  assert.deepEqual(env, { PATH: 'C:/Windows', APPDATA: 'C:/Users/x/AppData/Roaming' });
  assert.equal('PSModulePath' in windowsPowerShellEnv({ PSMODULEPATH: 'y' }), false);
});

test('the real DPAPI store round-trips a value even when PSModulePath points at another PowerShell', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-dpapi-real-'));
  const saved = process.env.PSModulePath;
  process.env.PSModulePath = `C:\\Program Files\\PowerShell\\7\\Modules;${saved ?? ''}`;
  try {
    const store = windowsDpapiSecretStore({ baseDir: dir });
    await store.set('k', 'round trip value');
    assert.equal(await store.get('k'), 'round trip value');
    assert.ok(!readFileSync(join(dir, 'k.bin'), 'utf8').includes('round trip value'), 'what is on disk is not the value');

    // A backup passphrase is a key: every byte must come back, including spaces at the ends,
    // characters outside ASCII, and line breaks. Before 2026-09-22 the output was trimmed.
    for (const exact of ['  spaces at both ends  ', '            ', 'caf\u00e9 \u2019 \u4f60\u597d \ud83d\udd12', 'two\nlines\r\nhere', '\ttab first']) {
      await store.set('exact', exact);
      assert.equal(await store.get('exact'), exact, JSON.stringify(exact));
    }
  } finally {
    if (saved === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('update: one read-decide-write step in every store, and a thrown decision changes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-secrets-'));
  try {
    // The fake "encrypts" by reversing the base64 text and "decrypts" by reversing it back.
    const runPowerShell = async (_script: string, stdin: string) => stdin.trim().split('').reverse().join('');
    const stores: [string, ReturnType<typeof memorySecretStore>][] = [
      ['memory', memorySecretStore()],
      ['file', fileSecretStore(join(dir, 'secrets.json'))],
      ['dpapi', windowsDpapiSecretStore({ baseDir: join(dir, 'dpapi'), runPowerShell })],
    ];
    for (const [name, store] of stores) {
      await store.update('k', (current) => { assert.equal(current, undefined, name); return 'v1'; });
      assert.equal(await store.get('k'), 'v1', name);
      await store.update('k', (current) => `${current}+2`);
      assert.equal(await store.get('k'), 'v1+2', name);
      await store.update('k', () => undefined);
      assert.equal(await store.get('k'), 'v1+2', `${name}: undefined leaves the value alone`);
      await assert.rejects(store.update('k', () => { throw new Error('not this time'); }), /not this time/, name);
      assert.equal(await store.get('k'), 'v1+2', `${name}: a thrown decision writes nothing`);
      assert.equal(await store.has('k'), true, name);
    }
    // The stores keep nothing but the secrets: no lock file is left behind by update.
    assert.deepEqual(readdirSync(dir).sort(), ['dpapi', 'secrets.json']);
    assert.deepEqual(readdirSync(join(dir, 'dpapi')), ['k.bin']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// PowerShell runs while the daemon goes on with other requests, so forgetting the GitHub App (a
// delete) can arrive while a token refresh (an update) is waiting on it. The delete must come after,
// not in between. Sign-out is an update itself, so the lock already kept it apart.
test('windowsDpapiSecretStore: a delete that arrives while an update runs PowerShell waits for it and is not undone by it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-dpapi-order-'));
  try {
    let hold: Promise<void> | undefined;
    let entered = () => {};
    const runPowerShell = async (_script: string, stdin: string) => {
      entered();
      if (hold) await hold;
      return stdin.trim().split('').reverse().join('');
    };
    const store = windowsDpapiSecretStore({ baseDir: dir, runPowerShell });
    await store.set('k', 'old');

    let release = () => {};
    hold = new Promise((resolve) => { release = resolve; });
    const inPowerShell = new Promise<void>((resolve) => { entered = resolve; });
    const updating = store.update('k', (current) => `${current}+new`);
    await inPowerShell;
    const deleting = store.delete('k');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(existsSync(join(dir, 'k.bin')), true, 'the delete waits while the update holds the key');

    release();
    await Promise.all([updating, deleting]);
    assert.equal(await store.get('k'), undefined, 'the delete came second, so nothing is left');
    assert.deepEqual(readdirSync(dir), [], 'and no lock file either');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A lock is taken over once it is a minute old, which cannot tell a slow holder from a dead one.
// The slow holder must then write nothing, and must leave the new holder's lock alone.
test('windowsDpapiSecretStore: a change whose lock was taken over as stale writes nothing and leaves the new lock alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-dpapi-stale-'));
  try {
    const holds: { entered: () => void; gate: Promise<void> }[] = [];
    const hold = () => {
      let release = () => {};
      let entered = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const inside = new Promise<void>((resolve) => { entered = resolve; });
      holds.push({ entered, gate });
      return { inside, release };
    };
    const runPowerShell = async (_script: string, stdin: string) => {
      const next = holds.shift();
      if (next) {
        next.entered();
        await next.gate;
      }
      return stdin.trim().split('').reverse().join('');
    };
    const store = windowsDpapiSecretStore({ baseDir: dir, runPowerShell });
    const lockFile = join(dir, 'k.bin.lock');
    await store.set('k', 'old');

    const slow = hold();
    const updating = store.update('k', (current) => `${current}+late`);
    await slow.inside;
    const overAMinuteAgo = (Date.now() - 61_000) / 1000;
    utimesSync(lockFile, overAMinuteAgo, overAMinuteAgo);

    const newer = hold();
    const setting = store.set('k', 'newer');
    await newer.inside;

    slow.release();
    await assert.rejects(updating, /was not changed: it took so long that another change went ahead/);
    assert.equal(existsSync(lockFile), true, 'the set that took over still holds its lock');

    newer.release();
    await setting;
    assert.equal(await store.get('k'), 'newer');
    assert.deepEqual(readdirSync(dir), ['k.bin']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the real DPAPI store lets timers run while PowerShell works, and reports a failure in one line', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-dpapi-async-'));
  try {
    const store = windowsDpapiSecretStore({ baseDir: dir });
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    try {
      await store.set('k', 'v');
    } finally {
      clearInterval(timer);
    }
    assert.ok(ticks > 0, 'the event loop ran while the value was being encrypted');

    writeFileSync(join(dir, 'bad.bin'), 'not a DPAPI blob', 'utf8');
    await assert.rejects(store.get('bad'), (e: Error) => {
      assert.match(e.message, /^Windows could not protect or read the secret \(DPAPI through powershell\.exe\): \S/);
      assert.equal(e.message.includes('\n'), false, e.message);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Two instances over the same folder stand for two processes: the daemon and a CLI command.
test('exclusive: a second caller waits for the first, also from another instance of the file and DPAPI stores', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-secrets-exclusive-'));
  try {
    const runPowerShell = async (_script: string, stdin: string) => stdin;
    const memory = memorySecretStore();
    const pairs: [string, SecretStore, SecretStore][] = [
      ['memory', memory, memory],
      ['file', fileSecretStore(join(dir, 'secrets.json')), fileSecretStore(join(dir, 'secrets.json'))],
      ['dpapi', windowsDpapiSecretStore({ baseDir: join(dir, 'dpapi'), runPowerShell }), windowsDpapiSecretStore({ baseDir: join(dir, 'dpapi'), runPowerShell })],
    ];
    const opts = { timeoutMs: 5_000, staleMs: 60_000 };
    for (const [name, a, b] of pairs) {
      const order: string[] = [];
      let release = () => {};
      const held = new Promise<void>((r) => { release = r; });
      let entered = () => {};
      const inside = new Promise<void>((r) => { entered = r; });
      const first = a.exclusive('job', async () => {
        order.push('first in');
        entered();
        await held;
        order.push('first out');
        return 1;
      }, opts);
      await inside;
      const second = b.exclusive('job', async () => {
        order.push('second in');
        return 2;
      }, opts);
      await new Promise((r) => setTimeout(r, 50));
      release();
      assert.deepEqual(await Promise.all([first, second]), [1, 2], name);
      assert.deepEqual(order, ['first in', 'first out', 'second in'], name);
    }
    assert.deepEqual(readdirSync(dir), ['dpapi'], 'no lock file is left');
    assert.deepEqual(readdirSync(join(dir, 'dpapi')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

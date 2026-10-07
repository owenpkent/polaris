import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Exec, ExecResult } from './exec.ts';
import { canRestart, describeRestart, detectRestart, parseRestartSpec, restartDaemon, restartProblem, sudoersLine, waitForPort, WINDOWS_TASK, type RestartMethod } from './restart.ts';

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const no = (code = 1): ExecResult => ({ code, stdout: '', stderr: '' });

/** A runner that answers from `script` by the joined command line and records every call. */
function scripted(script: (line: string) => ExecResult | undefined) {
  const calls: string[] = [];
  const exec: Exec = async (cmd, args) => {
    const line = `${cmd} ${args.join(' ')}`;
    calls.push(line);
    return script(line) ?? no(127);
  };
  return { calls, exec };
}

test('CC_UPDATE_RESTART names one of the four methods, and a unit name is checked', () => {
  assert.deepEqual(parseRestartSpec('task'), { kind: 'task', task: WINDOWS_TASK });
  assert.deepEqual(parseRestartSpec(' manual '), { kind: 'manual' });
  assert.deepEqual(parseRestartSpec('systemd:polaris'), { kind: 'systemd', unit: 'polaris' });
  assert.deepEqual(parseRestartSpec('systemd-user:polaris.service'), { kind: 'systemd-user', unit: 'polaris.service' });
  for (const bad of ['', 'cron', 'systemd', 'systemd:', 'systemd:a b', 'systemd:a;rm', 'task:x']) {
    assert.throws(() => parseRestartSpec(bad), /CC_UPDATE_RESTART is/, JSON.stringify(bad));
  }
  assert.equal(canRestart({ kind: 'manual' }), false);
  assert.equal(canRestart({ kind: 'systemd', unit: 'polaris' }), true);
  assert.match(describeRestart({ kind: 'systemd', unit: 'polaris' }), /sudo -n systemctl stop polaris, then start/);
  assert.equal(sudoersLine('polaris', 'owen'), 'owen ALL=(root) NOPASSWD: /usr/bin/systemctl stop polaris, /usr/bin/systemctl start polaris, /usr/bin/systemctl restart polaris');
});

test('detection: the logon task on Windows, then the system unit, then the user unit, otherwise manual', async () => {
  const win = scripted((line) => (line.startsWith('powershell.exe') && line.includes(`Get-ScheduledTask -TaskName '${WINDOWS_TASK}'`) ? ok() : undefined));
  assert.deepEqual(await detectRestart(win.exec, 'win32'), { kind: 'task', task: WINDOWS_TASK });
  const winWithout = scripted(() => no());
  assert.deepEqual(await detectRestart(winWithout.exec, 'win32'), { kind: 'manual' });
  assert.ok(winWithout.calls.every((l) => l.startsWith('powershell.exe')), 'nothing but PowerShell is asked on Windows');

  const system = scripted((line) => (line === 'systemctl is-active --quiet polaris' ? ok() : no(3)));
  assert.deepEqual(await detectRestart(system.exec, 'linux'), { kind: 'systemd', unit: 'polaris' });
  const user = scripted((line) => (line === 'systemctl --user is-active --quiet polaris' ? ok() : no(3)));
  assert.deepEqual(await detectRestart(user.exec, 'linux'), { kind: 'systemd-user', unit: 'polaris' });
  assert.deepEqual(user.calls, ['systemctl is-active --quiet polaris', 'systemctl --user is-active --quiet polaris'], 'the system unit is asked first');
  const neither = scripted(() => no(127));
  assert.deepEqual(await detectRestart(neither.exec, 'linux'), { kind: 'manual' }, 'no systemctl at all reads as manual');
  const mac = scripted(() => ok());
  assert.deepEqual(await detectRestart(mac.exec, 'darwin'), { kind: 'manual' });
  assert.deepEqual(mac.calls, [], 'nothing is run where nothing is supported');
});

test('restartProblem: a missing task or unit, and a system unit without the sudoers line, are found before anything moves', async () => {
  const missingTask = scripted(() => no());
  assert.match((await restartProblem({ kind: 'task', task: WINDOWS_TASK }, missingTask.exec))!, /no scheduled task named/);
  const noUnit = scripted((line) => (line.startsWith('systemctl show') ? ok('not-found\n') : undefined));
  assert.match((await restartProblem({ kind: 'systemd', unit: 'polaris' }, noUnit.exec))!, /no unit named polaris/);
  // The old one-verb line (restart only) is not enough: the restart stops and starts.
  const oneVerb = scripted((line) => (line.startsWith('systemctl show') ? ok('loaded\n') : line === 'sudo -n -l systemctl restart polaris' ? ok() : no()));
  assert.match((await restartProblem({ kind: 'systemd', unit: 'polaris' }, oneVerb.exec))!, /sudo cannot run "systemctl stop polaris" without a password.*NOPASSWD: \/usr\/bin\/systemctl stop polaris, \/usr\/bin\/systemctl start polaris, \/usr\/bin\/systemctl restart polaris/);
  const noStart = scripted((line) => (line.startsWith('systemctl show') ? ok('loaded\n') : line === 'sudo -n -l systemctl start polaris' ? no() : ok()));
  assert.match((await restartProblem({ kind: 'systemd', unit: 'polaris' }, noStart.exec))!, /sudo cannot run "systemctl start polaris"/);
  const fine = scripted((line) => (line.startsWith('systemctl show') ? ok('loaded\n') : ok()));
  assert.equal(await restartProblem({ kind: 'systemd', unit: 'polaris' }, fine.exec), null);
  assert.deepEqual(fine.calls.filter((l) => l.startsWith('sudo')), ['sudo -n -l systemctl stop polaris', 'sudo -n -l systemctl start polaris', 'sudo -n -l systemctl restart polaris'], 'all three verbs are asked about, and sudo is only ever asked, never run');
  const userFine = scripted((line) => (line === 'systemctl --user show -p LoadState --value polaris' ? ok('loaded\n') : undefined));
  assert.equal(await restartProblem({ kind: 'systemd-user', unit: 'polaris' }, userFine.exec), null);
  assert.equal(await restartProblem({ kind: 'manual' }, scripted(() => no()).exec), null);
});

/** A daemon model: `listening` flips on the stop and start commands the runner sees. */
function daemon(stopLine: string, startLine: string, startSucceeds = true) {
  const state = { listening: true, events: [] as string[] };
  const exec: Exec = async (cmd, args) => {
    const line = `${cmd} ${args.join(' ')}`;
    state.events.push(line);
    if (line === stopLine) { state.listening = false; return ok(); }
    if (line === startLine) { if (!startSucceeds) return { code: 1, stdout: '', stderr: 'unit failed' }; state.listening = true; return ok(); }
    return no(127);
  };
  let clock = 0;
  const deps = { exec, portListening: async () => state.listening, sleep: async () => { clock += 250; }, now: () => clock, say: (line: string) => state.events.push(`say: ${line}`) };
  const between = () => state.events.push(`between (listening: ${state.listening})`);
  return { state, deps, between };
}

test('the Windows task and the user unit are stopped, the swap runs while nothing listens, then they are started', async () => {
  const task = daemon(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command Stop-ScheduledTask -TaskName '${WINDOWS_TASK}'`, `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command Start-ScheduledTask -TaskName '${WINDOWS_TASK}'`);
  await restartDaemon({ kind: 'task', task: WINDOWS_TASK }, { port: 8788, between: task.between }, task.deps);
  assert.deepEqual(task.state.events.map((e) => e.replace(/^powershell\.exe .*-Command /, '')), [
    `Stop-ScheduledTask -TaskName '${WINDOWS_TASK}'`,
    'between (listening: false)',
    `Start-ScheduledTask -TaskName '${WINDOWS_TASK}'`,
  ]);
  const user = daemon('systemctl --user stop polaris', 'systemctl --user start polaris');
  await restartDaemon({ kind: 'systemd-user', unit: 'polaris' }, { port: 8788, between: user.between }, user.deps);
  assert.deepEqual(user.state.events, ['systemctl --user stop polaris', 'between (listening: false)', 'systemctl --user start polaris']);
});

test('a system unit is stopped and started through sudo, with the swap while nothing listens, and restart is never run', async () => {
  const d = daemon('sudo -n systemctl stop polaris', 'sudo -n systemctl start polaris');
  await restartDaemon({ kind: 'systemd', unit: 'polaris' }, { port: 8788, between: d.between }, d.deps);
  assert.deepEqual(d.state.events, ['sudo -n systemctl stop polaris', 'between (listening: false)', 'sudo -n systemctl start polaris']);
  assert.ok(d.state.events.every((e) => !e.includes('restart')));
  const stopRefused = daemon('never', 'sudo -n systemctl start polaris');
  await assert.rejects(restartDaemon({ kind: 'systemd', unit: 'polaris' }, { port: 8788, between: stopRefused.between }, stopRefused.deps), /sudo -n systemctl stop polaris failed/);
  assert.ok(!stopRefused.state.events.some((e) => e.startsWith('between')), 'the swap did not run');
});

test('the manual method tells the owner what to do and waits for the port to drop and come back', async () => {
  const d = daemon('never', 'never');
  const flips: boolean[] = [false, false, true];
  d.deps.portListening = async () => { const next = flips.shift(); if (next !== undefined) d.state.listening = next; return d.state.listening; };
  await restartDaemon({ kind: 'manual' }, { port: 8788, between: d.between }, d.deps);
  assert.deepEqual(d.state.events, [
    'say: Stop the daemon now (the process listening on port 8788). Waiting up to 10 minutes.',
    'between (listening: false)',
    'say: Start the daemon now. Waiting up to 10 minutes for port 8788.',
  ]);
});

test('a failed stop runs no swap, a failed start is reported, and a wait that runs out is an error', async () => {
  const failedStop = daemon('systemctl --user stop other', 'systemctl --user start polaris');
  await assert.rejects(restartDaemon({ kind: 'systemd-user', unit: 'polaris' }, { port: 8788, between: failedStop.between }, failedStop.deps), /systemctl --user stop polaris failed/);
  assert.ok(!failedStop.state.events.some((e) => e.startsWith('between')), 'the swap did not run');

  const failedStart = daemon('systemctl --user stop polaris', 'systemctl --user start polaris', false);
  await assert.rejects(restartDaemon({ kind: 'systemd-user', unit: 'polaris' }, { port: 8788, between: failedStart.between }, failedStart.deps), /start polaris failed \(1\): unit failed/);
  assert.ok(failedStart.state.events.some((e) => e.startsWith('between')), 'the swap had run: the caller must undo it');

  const stuck = daemon('systemctl --user stop polaris', 'systemctl --user start polaris');
  stuck.deps.portListening = async () => true;
  await assert.rejects(restartDaemon({ kind: 'systemd-user', unit: 'polaris' }, { port: 8788, between: stuck.between, stopTimeoutMs: 1000 }, stuck.deps), /port 8788 is still in use after 1s/);
  assert.ok(!stuck.state.events.some((e) => e.startsWith('between')));

  let clock = 0;
  await assert.rejects(waitForPort(true, 8788, 2000, { portListening: async () => false, sleep: async () => { clock += 500; }, now: () => clock }), /nothing is listening on port 8788 after 2s/);
});

test('every method is covered by describeRestart', () => {
  const methods: RestartMethod[] = [{ kind: 'task', task: WINDOWS_TASK }, { kind: 'systemd', unit: 'u' }, { kind: 'systemd-user', unit: 'u' }, { kind: 'manual' }];
  for (const m of methods) assert.ok(describeRestart(m).length > 10, m.kind);
});

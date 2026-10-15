// Execute the real installer in a scratch tree. Every scheduler/network command is a double:
// unregistering removes the definition, while stopping and releasing the listener are separate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Exec } from './update/exec.ts';
import { detectRestart, LEGACY_WINDOWS_TASK, restartDaemon, WINDOWS_TASK } from './update/restart.ts';

interface InstallerResult {
  scenario: string;
  error: string | null;
  registered: string[];
  events: string[];
  listener: boolean;
  elapsedMs: number;
}

test('the Windows daemon installer hands off a legacy task only after its process stops', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'polaris-task-installer-'));
  assert.equal(dirname(dir), resolve(tmpdir()));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'command-center', 'src'), { recursive: true });
  // The installer checks this file exists; the mock actions never launch it.
  writeFileSync(join(dir, 'command-center', 'src', 'cli.ts'), '// Never executed.\n');
  const source = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'install-command-center-task.ps1');
  copyFileSync(source, join(dir, 'scripts', 'install-command-center-task.ps1'));
  const wrapper = join(dir, 'scheduler-double.ps1');
  writeFileSync(wrapper, String.raw`
$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot 'scripts\install-command-center-task.ps1'

# Global here means this isolated PowerShell child, so the called installer's script scope
# cannot hide the model. None of these functions calls the real scheduler or network cmdlet.
function Get-ScheduledTask {
  [CmdletBinding()] param([string]$TaskName)
  if ($global:taskModel.registered.ContainsKey($TaskName)) {
    [pscustomobject]@{ TaskName = $TaskName; State = $global:taskModel.registered[$TaskName] }
  }
}
function Stop-ScheduledTask {
  [CmdletBinding()] param([string]$TaskName)
  $global:taskModel.events.Add("stop:$TaskName")
  if ($global:taskModel.scenario -eq 'stop-fails') { throw 'stop refused' }
  $global:taskModel.stopping = $true
}
function Unregister-ScheduledTask {
  [CmdletBinding()] param([string]$TaskName, [switch]$Confirm)
  $global:taskModel.events.Add("unregister:$TaskName")
  $global:taskModel.registered.Remove($TaskName)
  # Deliberately do not clear the listener: unregister is not stop.
}
function Register-ScheduledTask {
  [CmdletBinding()] param([string]$TaskName, $Action, $Trigger, $Settings, $Principal, [switch]$Force)
  $global:taskModel.events.Add("register:$TaskName")
  if ($global:taskModel.scenario -eq 'register-fails') { throw 'registration refused' }
  $global:taskModel.registered[$TaskName] = 'Ready'
}
function New-ScheduledTaskAction { param($Execute, $Argument, $WorkingDirectory); [pscustomobject]@{mock='action'} }
function New-ScheduledTaskTrigger { param([switch]$AtLogOn, $User); [pscustomobject]@{mock='trigger'} }
function New-ScheduledTaskSettingsSet {
  param([switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries, $RestartCount, $RestartInterval, $ExecutionTimeLimit)
  [pscustomobject]@{mock='settings'}
}
function New-ScheduledTaskPrincipal { param($UserId, $LogonType, $RunLevel); [pscustomobject]@{mock='principal'} }
function Get-NetTCPConnection {
  [CmdletBinding()] param()
  if ($global:taskModel.scenario -eq 'query-fails') { throw 'connection query refused' }
  if ($global:taskModel.listener) { [pscustomobject]@{ LocalPort=8788; State='Listen' } }
  # Unrelated listeners and outbound connections must not delay the migration.
  [pscustomobject]@{ LocalPort=9000; State='Listen' }
  [pscustomobject]@{ LocalPort=8788; State='Established' }
}
function Get-Date { ([datetime]'2026-10-15T12:00:00Z').AddMilliseconds($global:taskModel.elapsedMs) }
function Start-Sleep {
  param([int]$Milliseconds)
  $global:taskModel.elapsedMs += $Milliseconds
  if ($global:taskModel.stopping) {
    if ($global:taskModel.elapsedMs -ge 250 -and $global:taskModel.scenario -ne 'task-stuck') {
      $global:taskModel.registered['Constellation Command Center'] = 'Ready'
    }
    # The wrapper can exit before its child releases the port. Make those distinct polls.
    if ($global:taskModel.elapsedMs -ge 500 -and $global:taskModel.scenario -ne 'port-stuck') {
      if ($global:taskModel.listener) { $global:taskModel.events.Add('listener-exited') }
      $global:taskModel.listener = $false
    }
  }
}

$results = @()
foreach ($scenario in @('running', 'queued', 'inactive', 'fresh', 'custom', 'stop-fails', 'port-stuck', 'task-stuck', 'query-fails', 'register-fails')) {
  $global:taskModel = @{
    scenario=$scenario; registered=@{}; listener=$true; stopping=$false; elapsedMs=0
    events=[System.Collections.Generic.List[string]]::new()
  }
  if ($scenario -eq 'fresh') {
    $global:taskModel.listener = $false
  } else {
    $global:taskModel.registered['Constellation Command Center'] = 'Running'
  }
  if ($scenario -eq 'inactive') {
    $global:taskModel.registered['Constellation Command Center'] = 'Ready'
    $global:taskModel.listener = $false
  }
  if ($scenario -eq 'queued') {
    $global:taskModel.registered['Constellation Command Center'] = 'Queued'
    $global:taskModel.listener = $false
  }
  $arguments = @{}
  if ($scenario -eq 'custom') { $arguments.TaskName = 'Custom Command Center' }
  $failure = $null
  try { & $installer @arguments } catch { $failure = $_.Exception.Message }
  $results += [pscustomobject]@{
    scenario=$scenario; error=$failure; registered=@($global:taskModel.registered.Keys)
    events=@($global:taskModel.events); listener=$global:taskModel.listener; elapsedMs=$global:taskModel.elapsedMs
  }
}
$results | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'results.json') -Encoding UTF8
`);
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper], {
    encoding: 'utf8', windowsHide: true, timeout: 60_000,
  });
  assert.equal(run.error, undefined, run.error?.message ?? '');
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const results: InstallerResult[] = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8').replace(/^\uFEFF/, ''));
  const result = (scenario: string): InstallerResult => {
    const found = results.find((r) => r.scenario === scenario);
    assert.ok(found, `missing scenario: ${scenario}`);
    return found;
  };

  await t.test('a running legacy daemon releases its port before the new task can be selected', async () => {
    const r = result('running');
    assert.equal(r.error, null);
    assert.deepEqual(r.registered, [WINDOWS_TASK]);
    assert.equal(r.listener, false);
    assert.deepEqual(r.events, [`stop:${LEGACY_WINDOWS_TASK}`, 'listener-exited', `register:${WINDOWS_TASK}`, `unregister:${LEGACY_WINDOWS_TASK}`]);
    assert.equal(r.elapsedMs, 500);

    // Exercise the updater with the resulting inventory. A surviving legacy listener would
    // still be owned by the old task, so stopping Polaris could not release it.
    const active = new Set(r.listener ? [LEGACY_WINDOWS_TASK] : []);
    const exec: Exec = async (_cmd, args) => {
      const command = args.at(-1)!;
      const task = /-TaskName '([^']+)'/.exec(command)?.[1];
      assert.ok(task, command);
      if (command.includes('Get-ScheduledTask')) return { code: r.registered.includes(task) ? 0 : 1, stdout: '', stderr: '' };
      if (command.startsWith('Stop-ScheduledTask')) active.delete(task);
      else if (command.startsWith('Start-ScheduledTask')) active.add(task);
      else assert.fail(command);
      return { code: 0, stdout: '', stderr: '' };
    };
    const method = await detectRestart(exec, 'win32');
    assert.deepEqual(method, { kind: 'task', task: WINDOWS_TASK });
    let elapsed = 0, swapped = false;
    await restartDaemon(method, { port: 8788, between: () => { swapped = true; } }, {
      exec, portListening: async () => active.size > 0, sleep: async (ms) => { elapsed += ms; }, now: () => elapsed, say: () => {},
    });
    assert.equal(swapped, true);
    assert.deepEqual([...active], [WINDOWS_TASK]);
  });

  await t.test('a queued legacy task is stopped even before it starts listening', () => {
    const r = result('queued');
    assert.equal(r.error, null);
    assert.deepEqual(r.registered, [WINDOWS_TASK]);
    assert.deepEqual(r.events, [`stop:${LEGACY_WINDOWS_TASK}`, `register:${WINDOWS_TASK}`, `unregister:${LEGACY_WINDOWS_TASK}`]);
    assert.equal(r.elapsedMs, 250);
  });

  await t.test('fresh and inactive installs do not wait, and a custom name leaves the legacy task alone', () => {
    for (const scenario of ['fresh', 'inactive']) {
      const r = result(scenario);
      assert.equal(r.error, null);
      assert.deepEqual(r.registered, [WINDOWS_TASK]);
      assert.equal(r.elapsedMs, 0);
      assert.ok(r.events.every((event) => !event.startsWith('stop:')));
    }
    const r = result('custom');
    assert.equal(r.error, null);
    assert.deepEqual(r.registered.sort(), [LEGACY_WINDOWS_TASK, 'Custom Command Center'].sort());
    assert.equal(r.listener, true);
    assert.deepEqual(r.events, ['register:Custom Command Center']);
  });

  await t.test('stop, polling, and timeout failures preserve the old registration without publishing a new one', () => {
    for (const scenario of ['stop-fails', 'query-fails', 'port-stuck', 'task-stuck']) {
      const r = result(scenario);
      assert.ok(r.error, scenario);
      assert.deepEqual(r.registered, [LEGACY_WINDOWS_TASK], scenario);
      assert.ok(r.events.every((event) => !/^(register|unregister):/.test(event)), scenario);
      if (scenario.endsWith('-stuck')) {
        assert.equal(r.elapsedMs, 60_000, scenario);
        assert.match(r.error, /within 60 seconds/);
      }
    }
  });

  await t.test('a registration failure keeps the stopped legacy task available to restart', () => {
    const r = result('register-fails');
    assert.equal(r.error, 'registration refused');
    assert.deepEqual(r.registered, [LEGACY_WINDOWS_TASK]);
    assert.equal(r.listener, false);
    assert.ok(!r.events.some((event) => event.startsWith('unregister:')));
  });
});

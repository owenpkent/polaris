// The two installers for the scheduled updater (docs/update-proposal.md, section 3) are read here
// as text, since neither Task Scheduler nor systemd runs in a test. What they schedule is pinned:
// `cc update --auto` and nothing else, every five minutes, as the owner, outside the daemon, and
// the sudoers line a systemd system unit needs allows `systemctl` with stop, start, and restart
// on that one unit and nothing more. A change here is a change to what runs on the owner's
// machine unattended: make it in the scripts and the README together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(here, '..', '..', 'scripts');
const PS1 = join(SCRIPTS, 'install-updater-task.ps1');
const SH = join(SCRIPTS, 'install-updater-systemd.sh');

const ps1 = readFileSync(PS1, 'utf8');
const sh = readFileSync(SH, 'utf8');

/** Every argument list handed to the CLI (whatever follows the cli path on a command line). */
function cliArguments(text: string): string[] {
  return [...text.matchAll(/(?:\$cli'|"\$cli")\s+([a-z][a-z -]*)/g)].map((m) => m[1].trim());
}

test('the Windows task runs `cc update --auto` and nothing else', () => {
  assert.deepEqual(cliArguments(ps1), ['update --auto']);
  assert.match(ps1, /'command-center\\src\\cli\.ts'/);
  assert.match(ps1, /^\$command = "& '\$node' '\$cli' update --auto \*>> '\$log'"$/m);
  assert.equal(ps1.match(/^\$command = /gm)?.length, 1);
  assert.doesNotMatch(ps1, /--(release|to|yes|check)\b/);
});

test('the Windows task repeats every five minutes, as the owner, logged on or not, with no elevation', () => {
  assert.match(ps1, /New-ScheduledTaskTrigger -Once -At \(Get-Date\) -RepetitionInterval \(New-TimeSpan -Minutes 5\)/);
  assert.match(ps1, /New-ScheduledTaskPrincipal -UserId \$env:USERNAME -LogonType S4U -RunLevel Limited/);
  assert.match(ps1, /-MultipleInstances IgnoreNew/);
  assert.match(ps1, /-ExecutionTimeLimit \(New-TimeSpan -Hours 1\)/);
  assert.match(ps1, /\$log = Join-Path \$dataDir 'updater\.log'/);
  assert.match(ps1, /\*>> '\$log'/, 'output is appended to the log');
  assert.match(ps1, /\[string\]\$TaskName = 'Constellation Updater'/);
  assert.match(ps1, /\[switch\]\$Uninstall/);
});

test('the systemd service runs `cc update --auto` and nothing else, from command-center, logging to updater.log', () => {
  assert.deepEqual(cliArguments(sh), ['update --auto']);
  const execStart = sh.match(/^ExecStart=(.*)$/m);
  assert.ok(execStart, 'the service has one ExecStart');
  assert.equal(execStart[1], '"$node" "$cli" update --auto');
  assert.equal(sh.match(/^ExecStart=/gm)?.length, 1);
  assert.match(sh, /^cli="\$repo\/command-center\/src\/cli\.ts"$/m);
  assert.match(sh, /^Type=oneshot$/m);
  assert.match(sh, /^WorkingDirectory=\$repo\/command-center$/m);
  assert.match(sh, /^StandardOutput=append:\$log$/m);
  assert.match(sh, /^log="\$data_dir\/updater\.log"$/m);
  assert.doesNotMatch(sh, /--(release|to|yes|check)\b/);
});

test('the systemd timer fires every five minutes, and the units are user units', () => {
  assert.match(sh, /^OnBootSec=2min$/m);
  assert.match(sh, /^OnUnitActiveSec=5min$/m);
  assert.match(sh, /^Persistent=true$/m);
  assert.match(sh, /^unit_dir="\$\{XDG_CONFIG_HOME:-\$HOME\/\.config\}\/systemd\/user"$/m);
  assert.match(sh, /systemctl --user enable --now "\$timer_name"/);
  assert.match(sh, /loginctl enable-linger "\$user"/);
  // The daemon's units are never written or reloaded at system level: outside comments,
  // `systemctl` without `--user` appears only in the is-active probe (the sudoers line goes
  // through `$systemctl_path`, which this pattern does not match).
  const code = sh.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const systemLevel = [...code.matchAll(/\bsystemctl (?!--user)(\S+)/g)].map((m) => m[1]);
  assert.deepEqual(systemLevel, ['is-active']);
});

test('the sudoers line allows systemctl stop, start, and restart on the one unit, and nothing else', () => {
  const line = sh.match(/^\s*line="(.*)"$/m);
  assert.ok(line, 'the script builds the sudoers line in one assignment');
  const [who, commands] = line[1].split(' NOPASSWD: ');
  assert.equal(who, '$user ALL=(root)');
  const entries = commands.split(', ');
  assert.equal(entries.length, 3);
  const verbs = entries.map((entry) => {
    const m = entry.match(/^\$systemctl_path (stop|start|restart) \$unit$/);
    assert.ok(m, `${entry} is not systemctl <verb> <unit>`);
    return m[1];
  });
  assert.deepEqual(verbs.sort(), ['restart', 'start', 'stop']);
  assert.match(sh, /systemctl_path="\$\(command -v systemctl\)"/);
  assert.match(sh, /sudo visudo -cf "\$tmp"/, 'the line is validated before it is written');
  assert.match(sh, /\/etc\/sudoers\.d\/polaris-updater/);
});

test('the shell installer is executable and parses', (t) => {
  assert.ok(statSync(SH).mode & 0o111, 'scripts/install-updater-systemd.sh is not executable');
  const result = spawnSync('bash', ['-n', SH], { encoding: 'utf8' });
  if (result.error) {
    t.skip('bash is not installed');
    return;
  }
  assert.equal(result.status, 0, result.stderr);
});

test('neither installer carries an emoji or an em dash', () => {
  for (const text of [ps1, sh]) {
    assert.doesNotMatch(text, /[—\u{1F300}-\u{1FAFF}☀-➿]/u);
  }
});

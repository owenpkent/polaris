// The two installers for the scheduled updater (docs/update-proposal.md, section 3) are read here
// as text, since neither Task Scheduler nor systemd runs in a test. What they schedule is pinned:
// `cc update --auto` and nothing else, every five minutes, as the owner, outside the daemon, and
// the sudoers line a systemd system unit needs allows `systemctl` with stop, start, and restart
// on that one unit and nothing more. A change here is a change to what runs on the owner's
// machine unattended: make it in the scripts and the README together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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

/** The CC_* variables `cc update --auto` reads, by the module that reads them. A new one goes in
 *  the installer's list and template and in the README's Automatic updates section. */
const UPDATER_VARS = ['CC_DB', 'CC_BACKUP_DIR', 'CC_SECRETS_DIR', 'CC_UPDATE_RESTART', 'CC_UPDATE_AT', 'CC_TZ', 'CC_REPO_ROOT', 'CC_DASHBOARD_DIR', 'CC_API_TOKEN'];

test('the systemd service runs `cc update --auto` and nothing else, from command-center, logging to updater.log', () => {
  assert.deepEqual(cliArguments(sh), ['update --auto']);
  const execStart = sh.match(/^ExecStart=(.*)$/m);
  assert.ok(execStart, 'the service has one ExecStart');
  assert.equal(execStart[1], '"$node" "$cli" update --auto$port_arg');
  assert.equal(sh.match(/^ExecStart=/gm)?.length, 1);
  // --port is the one flag that joins --auto, and only as a checked number.
  assert.match(sh, /^port_arg=''$/m);
  assert.match(sh, /^\[ -n "\$port" \] && port_arg=" --port \$port"$/m);
  assert.equal(sh.match(/^port_arg=/gm)?.length, 1);
  assert.match(sh, /need_port\(\) \{ \[ \$# -gt 0 \] && \[\[ "\$1" =~ \^\[0-9\]\+\$ \]\] && \[ "\$1" -ge 1 \] && \[ "\$1" -le 65535 \]/);
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

test('the systemd service reads the owner-only environment file the installer makes, with every variable the updater reads as an example', () => {
  assert.match(sh, /^EnvironmentFile=-%h\/\.config\/polaris\/updater\.env$/m, 'the unit reads the file, and runs without it');
  assert.match(sh, /^env_file="\$HOME\/\.config\/polaris\/updater\.env"$/m, 'the same path the unit names');
  assert.match(sh, /\(umask 077; cat > "\$env_file" <<'EOF'/, 'made owner-only, and the template is not expanded');
  assert.match(sh, /^chmod 600 "\$env_file"$/m);
  const list = sh.match(/^updater_vars='([A-Z_ ]+)'$/m);
  assert.ok(list, 'the variables the installer copies from its own environment');
  assert.deepEqual(list[1].split(' ').sort(), [...UPDATER_VARS].sort());
  for (const name of UPDATER_VARS) assert.match(sh, new RegExp(`^#${name}=`, 'm'), `${name} is a commented example in the template`);
  assert.match(sh, /need_env\(\) \{ \[ \$# -gt 0 \] && \[\[ "\$1" =~ \^CC_\[A-Z0-9_\]\+=\.\*\$ \]\]/, '--env takes CC_* names only');
  // And the daemon's README names the same variables for the Linux unit.
  const readme = readFileSync(join(here, '..', 'README.md'), 'utf8');
  const section = readme.slice(readme.indexOf('### Automatic updates'), readme.indexOf('## Safety model'));
  assert.match(section, /~\/\.config\/polaris\/updater\.env/);
  for (const name of UPDATER_VARS) assert.ok(section.includes(name), `${name} is in the README's Automatic updates section`);
});

test('the shell installer writes the unit with --port and the environment file from its environment and --env, owner-only, keeping values on a rerun', (t) => {
  const result = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  if (result.error) {
    t.skip('bash is not installed');
    return;
  }
  // A scratch HOME, and stubs for systemctl (no daemon unit) and loginctl on PATH.
  const dir = mkdtempSync(join(tmpdir(), 'cc-installer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const bin = join(dir, 'bin');
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\n[ "$1" = is-active ] && exit 1\nexit 0\n');
  writeFileSync(join(bin, 'loginctl'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'systemctl'), 0o755);
  chmodSync(join(bin, 'loginctl'), 0o755);
  const run = (args: string[], env: Record<string, string> = {}) => spawnSync('bash', [SH, ...args], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: home, USER: 'owner', ...env },
  });
  const unitFile = join(home, '.config', 'systemd', 'user', 'polaris-updater.service');
  const envFile = join(home, '.config', 'polaris', 'updater.env');
  const values = () => readFileSync(envFile, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));

  const first = run(['--port', '8790', '--env', 'CC_BACKUP_DIR=/mnt/nas/backups', '--env=CC_UPDATE_AT=06:00'], { CC_DB: '/srv/polaris/constellation.db', CC_UPDATE_AT: '05:30', CC_SECRETS_DIR: '' });
  assert.equal(first.status, 0, first.stderr);
  const unit = readFileSync(unitFile, 'utf8');
  assert.match(unit, /^EnvironmentFile=-%h\/\.config\/polaris\/updater\.env$/m);
  assert.match(unit, /^ExecStart=".*node" ".*\/command-center\/src\/cli\.ts" update --auto --port 8790$/m);
  assert.equal(statSync(envFile).mode & 0o777, 0o600, 'owner-only');
  assert.deepEqual(values(), ['CC_DB=/srv/polaris/constellation.db', 'CC_BACKUP_DIR=/mnt/nas/backups', 'CC_UPDATE_AT=06:00'], 'inherited, then --env, which wins; an empty inherited value is not copied');
  for (const name of UPDATER_VARS) assert.match(readFileSync(envFile, 'utf8'), new RegExp(`^#${name}=`, 'm'));
  assert.match(first.stdout, /^Environment: .*updater\.env \(set now: CC_DB CC_UPDATE_AT CC_BACKUP_DIR CC_UPDATE_AT\)$/m, 'says where the file is');
  assert.match(first.stdout, /runs 'cc update --auto --port 8790' every five minutes/);

  // A rerun keeps what is there and sets only what it is given; without --port the unit has no port.
  const again = run(['--env', 'CC_DB=/elsewhere/constellation.db']);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(values(), ['CC_BACKUP_DIR=/mnt/nas/backups', 'CC_UPDATE_AT=06:00', 'CC_DB=/elsewhere/constellation.db']);
  assert.equal(statSync(envFile).mode & 0o777, 0o600);
  assert.match(readFileSync(unitFile, 'utf8'), /^ExecStart=.* update --auto$/m);
  const nothing = run([]);
  assert.equal(nothing.status, 0, nothing.stderr);
  assert.match(nothing.stdout, /^Environment: .*updater\.env \(nothing set: the defaults apply/m);
  assert.deepEqual(values(), ['CC_BACKUP_DIR=/mnt/nas/backups', 'CC_UPDATE_AT=06:00', 'CC_DB=/elsewhere/constellation.db'], 'untouched');

  // Bad flags are refused before anything is written.
  for (const args of [['--port'], ['--port', 'eighty'], ['--port', '0'], ['--port=70000'], ['--env'], ['--env', 'FOO=1'], ['--env', 'CC_DB']]) {
    const bad = run(args);
    assert.equal(bad.status, 1, args.join(' '));
    assert.match(bad.stderr, /--(port needs a port number|env needs CC_NAME=value)/, args.join(' '));
  }
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

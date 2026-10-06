// How `cc update` restarts the daemon (docs/update-proposal.md, section 1A): the Windows logon
// task, a systemd system unit through one sudoers line, a systemd user unit, or the owner by hand.
// Each one is a stop, a moment with nothing on the port for the dist swap and, in a rollback, the
// database restore, then a start. For the system unit the sudoers line allows `systemctl` with
// stop, start, and restart on that one unit and nothing else (scripts/install-updater-systemd.sh
// prints and writes it); restart is the verb the preflight check asks sudo about along with the
// two the restart itself uses.
//
// Every program runs through the Exec seam with an argument array. A unit name or a task name is
// never pasted into a command line.
import { connect } from 'node:net';
import type { Exec } from './exec.ts';

export const WINDOWS_TASK = 'Constellation Command Center';
export const DEFAULT_UNIT = 'polaris';

export type RestartMethod =
  | { kind: 'task'; task: string }
  | { kind: 'systemd'; unit: string }
  | { kind: 'systemd-user'; unit: string }
  | { kind: 'manual' };

export class RestartError extends Error {}

const UNIT_RE = /^[A-Za-z0-9_.@:-]+$/;

/** The verbs the sudoers line for a system unit allows: the two a restart uses, and restart itself. */
export const SYSTEMD_VERBS = ['stop', 'start', 'restart'] as const;

/** The one sudoers line a system unit needs, as scripts/install-updater-systemd.sh writes it. */
export function sudoersLine(unit: string, user = process.env.USER ?? '<you>'): string {
  return `${user} ALL=(root) NOPASSWD: ${SYSTEMD_VERBS.map((verb) => `/usr/bin/systemctl ${verb} ${unit}`).join(', ')}`;
}

/** CC_UPDATE_RESTART: `task`, `systemd:<unit>`, `systemd-user:<unit>`, or `manual`. */
export function parseRestartSpec(spec: string): RestartMethod {
  const text = spec.trim();
  if (text === 'task') return { kind: 'task', task: WINDOWS_TASK };
  if (text === 'manual') return { kind: 'manual' };
  const m = /^(systemd|systemd-user):(.+)$/.exec(text);
  if (m && UNIT_RE.test(m[2])) return { kind: m[1] as 'systemd' | 'systemd-user', unit: m[2] };
  throw new RestartError(`CC_UPDATE_RESTART is "${spec}". Use task, systemd:<unit>, systemd-user:<unit>, or manual.`);
}

export function describeRestart(method: RestartMethod): string {
  switch (method.kind) {
    case 'task': return `the Windows scheduled task "${method.task}"`;
    case 'systemd': return `the systemd unit ${method.unit} (sudo -n systemctl stop ${method.unit}, then start)`;
    case 'systemd-user': return `the systemd user unit ${method.unit}`;
    case 'manual': return 'by hand: you stop and start the daemon when asked';
  }
}

/** Whether `cc update` can restart the daemon itself, which is what lets a rollback finish on its own. */
export function canRestart(method: RestartMethod): boolean {
  return method.kind !== 'manual';
}

/** The detection order of section 1A: the logon task on Windows, then the system unit, then the
 *  user unit, otherwise manual. Each probe is a program that may not exist, which reads as "no". */
export async function detectRestart(exec: Exec, platform: NodeJS.Platform): Promise<RestartMethod> {
  if (platform === 'win32') {
    const r = await exec('powershell.exe', powershellArgs(`if (Get-ScheduledTask -TaskName '${WINDOWS_TASK}' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`));
    return r.code === 0 ? { kind: 'task', task: WINDOWS_TASK } : { kind: 'manual' };
  }
  if (platform === 'linux') {
    if ((await exec('systemctl', ['is-active', '--quiet', DEFAULT_UNIT])).code === 0) return { kind: 'systemd', unit: DEFAULT_UNIT };
    if ((await exec('systemctl', ['--user', 'is-active', '--quiet', DEFAULT_UNIT])).code === 0) return { kind: 'systemd-user', unit: DEFAULT_UNIT };
  }
  return { kind: 'manual' };
}

/** What would stop a restart later, found now, before anything has moved: the task or unit must
 *  exist, and a system unit needs the sudoers line. Returns the problem, or null. */
export async function restartProblem(method: RestartMethod, exec: Exec): Promise<string | null> {
  switch (method.kind) {
    case 'task': {
      const r = await exec('powershell.exe', powershellArgs(`if (Get-ScheduledTask -TaskName '${method.task}' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`));
      return r.code === 0 ? null : `there is no scheduled task named "${method.task}" (scripts/install-command-center-task.ps1 makes it)`;
    }
    case 'systemd': {
      const loaded = await exec('systemctl', ['show', '-p', 'LoadState', '--value', method.unit]);
      if (loaded.code !== 0 || loaded.stdout.trim() !== 'loaded') return `systemd has no unit named ${method.unit}`;
      for (const verb of SYSTEMD_VERBS) {
        const allowed = await exec('sudo', ['-n', '-l', 'systemctl', verb, method.unit]);
        if (allowed.code !== 0) return `sudo cannot run "systemctl ${verb} ${method.unit}" without a password. Add this sudoers line (visudo), or run scripts/install-updater-systemd.sh --sudoers: ${sudoersLine(method.unit)}`;
      }
      return null;
    }
    case 'systemd-user': {
      const loaded = await exec('systemctl', ['--user', 'show', '-p', 'LoadState', '--value', method.unit]);
      return loaded.code === 0 && loaded.stdout.trim() === 'loaded' ? null : `systemd has no user unit named ${method.unit}`;
    }
    case 'manual':
      return null;
  }
}

export interface RestartDeps {
  exec: Exec;
  portListening: (port: number) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Progress and, for the manual method, the instructions. */
  say: (line: string) => void;
}

export interface RestartOptions {
  port: number;
  /** Runs once the daemon is stopped and nothing listens on the port: the dist swap, and in a
   *  rollback the database restore. */
  between: () => void;
  /** How long to wait for the daemon to let go of the port, and to take it again. */
  stopTimeoutMs?: number;
  startTimeoutMs?: number;
}

const MANUAL_TIMEOUT_MS = 10 * 60_000;

/** Stop the daemon, run `between`, start it, and wait until it listens again. Throws RestartError
 *  when a step fails or a wait runs out; `between` has then run only if the stop succeeded. */
export async function restartDaemon(method: RestartMethod, opts: RestartOptions, deps: RestartDeps): Promise<void> {
  const stopTimeout = opts.stopTimeoutMs ?? (method.kind === 'manual' ? MANUAL_TIMEOUT_MS : 60_000);
  const startTimeout = opts.startTimeoutMs ?? (method.kind === 'manual' ? MANUAL_TIMEOUT_MS : 60_000);
  const must = async (what: string, cmd: string, args: string[]) => {
    const r = await deps.exec(cmd, args);
    if (r.code !== 0) throw new RestartError(`${what} failed (${r.code}): ${(r.stderr || r.stdout).trim()}`);
  };
  switch (method.kind) {
    case 'task':
      await must('Stop-ScheduledTask', 'powershell.exe', powershellArgs(`Stop-ScheduledTask -TaskName '${method.task}'`));
      await waitForPort(false, opts.port, stopTimeout, deps);
      opts.between();
      await must('Start-ScheduledTask', 'powershell.exe', powershellArgs(`Start-ScheduledTask -TaskName '${method.task}'`));
      break;
    case 'systemd-user':
      await must(`systemctl --user stop ${method.unit}`, 'systemctl', ['--user', 'stop', method.unit]);
      await waitForPort(false, opts.port, stopTimeout, deps);
      opts.between();
      await must(`systemctl --user start ${method.unit}`, 'systemctl', ['--user', 'start', method.unit]);
      break;
    case 'systemd':
      await must(`sudo -n systemctl stop ${method.unit}`, 'sudo', ['-n', 'systemctl', 'stop', method.unit]);
      await waitForPort(false, opts.port, stopTimeout, deps);
      opts.between();
      await must(`sudo -n systemctl start ${method.unit}`, 'sudo', ['-n', 'systemctl', 'start', method.unit]);
      break;
    case 'manual':
      deps.say(`Stop the daemon now (the process listening on port ${opts.port}). Waiting up to ${Math.round(stopTimeout / 60_000)} minutes.`);
      await waitForPort(false, opts.port, stopTimeout, deps);
      opts.between();
      deps.say(`Start the daemon now. Waiting up to ${Math.round(startTimeout / 60_000)} minutes for port ${opts.port}.`);
      break;
  }
  await waitForPort(true, opts.port, startTimeout, deps);
}

/** Wait until something listens on the port (or nothing does), polling, up to the timeout. */
export async function waitForPort(listening: boolean, port: number, timeoutMs: number, deps: Pick<RestartDeps, 'portListening' | 'sleep' | 'now'>): Promise<void> {
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    if ((await deps.portListening(port)) === listening) return;
    if (deps.now() >= deadline) throw new RestartError(listening ? `nothing is listening on port ${port} after ${timeoutMs / 1000}s` : `port ${port} is still in use after ${timeoutMs / 1000}s`);
    await deps.sleep(250);
  }
}

/** Whether a TCP connection to 127.0.0.1:port is accepted. */
export function realPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(2000, () => { socket.destroy(); resolve(false); });
  });
}

function powershellArgs(command: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command];
}

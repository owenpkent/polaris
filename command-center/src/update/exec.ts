// The one seam through which `cc update` runs a program: git, npm, the tests, the build, and the
// restart (docs/update-proposal.md, section 7, rule 1). Everything above it takes an `Exec` and the
// tests pass a scripted one, so the whole update flow is exercised without a program being run.
//
// This module is the only one under src/update that imports child_process, and it is reached only
// through run.ts, behind the dynamic import in commands.ts: the daemon's static import graph never
// includes it (invariants.test.ts, group 11).
import { spawn } from 'node:child_process';

export interface ExecResult {
  /** The exit code, or -1 when the program could not be started (not installed, not on PATH). */
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Lines of the program's output, as they arrive, for the log and the console. */
  onOutput?: (line: string) => void;
}

export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

/** The `npm` and `npx` programs by platform: on Windows they are .cmd shims, which only a shell can start. */
export function npmProgram(name: 'npm' | 'npx', platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${name}.cmd` : name;
}

/** Runs the program with its output captured, never through a shell except for a Windows .cmd shim,
 *  whose arguments are then quoted here. The arguments are always an array: nothing from a version,
 *  a path, or a unit name is ever pasted into a command line. */
export function realExec(platform: NodeJS.Platform = process.platform): Exec {
  return (cmd, args, opts = {}) => new Promise((resolve) => {
    const shell = platform === 'win32' && cmd.toLowerCase().endsWith('.cmd');
    const child = spawn(shell ? [cmd, ...args.map(quoteForCmd)].join(' ') : cmd, shell ? [] : args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell,
      windowsHide: true,
    });
    const out = lineCollector(opts.onOutput);
    const err = lineCollector(opts.onOutput);
    child.stdout.on('data', out.push);
    child.stderr.on('data', err.push);
    child.on('error', (e) => resolve({ code: -1, stdout: out.text(), stderr: [err.text(), e.message].filter(Boolean).join('\n') }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: out.text(), stderr: err.text() }));
  });
}

/** Gathers a stream's output and hands over each whole line as it arrives. */
function lineCollector(onLine?: (line: string) => void): { push: (chunk: Buffer) => void; text: () => string } {
  const lines: string[] = [];
  let rest = '';
  return {
    push(chunk) {
      const parts = (rest + chunk.toString('utf8')).split(/\r?\n/);
      rest = parts.pop() ?? '';
      for (const line of parts) { lines.push(line); onLine?.(line); }
    },
    text() {
      if (rest) { lines.push(rest); onLine?.(rest); rest = ''; }
      return lines.join('\n');
    },
  };
}

function quoteForCmd(arg: string): string {
  return /^[\w./:\\=-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

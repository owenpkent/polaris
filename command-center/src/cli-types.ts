import type { App } from './app.ts';
import type { Config } from './config.ts';
import type { SecretStore } from './ingest/secrets.ts';

export interface Command {
  /** e.g. "import", "sync github", "mcp". Multi-word names are matched greedily against argv. */
  name: string;
  summary: string;
  usage?: string;
  /** Receives remaining argv after the command name. Return a process exit code. */
  run(args: string[], ctx: CommandContext): Promise<number> | number;
}

export interface CommandContext {
  openApp: () => App;
  /** Where things are, without opening (and so creating or migrating) the database. Defaults to `loadConfig()`. */
  config?: () => Config;
  /** Tests pass an in-memory store. Defaults to `defaultSecretStore()`. */
  secrets?: SecretStore;
  /** Ask for a secret without showing it. Tests pass canned answers. Defaults to `readSecret` in prompt.ts. */
  readSecret?: (question: string) => Promise<string>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

/** Minimal flag parser: --key value, --key=value, --flag (boolean). Positional args in `_`. */
export function parseFlags(args: string[]): { _: string[]; [k: string]: string | boolean | string[] } {
  const out: { _: string[]; [k: string]: string | boolean | string[] } = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < args.length && !args[i + 1].startsWith('--')) out[a.slice(2)] = args[++i];
      else out[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

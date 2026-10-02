// Composition root: config + store wired with automation hooks. Every entry point (CLI, MCP, HTTP) uses this.
import { loadConfig, type Config } from './config.ts';
import { openStore, type Store } from './core/index.ts';
import { nextOccurrence, todayIn } from './automation/index.ts';
import type { SecretStore } from './ingest/secrets.ts';

export interface App {
  config: Config;
  store: Store;
  /** Tests pass an in-memory store. Left out, callers use `defaultSecretStore()`. */
  secrets?: SecretStore;
  /**
   * The fetch the GitHub syncs use. Left out, the global fetch. Set only by the UI test server's
   * fake GitHub (dev/githubFake.ts, behind CC_GITHUB_FAKE=1 in http/commands.ts); openApp never sets it.
   */
  githubFetch?: typeof fetch;
  /** 'YYYY-MM-DD' in the configured timezone. */
  today(): string;
  close(): void;
}

export function openApp(overrides: Partial<Config> = {}): App {
  const config = { ...loadConfig(), ...overrides };
  const store = openStore(config.dbPath, {
    nextOccurrence: (rule, prev) => nextOccurrence(rule, prev, todayIn(config.timezone)),
    validateRecurrence: (rule) => {
      const today = todayIn(config.timezone);
      try { nextOccurrence(rule, today, today); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
    },
  });
  return {
    config,
    store,
    today: () => todayIn(config.timezone),
    close: () => store.db.close(),
  };
}

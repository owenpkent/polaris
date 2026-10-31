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

export interface AppOptions {
  /**
   * The clock the app and its store read. Left out, the real one. Tests that assert on dates pin
   * it, so a fixed due date in a test does not go stale when the calendar passes it.
   */
  now?: () => Date;
}

export function openApp(overrides: Partial<Config> = {}, options: AppOptions = {}): App {
  const config = { ...loadConfig(), ...overrides };
  const now = options.now ?? (() => new Date());
  const today = () => todayIn(config.timezone, now());
  const store = openStore(config.dbPath, {
    now: () => now().toISOString(),
    nextOccurrence: (rule, prev, context) => nextOccurrence(rule, prev, today(), context),
    today,
    timezone: config.timezone,
    dayOf: (iso) => todayIn(config.timezone, new Date(iso)),
    validateRecurrence: (rule) => {
      const t = today();
      try { nextOccurrence(rule, t, t); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
    },
  });
  return {
    config,
    store,
    today,
    close: () => store.db.close(),
  };
}

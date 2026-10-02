// Runtime configuration. Everything is overridable by environment variables.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export interface Config {
  /** Root of the repo that holds initiatives/ and PROJECT_STATUS.md (CC_REPO_ROOT). */
  repoRoot: string;
  /** SQLite database file. */
  dbPath: string;
  /** IANA timezone used for "today" in views and digests. */
  timezone: string;
  /** Built dashboard directory (repo root dist/, from `npm run build`), served at `/` by the HTTP server. */
  dashboardDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const repoRoot = resolve(env.CC_REPO_ROOT ?? join(here, '..', '..'));
  return {
    repoRoot,
    dbPath: resolve(env.CC_DB ?? join(repoRoot, 'command-center', 'data', 'constellation.db')),
    timezone: env.CC_TZ ? checkedTimezone(env.CC_TZ) : Intl.DateTimeFormat().resolvedOptions().timeZone,
    dashboardDir: resolve(env.CC_DASHBOARD_DIR ?? join(repoRoot, 'dist')),
  };
}

/** A mistyped CC_TZ must stop the start, not surface later as a RangeError inside a due date or the digest. */
function checkedTimezone(zone: string): string {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zone });
    return zone;
  } catch {
    throw new Error(`CC_TZ is not a timezone this machine knows: "${zone}". Use an IANA name such as America/Chicago.`);
  }
}

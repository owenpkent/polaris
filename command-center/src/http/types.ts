// Shared option/status shapes for the HTTP layer. Kept in their own file so server.ts and
// rest.ts can both depend on them without importing from each other.
import type { OAuthStateStore } from '../ingest/github/oauthState.ts';
import type { SecretStore } from '../ingest/secrets.ts';

export interface JobStatus {
  lastRunAt: string | null;
  lastError: string | null;
  running: boolean;
}

/**
 * Three independent bearer tokens, one per trust boundary. Each route accepts only its own
 * token: the api token never works on /mcp or /mcp/readonly, the mcp token never works on /api
 * or /mcp/readonly, and the mcp-readonly token only ever works on /mcp/readonly. This keeps an
 * agent holding the MCP token from reaching REST mutations (which are logged as actor 'human'),
 * and keeps a readonly MCP client from reaching write tools.
 */
export interface ApiTokens {
  /** REST /api/*, used by the dashboard. Mutations through it are actor 'human'. */
  api: string;
  /** Full /mcp (read + write tools), actor 'agent'. */
  mcp: string;
  /** /mcp/readonly only (read tools; write tools are not even registered). */
  mcpReadonly: string;
}

export interface HttpServerOptions {
  /** Bearer tokens gating /api, /mcp, and /mcp/readonly respectively. */
  tokens: ApiTokens;
  /** Origins allowed to receive CORS headers (including preflight). */
  corsOrigins: string[];
  /** When true, /mcp also serves the readonly tool set (in addition to /mcp/readonly). */
  readonlyMcp?: boolean;
  /** HMAC secret for the GitHub webhook receiver. When unset, /webhooks/github is 404. */
  webhookSecret?: string;
  /** Named background jobs POST /api/sync/:job can start. */
  jobs?: Record<string, () => Promise<unknown>>;
  /** Status for GET /api/sync and for rejecting a job already in flight (409). */
  getJobStatus?: () => Record<string, JobStatus>;
  /** Test-only override for the fetch used by the GitHub App routes (manifest/login/repos/etc). Defaults to global fetch. */
  githubFetchImpl?: typeof fetch;
  /** Test-only override for where the GitHub App's client secret and user token are stored. Defaults to `defaultGithubSecretStore()`. */
  githubSecrets?: SecretStore;
  /** Test-only override for the manifest/login one-time state store, so expiry can be tested with a fake clock. Defaults to a fresh real-time store. */
  githubStateStore?: OAuthStateStore;
  /** Absolute path of the built dashboard to serve at `/`. When unset, `/` is a 404 as before. */
  dashboardDir?: string;
}

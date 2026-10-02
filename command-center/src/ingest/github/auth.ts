// Token resolution. A resolved token is returned to the caller and never logged or persisted
// (not even the KV cache, which only ever stores ETags and cursors) -- except the GitHub App's
// own user token, which app.ts stores encrypted for reuse across runs.
//
// resolveGithubAuth is what every caller (sync, repo-files, the webhook receiver, the CLI) uses.
// The read-only GitHub App's user access token is the only credential: it is returned when the
// app is configured and signed in, refreshed close to expiry. The GITHUB_TOKEN and `gh auth token`
// fallbacks were removed on 2026-09-20. They could read and write every repo the owner can, which is
// exactly what the App exists to avoid. Not signed in means GitHub is not synced, and says so.
//
// Deliberately takes no Store/database of any kind: the GitHub connection (app registration,
// client secret, user token) is a machine-wide thing, entirely inside the SecretStore -- see
// app.ts. That is also why the in-flight-refresh dedup below is a single module-level slot
// rather than keyed by anything: there is only ever one GitHub connection per machine.
import type { SecretStore } from '../secrets.ts';
import { GithubSessionEndedError, clearUserToken, defaultGithubSecretStore, loadAppSecrets, saveUserToken, sessionOf, type GithubAppSecrets } from './app.ts';
import { refreshLoginToken } from './oauth.ts';

export class GithubAuthError extends Error {}

/** Thrown when there is simply no sign-in yet, as opposed to one that failed. Syncs report it as skipped, not as an error. */
export class GithubNotSignedInError extends GithubAuthError {}

const NOT_SIGNED_IN_MESSAGE = 'Not signed in to GitHub. Connect the GitHub App from the GitHub page in the dashboard.';
const SIGN_IN_EXPIRED_MESSAGE = 'GitHub sign-in expired. Sign in again from the GitHub page in the dashboard.';
const REFRESH_MARGIN_MS = 5 * 60_000;
const BAD_REFRESH_ERRORS = new Set(['bad_refresh_token', 'invalid_grant', 'expired_token']);

export interface GithubAuthDeps {
  secrets?: SecretStore;
  fetchImpl?: typeof fetch;
  /** Injectable clock, for tests that need deterministic expiry math. */
  now?: () => number;
}

/** True when accessToken exists and (per accessExpiresAt) is not within REFRESH_MARGIN_MS of expiry. `null` means "known non-expiring". */
function tokenIsFresh(secrets: GithubAppSecrets, now: number): boolean {
  if (!secrets.accessToken) return false;
  if (secrets.accessExpiresAt === null) return true;
  if (!secrets.accessExpiresAt) return false;
  return Date.parse(secrets.accessExpiresAt) - now >= REFRESH_MARGIN_MS;
}

function refreshTokenExpired(secrets: GithubAppSecrets, now: number): boolean {
  return Boolean(secrets.refreshToken) && Boolean(secrets.refreshExpiresAt) && Date.parse(secrets.refreshExpiresAt!) <= now;
}

// A single slot, not keyed by anything: there is only ever one GitHub App connection on a given
// machine, so any two concurrent callers needing a refresh (the daemon's scheduler and its HTTP
// server, say) must collapse onto the same in-flight token exchange.
let inFlightRefresh: Promise<GithubAppSecrets> | undefined;

// GitHub rotates the refresh token on every refresh and refuses one that was used before. The
// single flight above is per process, so across processes (the daemon and a CLI command) the whole
// exchange runs under one lock in the secret store: read, spend, save. Without it a process could
// be refused a refresh token another had just spent, before that one saved the new pair, and clear
// the sign-in while the new pair was on its way. The exchange is stopped after 30 seconds; with the
// read and the save around it (PowerShell on Windows, 20 seconds a run) a holder is done well
// inside the three minutes after which its lock counts as dead.
const REFRESH_LOCK = 'github-refresh';
const REFRESH_LOCK_MS = 180_000;
const REFRESH_EXCHANGE_MS = 30_000;

async function doRefresh(secrets: SecretStore, fetchImpl: typeof fetch, clock: () => number): Promise<GithubAppSecrets> {
  if (inFlightRefresh) return inFlightRefresh;
  const promise = (async () => {
    try {
      return await secrets.exclusive(REFRESH_LOCK, () => refreshUnderLock(secrets, fetchImpl, clock()), {
        timeoutMs: REFRESH_LOCK_MS, staleMs: REFRESH_LOCK_MS,
      });
    } finally {
      inFlightRefresh = undefined;
    }
  })();
  inFlightRefresh = promise;
  return promise;
}

// Everything here is decided on what the store holds once the lock is held, not on what the caller
// read: that read can finish after another refresh has already replaced the token.
async function refreshUnderLock(secrets: SecretStore, fetchImpl: typeof fetch, now: number): Promise<GithubAppSecrets> {
  const current = await loadAppSecrets(secrets);
  if (!current?.accessToken) throw new GithubNotSignedInError(NOT_SIGNED_IN_MESSAGE);
  // Ends the sign-in this decision was made on and no other: a sign-in or sign-out may have
  // happened meanwhile (the lock does not cover those), and a newer sign-in is used, not cleared.
  const endSignIn = async (): Promise<GithubAppSecrets> => {
    const same = { session: sessionOf(current), accessToken: current.accessToken, refreshToken: current.refreshToken };
    if (await clearUserToken(secrets, same)) throw new GithubAuthError(SIGN_IN_EXPIRED_MESSAGE);
    const newer = await loadAppSecrets(secrets);
    if (!newer?.accessToken) throw new GithubNotSignedInError(NOT_SIGNED_IN_MESSAGE);
    if (!refreshTokenExpired(newer, now) && tokenIsFresh(newer, now)) return newer;
    throw new Error('The GitHub sign-in changed during this refresh. The next attempt uses the new one.');
  };
  if (refreshTokenExpired(current, now)) return await endSignIn();
  if (tokenIsFresh(current, now)) return current;
  if (!current.refreshToken) return await endSignIn();
  const timedFetch: typeof fetch = (input, init) => fetchImpl(input, { ...init, signal: AbortSignal.timeout(REFRESH_EXCHANGE_MS) });
  const resp = await refreshLoginToken(current.clientId, current.clientSecret, current.refreshToken, timedFetch);
  if (!resp.access_token) {
    if (resp.error && BAD_REFRESH_ERRORS.has(resp.error)) return await endSignIn();
    throw new Error(`GitHub token refresh failed: ${resp.error ?? 'no access_token in response'}`);
  }
  const updated: GithubAppSecrets = {
    ...current,
    accessToken: resp.access_token,
    refreshToken: resp.refresh_token ?? current.refreshToken,
    accessExpiresAt: resp.expires_in != null ? new Date(now + resp.expires_in * 1000).toISOString() : null,
    refreshExpiresAt: resp.refresh_token_expires_in != null ? new Date(now + resp.refresh_token_expires_in * 1000).toISOString() : current.refreshExpiresAt,
  };
  try {
    await saveUserToken(secrets, {
      accessToken: updated.accessToken!,
      refreshToken: updated.refreshToken,
      accessExpiresAt: updated.accessExpiresAt ?? null,
      refreshExpiresAt: updated.refreshExpiresAt ?? null,
      login: updated.login ?? current.login ?? '',
    }, sessionOf(current));
  } catch (e) {
    // The owner signed out while GitHub was answering. The new token is dropped, not used: a
    // sync that is waiting on this refresh is now a sync with no sign-in, and says so.
    if (e instanceof GithubSessionEndedError) throw new GithubNotSignedInError(NOT_SIGNED_IN_MESSAGE);
    throw e;
  }
  return updated;
}

/**
 * The resolver every caller should use. Returns the GitHub App's user access token when the app
 * is configured and signed in (refreshing it first if it is within 5 minutes of expiring, or
 * throwing GithubAuthError if the refresh token itself is expired or GitHub rejects it). With no
 * sign-in at all it throws GithubNotSignedInError: there is no other credential to fall back to.
 */
export async function resolveGithubAuth(deps: GithubAuthDeps = {}): Promise<string> {
  const clock = deps.now ?? Date.now;
  const now = clock();
  const secrets = deps.secrets ?? defaultGithubSecretStore();
  const current = await loadAppSecrets(secrets);
  if (!current?.accessToken) throw new GithubNotSignedInError(NOT_SIGNED_IN_MESSAGE);
  if (!refreshTokenExpired(current, now) && tokenIsFresh(current, now)) return current.accessToken;
  // Anything else, clearing an expired sign-in included, is decided inside the single flight.
  const settled = await doRefresh(secrets, deps.fetchImpl ?? fetch, clock);
  return settled.accessToken!;
}

export type GithubAuthMode = 'app' | 'none';

export interface GithubAuthStatus {
  mode: GithubAuthMode;
  login?: string;
  refreshExpiresAt?: string | null;
}

/** Reports whether resolveGithubAuth has a sign-in to use right now, without leaking any token. */
export async function describeGithubAuth(deps: GithubAuthDeps = {}): Promise<GithubAuthStatus> {
  const now = deps.now ? deps.now() : Date.now();
  const secrets = deps.secrets ?? defaultGithubSecretStore();
  const current = await loadAppSecrets(secrets);
  if (current?.accessToken && !refreshTokenExpired(current, now)) {
    return { mode: 'app', login: current.login, refreshExpiresAt: current.refreshExpiresAt ?? null };
  }
  return { mode: 'none' };
}

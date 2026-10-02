// GitHub App credential storage. Everything -- the app registration (app id, slug, name, html
// url, client id, client secret) and the signed-in user's tokens -- lives in one JSON blob in the
// DPAPI-backed SecretStore (see ../secrets.ts), under the
// 'github-app-secrets' key. This is deliberate: the GitHub connection is a machine-wide thing
// (one app registration, one signed-in user), not something that should vary per CC_DB. A
// database with no app configured yet must never see "not configured" and offer to register a
// second app while the machine already has one -- that would create a clashing app on GitHub
// while orphaning the first app's client secret in the secret store.
//
// An earlier revision kept the public config fields in the per-database kv table (key
// 'github:app'). That kv key is no longer read or written; any value left over from that revision
// is simply ignored (nothing has shipped, so no migration is needed).
//
// The manifest's private key (pem) and webhook secret are never even passed in here -- see
// saveAppFromConversion.
import { defaultSecretStore, type SecretStore } from '../secrets.ts';
import type { ManifestConversionResponse } from './oauth.ts';

const SECRETS_KEY = 'github-app-secrets';

export interface GithubAppConfig {
  appId: string;
  slug: string;
  name: string;
  htmlUrl: string;
  clientId: string;
}

/**
 * The whole stored record: the app's public config plus its client secret plus (once signed in)
 * the user's tokens, all in one blob. `accessExpiresAt`/`refreshExpiresAt`: an ISO timestamp when
 * known, or `null` when GitHub told us the corresponding token does not expire at all (an app
 * with expiring user tokens turned off).
 */
export interface GithubAppSecrets extends GithubAppConfig {
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
  accessExpiresAt?: string | null;
  refreshExpiresAt?: string | null;
  login?: string;
  /**
   * Which sign-in the stored token belongs to. Every sign-out moves it on, and a token write
   * names the session it was started under, so a refresh or a login that was still waiting on
   * GitHub when the owner signed out cannot put a token back afterwards. Absent on records from
   * before this field existed, which reads as 0.
   */
  session?: number;
}

/** Thrown by saveUserToken when the sign-in the token belongs to has ended in the meantime. */
export class GithubSessionEndedError extends Error {}

export const sessionOf = (secrets: Pick<GithubAppSecrets, 'session'> | undefined): number => secrets?.session ?? 0;

export interface SavedUserToken {
  accessToken: string;
  refreshToken?: string;
  accessExpiresAt: string | null;
  refreshExpiresAt: string | null;
  login: string;
}

/** The store the GitHub App's secrets live in: the one shared store. */
export const defaultGithubSecretStore = defaultSecretStore;

export async function loadAppSecrets(secrets: SecretStore): Promise<GithubAppSecrets | undefined> {
  const raw = await secrets.get(SECRETS_KEY);
  if (!raw) return undefined;
  return JSON.parse(raw) as GithubAppSecrets;
}

async function writeAppSecrets(secrets: SecretStore, value: GithubAppSecrets): Promise<void> {
  await secrets.set(SECRETS_KEY, JSON.stringify(value));
}

/** The app's public config, or undefined if no app has been registered on this machine yet. */
export async function loadApp(secrets: SecretStore): Promise<GithubAppConfig | undefined> {
  const record = await loadAppSecrets(secrets);
  if (!record) return undefined;
  const { appId, slug, name, htmlUrl, clientId } = record;
  return { appId, slug, name, htmlUrl, clientId };
}

/**
 * Saves the app registration returned by the manifest conversion. `conversion.pem` (the app's
 * private key) and `conversion.webhook_secret` are intentionally ignored: Polaris only ever
 * uses user access tokens, never an installation/JWT-based token, and webhooks stay disabled
 * (ADR-006), so neither value is ever read, stored, or logged.
 */
export async function saveAppFromConversion(secrets: SecretStore, conversion: ManifestConversionResponse): Promise<void> {
  await writeAppSecrets(secrets, {
    appId: String(conversion.id),
    slug: conversion.slug,
    name: conversion.name,
    htmlUrl: conversion.html_url,
    clientId: conversion.client_id,
    clientSecret: conversion.client_secret,
  });
}

/**
 * Persists a freshly signed-in (or refreshed) user token, keeping the stored app config and
 * clientSecret. `session` is the value the caller read before it went to GitHub: when a sign-out
 * has moved it on since, the token is not written and GithubSessionEndedError is thrown. The
 * check and the write are one step in the store, so a writer in another process cannot come
 * between them. Left out, the write is unconditional, which only test seeding should want.
 */
export async function saveUserToken(secrets: SecretStore, token: SavedUserToken, session?: number): Promise<void> {
  await secrets.update(SECRETS_KEY, (raw) => {
    const existing = raw ? JSON.parse(raw) as GithubAppSecrets : undefined;
    if (!existing) throw new Error('cannot save a GitHub user token before the app is configured');
    if (session !== undefined && session !== sessionOf(existing)) {
      throw new GithubSessionEndedError('GitHub sign-in ended while the token was being fetched; the token was not saved');
    }
    return JSON.stringify({ ...existing, ...token });
  });
}

/** Which sign-in a conditional clear is about. All three must match: two sign-ins can both lack a refresh token. */
export interface SignInIdentity {
  session: number;
  accessToken: string | undefined;
  refreshToken: string | undefined;
}

/**
 * Clears the signed-in user's token fields and ends the session, but keeps the app registration
 * (clientSecret included). With `onlyIf` it clears only while that same sign-in is still stored:
 * a refresh that GitHub refused says nothing about a newer sign-in saved meanwhile. Returns
 * whether it cleared.
 */
export async function clearUserToken(secrets: SecretStore, onlyIf?: SignInIdentity): Promise<boolean> {
  let cleared = false;
  await secrets.update(SECRETS_KEY, (raw) => {
    if (!raw) return undefined;
    const existing = JSON.parse(raw) as GithubAppSecrets;
    if (onlyIf && (sessionOf(existing) !== onlyIf.session || existing.accessToken !== onlyIf.accessToken || existing.refreshToken !== onlyIf.refreshToken)) return undefined;
    const { accessToken: _a, refreshToken: _r, accessExpiresAt: _ae, refreshExpiresAt: _re, login: _l, ...rest } = existing;
    cleared = true;
    return JSON.stringify({ ...rest, session: sessionOf(existing) + 1 });
  });
  return cleared;
}

/** Clears the app registration and every secret, including the client secret and any user token. */
export async function forgetApp(secrets: SecretStore): Promise<void> {
  await secrets.delete(SECRETS_KEY);
}

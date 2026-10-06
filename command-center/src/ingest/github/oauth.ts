// Pure GitHub App web-flow mechanics: building the manifest and the login authorize URL, and the
// two token endpoints (manifest conversion, code/refresh exchange). No storage and no state here
// -- see app.ts for credential storage and oauthState.ts for the one-time state values. Every
// fetch is injectable so tests never hit the network. PKCE generation lives in ../pkce.ts.
export { generatePkce } from '../pkce.ts';

const GITHUB_API = 'https://api.github.com';
const GITHUB_WEB = 'https://github.com';

function ghHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'constellation-command-center',
    ...extra,
  };
}

// ------------------------------------------------------------------- manifest

export interface GithubManifest {
  name: string;
  url: string;
  redirect_url: string;
  callback_urls: string[];
  public: boolean;
  request_oauth_on_install: boolean;
  default_permissions: Record<string, string>;
  default_events: string[];
}

/**
 * `port` is the local HTTP server's actual listening port, read from the incoming request.
 * No `hook_attributes`: GitHub rejects a manifest whose hook url is not publicly reachable,
 * even with the hook inactive, and Polaris receives no webhooks from the App.
 */
export function buildManifest(port: number): GithubManifest {
  return {
    name: 'Polaris Command Center',
    url: 'https://github.com/owenpkent/constellation',
    redirect_url: `http://127.0.0.1:${port}/api/github/app/callback`,
    callback_urls: ['http://127.0.0.1/api/github/callback'],
    public: true,
    request_oauth_on_install: false,
    default_permissions: {
      metadata: 'read',
      contents: 'read',
      issues: 'read',
      pull_requests: 'read',
      checks: 'read',
      statuses: 'read',
    },
    default_events: [],
  };
}

export interface ManifestConversionResponse {
  id: number;
  slug: string;
  name: string;
  html_url: string;
  client_id: string;
  client_secret: string;
  /** Never read beyond this response: app.ts's saveAppFromConversion discards it. */
  pem?: string;
  /** Never read beyond this response: app.ts's saveAppFromConversion discards it. */
  webhook_secret?: string;
}

/** No auth required for this endpoint -- the one-time manifest `code` is the credential. */
export async function exchangeManifestCode(code: string, fetchImpl: typeof fetch = fetch): Promise<ManifestConversionResponse> {
  const res = await fetchImpl(`${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers: ghHeaders(),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} converting the app manifest`);
  return (await res.json()) as ManifestConversionResponse;
}

// --------------------------------------------------------------------- login

export function buildLoginAuthUrl(clientId: string, opts: { redirectUri: string; state: string; codeChallenge: string }): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: opts.redirectUri,
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${GITHUB_WEB}/login/oauth/authorize?${params.toString()}`;
}

export interface GithubTokenResponse {
  access_token?: string;
  refresh_token?: string;
  /** Seconds. Absent when the app has expiring user tokens turned off. */
  expires_in?: number;
  /** Seconds. Absent alongside `expires_in`, or when no refresh token was issued. */
  refresh_token_expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function postToken(params: Record<string, string>, fetchImpl: typeof fetch): Promise<GithubTokenResponse> {
  const res = await fetchImpl(`${GITHUB_WEB}/login/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  });
  return (await res.json()) as GithubTokenResponse;
}

export async function exchangeLoginCode(
  clientId: string,
  clientSecret: string,
  opts: { code: string; verifier: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch,
): Promise<GithubTokenResponse> {
  return postToken({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code: opts.code,
    code_verifier: opts.verifier,
    redirect_uri: opts.redirectUri,
  }, fetchImpl);
}

export async function refreshLoginToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubTokenResponse> {
  return postToken({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }, fetchImpl);
}

export async function fetchViewerLogin(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`${GITHUB_API}/user`, { headers: ghHeaders({ Authorization: `Bearer ${accessToken}` }) });
  if (!res.ok) throw new Error(`GitHub ${res.status} fetching /user`);
  const json = (await res.json()) as { login: string };
  return json.login;
}

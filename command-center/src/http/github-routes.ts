// REST routes for the GitHub App: registering it from a manifest, signing in as a user, showing
// status, and the per-repo sync switches. See decisions/006-command-center-github-app.md (the
// ADR is the spec) for why this exists and what it must never do -- in particular, every GitHub
// call here is either a read or one of the three OAuth/app-registration exchanges the ADR
// explicitly allows; there is no write call anywhere in this file.
//
// The two callback routes (GET /api/github/app/callback, GET /api/github/callback) are the only
// routes in the whole server that skip bearer auth -- see server.ts. Each accepts only a
// single-use state value (oauthState.ts) that expires after 10 minutes, so an unauthenticated
// request to them can do nothing without first having driven the matching POST route through the
// authenticated dashboard.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { App } from '../app.ts';
import type { Project, Store } from '../core/index.ts';
import { describeGithubAuth, resolveGithubAuth } from '../ingest/github/auth.ts';
import {
  GithubSessionEndedError, clearUserToken, defaultGithubSecretStore, forgetApp, loadApp, loadAppSecrets, saveAppFromConversion, saveUserToken, sessionOf,
} from '../ingest/github/app.ts';
import { fetchInstallationRepos, fetchUserInstallations } from '../ingest/github/installations.ts';
import { parseGithubUrl } from '../ingest/github/mapping.ts';
import {
  buildLoginAuthUrl, buildManifest, exchangeLoginCode, exchangeManifestCode, fetchViewerLogin, generatePkce,
} from '../ingest/github/oauth.ts';
import { OAuthStateStore } from '../ingest/github/oauthState.ts';
import { getRepoSettings, setRepoSettings } from '../ingest/github/repoSettings.ts';
import { setRepoTracked } from '../ingest/github/trackRepo.ts';
import type { SecretStore } from '../ingest/secrets.ts';
import { HttpError, sendJson } from './errors.ts';
import { parseBody } from './schemas.ts';
import type { Router } from './router.ts';
import type { HttpServerOptions } from './types.ts';

const emptyBodySchema = z.object({}).strict();
const repoPatchBodySchema = z.object({
  syncIssues: z.boolean().optional(),
  readChecklists: z.boolean().optional(),
  /** true makes the repo a project (or brings its archived project back); false archives that project. */
  tracked: z.boolean().optional(),
}).strict();

/** The local server's own listening port, read off the socket the request arrived on -- correct
 *  whether the server was started on a fixed port or an OS-assigned ephemeral one. */
function portFromRequest(req: IncomingMessage): number {
  return req.socket.localPort ?? 0;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  if (!res.headersSent) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
  }
  res.end(html);
}

const EXPIRED_LINK_HTML = '<html><body>This link has expired. Start again from the GitHub page in the dashboard.</body></html>';

function errorHtml(message: string): string {
  return `<html><body>${escapeHtml(message)}</body></html>`;
}

function connectedHtml(login: string): string {
  return `<html><body>GitHub connected as ${escapeHtml(login)}. You can close this tab and return to Polaris.</body></html>`;
}

/** Case-insensitive match on the project's own github URL only (no local git-origin lookup: this is a display concern, not the sync's repo mapping). */
function findProjectForRepo(projects: Project[], fullName: string): Project | undefined {
  const lower = fullName.toLowerCase();
  return projects.find((p) => {
    if (!p.github) return false;
    const parsed = parseGithubUrl(p.github);
    return parsed != null && `${parsed.owner}/${parsed.repo}`.toLowerCase() === lower;
  });
}

export function registerGithubRoutes(router: Router, app: App, opts: HttpServerOptions): void {
  const store: Store = app.store;
  const fetchImpl = opts.githubFetchImpl ?? fetch;
  const secrets: SecretStore = opts.githubSecrets ?? defaultGithubSecretStore();
  const stateStore = opts.githubStateStore ?? new OAuthStateStore();

  // -------------------------------------------------------------------- status

  router.add('GET', '/api/github/status', async (ctx) => {
    const status = await describeGithubAuth({ secrets, fetchImpl });
    const appConfig = await loadApp(secrets);
    const signedIn = status.mode === 'app';
    const result: {
      mode: typeof status.mode;
      app: { slug: string; name: string; htmlUrl: string; installUrl: string } | null;
      user: { login: string } | null;
      signedIn: boolean;
      refreshExpiresAt: string | null;
      installations: { id: number; account: { login: string; type: string }; repositorySelection: string; manageUrl: string }[];
      error?: string;
    } = {
      mode: status.mode,
      app: appConfig ? { slug: appConfig.slug, name: appConfig.name, htmlUrl: appConfig.htmlUrl, installUrl: `https://github.com/apps/${appConfig.slug}/installations/new` } : null,
      user: signedIn && status.login ? { login: status.login } : null,
      signedIn,
      refreshExpiresAt: signedIn ? status.refreshExpiresAt ?? null : null,
      installations: [],
    };
    if (signedIn) {
      try {
        const token = await resolveGithubAuth({ secrets, fetchImpl });
        const installations = await fetchUserInstallations(token, fetchImpl);
        result.installations = installations.map((i) => ({
          id: i.id,
          account: { login: i.account.login, type: i.account.type },
          repositorySelection: i.repository_selection,
          manageUrl: i.html_url,
        }));
      } catch (e) {
        result.error = e instanceof Error ? e.message : String(e);
        result.installations = [];
      }
    }
    sendJson(ctx.res, 200, result);
  });

  // ---------------------------------------------------------------- app setup

  router.add('POST', '/api/github/app/manifest', async (ctx) => {
    parseBody(emptyBodySchema, ctx.body);
    if (await loadApp(secrets)) throw new HttpError(409, 'github_app_exists', 'A GitHub App is already configured.');
    const port = portFromRequest(ctx.req);
    const state = stateStore.create('manifest');
    const manifest = buildManifest(port);
    sendJson(ctx.res, 200, {
      action: `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`,
      manifest: JSON.stringify(manifest),
    });
  });

  // Unauthenticated (see server.ts): only a valid, single-use, unexpired state can do anything here.
  router.add('GET', '/api/github/app/callback', async (ctx) => {
    const code = ctx.url.searchParams.get('code');
    const state = ctx.url.searchParams.get('state');
    const consumed = state ? stateStore.consume(state, 'manifest') : undefined;
    if (!code || !consumed) {
      sendHtml(ctx.res, 400, EXPIRED_LINK_HTML);
      return;
    }
    try {
      const conversion = await exchangeManifestCode(code, fetchImpl);
      await saveAppFromConversion(secrets, conversion);
      const installUrl = `https://github.com/apps/${conversion.slug}/installations/new`;
      ctx.res.statusCode = 302;
      ctx.res.setHeader('Location', installUrl);
      ctx.res.end();
    } catch {
      sendHtml(ctx.res, 400, errorHtml('Could not finish connecting the GitHub App. Start again from the GitHub page in the dashboard.'));
    }
  });

  router.add('POST', '/api/github/app/forget', async (ctx) => {
    parseBody(emptyBodySchema, ctx.body);
    await forgetApp(secrets);
    sendJson(ctx.res, 200, { ok: true });
  });

  // --------------------------------------------------------------------- login

  router.add('POST', '/api/github/login', async (ctx) => {
    parseBody(emptyBodySchema, ctx.body);
    const appConfig = await loadApp(secrets);
    if (!appConfig) throw new HttpError(409, 'github_app_missing', 'No GitHub App is configured yet.');
    const { verifier, challenge } = generatePkce();
    const state = stateStore.create('login', verifier);
    const port = portFromRequest(ctx.req);
    const redirectUri = `http://127.0.0.1:${port}/api/github/callback`;
    const url = buildLoginAuthUrl(appConfig.clientId, { redirectUri, state, codeChallenge: challenge });
    sendJson(ctx.res, 200, { url });
  });

  // Unauthenticated (see server.ts): only a valid, single-use, unexpired state can do anything here.
  router.add('GET', '/api/github/callback', async (ctx) => {
    const code = ctx.url.searchParams.get('code');
    const state = ctx.url.searchParams.get('state');
    const consumed = state ? stateStore.consume(state, 'login') : undefined;
    if (!code || !consumed) {
      sendHtml(ctx.res, 400, EXPIRED_LINK_HTML);
      return;
    }
    const appSecrets = await loadAppSecrets(secrets);
    if (!appSecrets) {
      sendHtml(ctx.res, 400, errorHtml('No GitHub App is configured. Start again from the GitHub page in the dashboard.'));
      return;
    }
    try {
      const port = portFromRequest(ctx.req);
      const redirectUri = `http://127.0.0.1:${port}/api/github/callback`;
      const tokenResp = await exchangeLoginCode(appSecrets.clientId, appSecrets.clientSecret, { code, verifier: consumed.codeVerifier ?? '', redirectUri }, fetchImpl);
      if (!tokenResp.access_token) throw new Error(tokenResp.error ?? 'no access_token in response');
      const login = await fetchViewerLogin(tokenResp.access_token, fetchImpl);
      const now = Date.now();
      // The session read before the exchange: a sign-out in the meantime refuses the write.
      await saveUserToken(secrets, {
        accessToken: tokenResp.access_token,
        refreshToken: tokenResp.refresh_token,
        accessExpiresAt: tokenResp.expires_in != null ? new Date(now + tokenResp.expires_in * 1000).toISOString() : null,
        refreshExpiresAt: tokenResp.refresh_token_expires_in != null ? new Date(now + tokenResp.refresh_token_expires_in * 1000).toISOString() : null,
        login,
      }, sessionOf(appSecrets));
      sendHtml(ctx.res, 200, connectedHtml(login));
    } catch (e) {
      if (e instanceof GithubSessionEndedError) {
        sendHtml(ctx.res, 400, errorHtml('You signed out of GitHub while this sign-in was completing, so it was not saved. Sign in again from the GitHub page in the dashboard.'));
        return;
      }
      sendHtml(ctx.res, 400, errorHtml('Could not complete GitHub sign-in. Start again from the GitHub page in the dashboard.'));
    }
  });

  router.add('POST', '/api/github/logout', async (ctx) => {
    parseBody(emptyBodySchema, ctx.body);
    // Signing out ends the session for everything still in flight: a refresh waiting on GitHub
    // (checked when it saves) and a sign-in whose callback has not arrived (its state is gone).
    stateStore.invalidate('login');
    await clearUserToken(secrets);
    sendJson(ctx.res, 200, { ok: true });
  });

  // --------------------------------------------------------------------- repos

  router.add('GET', '/api/github/repos', async (ctx) => {
    const status = await describeGithubAuth({ secrets, fetchImpl });
    if (status.mode !== 'app') throw new HttpError(409, 'github_not_connected', 'Sign in to GitHub from the dashboard first.');
    const token = await resolveGithubAuth({ secrets, fetchImpl });
    const installations = await fetchUserInstallations(token, fetchImpl);
    const projects = store.listProjects();
    const rows: { fullName: string; private: boolean; installationId: number; tracked: boolean; project: { slug: string; name: string } | null; syncIssues: boolean; readChecklists: boolean }[] = [];
    for (const installation of installations) {
      const repos = await fetchInstallationRepos(token, installation.id, fetchImpl);
      for (const repo of repos) {
        const settings = getRepoSettings(store, repo.full_name);
        const project = findProjectForRepo(projects, repo.full_name);
        rows.push({
          fullName: repo.full_name,
          private: repo.private,
          installationId: installation.id,
          // Archived projects are not in `projects`, so a repo whose project was archived reads as not tracked.
          tracked: project != null,
          project: project ? { slug: project.slug, name: project.name } : null,
          syncIssues: settings.syncIssues,
          readChecklists: settings.readChecklists,
        });
      }
    }
    rows.sort((a, b) => a.fullName.localeCompare(b.fullName));
    sendJson(ctx.res, 200, { repos: rows });
  });

  router.add('PATCH', '/api/github/repos/:owner/:repo', (ctx) => {
    const body = parseBody(repoPatchBodySchema, ctx.body);
    const fullName = `${ctx.params.owner}/${ctx.params.repo}`;
    const { tracked, ...switches } = body;
    // The owner's own click, so the project change is recorded as the human actor.
    const changed = tracked === undefined ? undefined : setRepoTracked(store, fullName, tracked, 'human');
    const settings = Object.keys(switches).length ? setRepoSettings(store, fullName, switches) : getRepoSettings(store, fullName);
    const project = changed === undefined ? findProjectForRepo(store.listProjects(), fullName) : changed && !changed.archived ? changed : undefined;
    sendJson(ctx.res, 200, {
      repo: {
        fullName, tracked: project != null, project: project ? { slug: project.slug, name: project.name } : null,
        syncIssues: settings.syncIssues, readChecklists: settings.readChecklists,
      },
    });
  });
}

/** GET routes that must be reachable without a bearer token (see server.ts). POST/PATCH on the same paths still require auth. */
export const GITHUB_UNAUTHENTICATED_GET_PATHS = new Set(['/api/github/app/callback', '/api/github/callback']);

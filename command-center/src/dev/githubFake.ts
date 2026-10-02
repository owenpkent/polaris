// A fake GitHub for the UI tests (initiatives/ui-ux-testing.md, phase 9, option A) and for nothing
// else. `serve` loads this module only when CC_GITHUB_FAKE is exactly "1" (githubFakeFromEnv in
// http/commands.ts); the daemon and the desktop shell never set that, and nothing else imports it.
//
// The fake is a `fetch` that answers, from the fixtures below, the GET endpoints that
// ingest/github/sync.ts, ingest/github/repoFiles.ts, and the GitHub routes read. Any other URL is
// a 404 with a JSON body. Any request that is not a GET is refused with a 405 and recorded in
// `writes`, so a test can prove that no code path tried to write. It never opens a socket.
//
// The sign-in it stores is a fake token that never expires, written with the same functions the
// OAuth callback uses, into the scratch secret store the test server points CC_SECRETS_DIR at. The
// real auth code (ingest/github/auth.ts) runs unchanged on it and never enters its refresh path,
// so the fake needs no answer for the token endpoint (a POST, which it would refuse anyway).
import { resolve } from 'node:path';
import type { App } from '../app.ts';
import { JOBS, runJob } from '../daemon/jobs.ts';
import type { HttpServerOptions, JobStatus } from '../http/types.ts';
import { saveAppFromConversion, saveUserToken } from '../ingest/github/app.ts';
import type { GithubIssue } from '../ingest/github/items.ts';
import type { ManifestConversionResponse } from '../ingest/github/oauth.ts';
import { defaultSecretStore, type SecretStore } from '../ingest/secrets.ts';

// ------------------------------------------------------------------------------------ fixtures

export const FAKE_GITHUB_USER = 'ui-test-user';
export const FAKE_GITHUB_OWNER = 'ui-test';
export const FAKE_GITHUB_INSTALLATION_ID = 4242;

/**
 * One readable repo per Playwright project, so the desktop and phone runs (which share one
 * database) each track their own and never collide, plus one the App lists but cannot read: it
 * answers 404 for the repo and everything under it, like a repo the App is not installed on.
 */
export const FAKE_GITHUB_REPOS = {
  desktop: `${FAKE_GITHUB_OWNER}/readable-desktop`,
  phone: `${FAKE_GITHUB_OWNER}/readable-phone`,
  unreadable: `${FAKE_GITHUB_OWNER}/unreadable`,
} as const;
export const FAKE_READABLE_REPOS: readonly string[] = [FAKE_GITHUB_REPOS.desktop, FAKE_GITHUB_REPOS.phone];

/**
 * The repos the demo seed's projects point at (seed-demo.ts, which the UI test server runs
 * first). The App sees them, and they are readable and empty: no issues, no files. Without them
 * the issue sync would 404 on those projects and fail the `github` job on every run.
 */
export const FAKE_DEMO_REPOS: readonly string[] = ['example/demo-desktop-app', 'example/demo-website'];

/** Everything the installation lists, in the order the routes sort it. */
export const FAKE_LISTED_REPOS: readonly string[] = [...Object.values(FAKE_GITHUB_REPOS), ...FAKE_DEMO_REPOS].sort();

/** The app registration the fake sign-in belongs to. The secret is a fixed string that opens nothing. */
export const FAKE_GITHUB_APP: ManifestConversionResponse = {
  id: 1,
  slug: 'polaris-ui-test',
  name: 'Polaris UI test app',
  html_url: 'https://github.com/apps/polaris-ui-test',
  client_id: 'ui-test-client-id',
  client_secret: 'ui-test-client-secret',
};

const FAKE_ACCESS_TOKEN = 'ui-test-fake-token';

const repoName = (fullName: string): string => fullName.split('/')[1];

/**
 * The two unchecked items in a readable repo's README.md. A checklist is the owner's own file, so
 * repoFiles.ts makes each item an open task of the project (importer/todo.ts), not an inbox item.
 */
export function fakeReadmeItems(fullName: string): string[] {
  return [`Write the release notes for ${repoName(fullName)}`, `Tag the ${repoName(fullName)} release`];
}

/** The one open issue in a readable repo, opened by someone else: the github sync puts it in the inbox once the repo is tracked. */
export function fakeIssueTitle(fullName: string): string {
  return `The ${repoName(fullName)} sidebar overlaps the board`;
}

function readme(fullName: string): string {
  return [`# ${repoName(fullName)}`, '', ...fakeReadmeItems(fullName).map((item) => `- [ ] ${item}`), ''].join('\n');
}

function issue(fullName: string): GithubIssue {
  return {
    number: 1,
    title: fakeIssueTitle(fullName),
    body: 'Seen on a 390px phone. UI test fixture, not a real issue.',
    state: 'open',
    html_url: `https://github.com/${fullName}/issues/1`,
    labels: [],
    assignees: [],
    user: { login: 'someone-else' },
    repository_url: `https://api.github.com/repos/${fullName}`,
  };
}

/** A contents API answer for one file, base64 like GitHub's. */
function fileBody(path: string, text: string): Record<string, unknown> {
  return { type: 'file', encoding: 'base64', name: path.split('/').pop(), path, content: Buffer.from(text, 'utf8').toString('base64') };
}

/** Every GET the fake answers, by pathname. Query strings are ignored: the fixture user has nothing assigned and no open PRs, whichever filter asks. */
function fixtureRoutes(): Map<string, unknown> {
  const routes = new Map<string, unknown>();
  routes.set('/user', { login: FAKE_GITHUB_USER });
  routes.set('/user/installations', {
    installations: [{
      id: FAKE_GITHUB_INSTALLATION_ID,
      account: { login: FAKE_GITHUB_OWNER, type: 'User' },
      repository_selection: 'selected',
      html_url: `https://github.com/settings/installations/${FAKE_GITHUB_INSTALLATION_ID}`,
    }],
  });
  routes.set(`/user/installations/${FAKE_GITHUB_INSTALLATION_ID}/repositories`, {
    repositories: FAKE_LISTED_REPOS.map((fullName) => ({ full_name: fullName, private: false })),
  });
  for (const fullName of FAKE_DEMO_REPOS) {
    routes.set(`/repos/${fullName}`, { full_name: fullName, private: false, default_branch: 'main' });
    routes.set(`/repos/${fullName}/issues`, []);
  }
  routes.set('/issues', []);
  routes.set('/search/issues', { items: [] });
  for (const fullName of FAKE_READABLE_REPOS) {
    const base = `/repos/${fullName}`;
    routes.set(base, { full_name: fullName, private: false, default_branch: 'main' });
    routes.set(`${base}/issues`, [issue(fullName)]);
    routes.set(`${base}/issues/1`, issue(fullName));
    routes.set(`${base}/contents/README.md`, fileBody('README.md', readme(fullName)));
    routes.set(`${base}/contents/CLAUDE.md`, fileBody('CLAUDE.md', `# ${repoName(fullName)}\n\nNo checklist here.\n`));
    routes.set(`${base}/contents/docs`, [{ name: 'plan.md', path: 'docs/plan.md', type: 'file' }]);
    routes.set(`${base}/contents/docs/plan.md`, fileBody('docs/plan.md', '# Plan\n\nProse only.\n'));
    // TODO.md is absent on purpose: a 404, which repoFiles.ts reads as an empty file.
  }
  return routes;
}

// ---------------------------------------------------------------------------------- the fetch

export interface GithubFake {
  fetch: typeof fetch;
  /** Every request, as "METHOD /path?query", in order. */
  calls: string[];
  /** The requests that were not GETs. Each was refused with a 405. Empty in a correct run. */
  writes: string[];
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function createGithubFake(): GithubFake {
  const routes = fixtureRoutes();
  const calls: string[] = [];
  const writes: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const line = `${method} ${url.pathname}${url.search}`;
    calls.push(line);
    if (method !== 'GET') {
      writes.push(line);
      return jsonResponse(405, { message: 'The fake GitHub only reads.' });
    }
    const body = routes.get(url.pathname);
    return body === undefined ? jsonResponse(404, { message: 'Not Found' }) : jsonResponse(200, body);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls, writes };
}

// ------------------------------------------------------------------------------------- sign-in

/** Stores the fake app and a signed-in fixture user, the way the OAuth callback in github-routes.ts does. */
export async function signInGithubFake(secrets: SecretStore): Promise<void> {
  await saveAppFromConversion(secrets, FAKE_GITHUB_APP);
  // No refresh token and no expiry: auth.ts reads this as a fresh token that never expires.
  await saveUserToken(secrets, { accessToken: FAKE_ACCESS_TOKEN, accessExpiresAt: null, refreshExpiresAt: null, login: FAKE_GITHUB_USER });
}

// -------------------------------------------------------------------------------------- wiring

export interface GithubFakeWiring {
  fake: GithubFake;
  /** The app with the fake fetch in place of the real one, for the sync jobs. */
  app: App;
  /** What `serve` adds to its server options: the fake behind the GitHub routes, and the two sync jobs the dashboard starts with POST /api/sync/:job. */
  http: Pick<HttpServerOptions, 'githubFetchImpl' | 'githubSecrets' | 'jobs' | 'getJobStatus'>;
}

const FAKE_JOB_NAMES = ['github', 'repo-files'];

/**
 * Builds the fake, signs the fixture user in, and returns what `serve` needs. Refuses to run
 * against the real secret store or the real database: both must be scratch, as in e2e/global-setup.js.
 */
export async function startGithubFake(app: App, env: NodeJS.ProcessEnv = process.env): Promise<GithubFakeWiring> {
  if (!env.CC_SECRETS_DIR) {
    throw new Error('CC_GITHUB_FAKE=1 needs CC_SECRETS_DIR set to a scratch folder: the fake sign-in is never written to the real secret store.');
  }
  const realDb = resolve(app.config.repoRoot, 'command-center', 'data', 'constellation.db');
  if (!env.CC_DB || resolve(app.config.dbPath) === realDb) {
    throw new Error('CC_GITHUB_FAKE=1 needs CC_DB set to a scratch database: the fake never syncs into the real one.');
  }
  const fake = createGithubFake();
  await signInGithubFake(app.secrets ?? defaultSecretStore());
  const wired: App = { ...app, githubFetch: fake.fetch };
  const jobs = JOBS.filter((j) => FAKE_JOB_NAMES.includes(j.name));
  const running = new Set<string>();
  const kv = (key: string): string | null => wired.store.getKv<string | null>(key) ?? null;
  return {
    fake,
    app: wired,
    http: {
      githubFetchImpl: fake.fetch,
      githubSecrets: app.secrets,
      jobs: Object.fromEntries(jobs.map((job) => [job.name, async () => {
        running.add(job.name);
        try {
          const outcome = await runJob(wired, job);
          if (!outcome.ok) throw new Error(outcome.message);
        } finally {
          running.delete(job.name);
        }
      }])),
      getJobStatus: (): Record<string, JobStatus> => Object.fromEntries(jobs.map((j) => [j.name, {
        lastRunAt: kv(`sync.${j.name}.lastAt`),
        lastError: kv(`sync.${j.name}.lastError`),
        running: running.has(j.name),
      }])),
    },
  };
}

// CLI entry point for the local HTTP server, plus startHttp() for a future daemon process to
// reuse without going through the CLI.
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import type { App } from '../app.ts';
import type { Command } from '../cli-types.ts';
import { parseFlags } from '../cli-types.ts';
import type { Config } from '../config.ts';
import type { GithubFakeWiring } from '../dev/githubFake.ts';
import { createHttpServer } from './server.ts';
import { tailscaleLoginFromEnv } from './tailscale.ts';
import { resolveTokens } from './token.ts';
import type { HttpServerOptions } from './types.ts';

export { tailscaleLoginFromEnv };

/** The startup line that says identity is on, shared by `serve` and the daemon so the logs agree. */
export function tailscaleIdentityLine(login: string): string {
  return `Dashboard sign-in through Tailscale for ${login}: a request from tailscale serve on this machine carrying that login needs no api token on /api. MCP still needs its tokens.`;
}

const DEFAULT_CORS_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Hosting is settled: the server stays on loopback and is reached over the tailnet through
 * `tailscale serve`. Both `serve` and `daemon` bind a listener, so both warn from here rather
 * than each keeping its own copy of the rule.
 */
export function warnIfNotLoopback(host: string, stderr: (line: string) => void): void {
  if (LOOPBACK_HOSTS.has(host)) return;
  stderr(`Warning: '${host}' is not a loopback address. Exposing this server beyond localhost needs the `
    + 'OAuth work described in decisions/003-command-center-hosting.md (ADR-003) before it is safe -- '
    + 'a bearer token alone is not sufficient for a public network.');
}

export function corsOriginsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.CC_CORS_ORIGINS;
  if (!raw) return DEFAULT_CORS_ORIGINS;
  const parsed = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return parsed.length ? parsed : DEFAULT_CORS_ORIGINS;
}

export interface StartHttpOptions extends HttpServerOptions {
  port: number;
  host: string;
}

export interface RunningHttp {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

/**
 * `config.dashboardDir` when it holds a built `index.html`, otherwise undefined -- so `/` stays a
 * 404 instead of the server trying (and failing) to serve a directory that was never built.
 */
export function resolveDashboardDir(config: Config, stderr: (line: string) => void): string | undefined {
  if (existsSync(join(config.dashboardDir, 'index.html'))) return config.dashboardDir;
  stderr(`Dashboard: ${config.dashboardDir}/index.html not found; run 'npm run build' at the repo root to serve the dashboard from this server.`);
  return undefined;
}

/**
 * The UI test server's fake GitHub (src/dev/githubFake.ts), and the one place that reads
 * CC_GITHUB_FAKE. Only `serve` calls this; the daemon and the desktop shell never set the flag.
 * Anything but exactly "1" leaves the module unloaded, so the server keeps the real fetch, has no
 * sync jobs, and holds whatever sign-in the secret store holds. With "1" the fake refuses to start
 * unless CC_SECRETS_DIR and CC_DB point at scratch locations.
 */
export async function githubFakeFromEnv(app: App, env: NodeJS.ProcessEnv = process.env): Promise<GithubFakeWiring | undefined> {
  if (env.CC_GITHUB_FAKE !== '1') return undefined;
  const { startGithubFake } = await import('../dev/githubFake.ts');
  return startGithubFake(app, env);
}

/** Starts listening and resolves once bound. Used by the `serve` command and, later, a daemon. */
export async function startHttp(app: App, opts: StartHttpOptions): Promise<RunningHttp> {
  const server = createHttpServer(app, opts);
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  const hostForUrl = opts.host.includes(':') && !opts.host.startsWith('[') ? `[${opts.host}]` : opts.host;
  return {
    server,
    url: `http://${hostForUrl}:${port}`,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

const serveCommand: Command = {
  name: 'serve',
  summary: 'Run the local HTTP server: REST API, MCP over Streamable HTTP, and the GitHub webhook receiver.',
  usage: 'serve [--port 8788] [--host 127.0.0.1] [--readonly-mcp] [--show-token]',
  async run(args, { openApp, stdout, stderr }) {
    const flags = parseFlags(args);
    const port = Number(flags.port ?? 8788);
    const host = typeof flags.host === 'string' ? flags.host : '127.0.0.1';
    warnIfNotLoopback(host, stderr);

    const app = openApp();
    const tokens = resolveTokens(app.config.dbPath);
    const readonlyMcp = Boolean(flags['readonly-mcp']);
    const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
    const dashboardDir = resolveDashboardDir(app.config, stderr);
    const tailscaleLogin = tailscaleLoginFromEnv();

    try {
      // Test-only: undefined unless CC_GITHUB_FAKE is exactly "1" (see githubFakeFromEnv).
      const fake = await githubFakeFromEnv(app);
      const { url, close } = await startHttp(fake?.app ?? app, {
        tokens, port, host, readonlyMcp, webhookSecret, dashboardDir, tailscaleLogin, corsOrigins: corsOriginsFromEnv(), ...fake?.http,
      });
      stdout(`Command Center HTTP server listening at ${url}`);
      if (tailscaleLogin) stdout(tailscaleIdentityLine(tailscaleLogin));
      if (fake) stdout('GitHub is the fake in src/dev/githubFake.ts (CC_GITHUB_FAKE=1): a fixture sign-in, and no request leaves this process.');
      if (dashboardDir) stdout(`  dashboard: ${url}/`);
      stdout(`MCP endpoint: ${url}/mcp${readonlyMcp ? ' (readonly)' : ''}`);
      stdout(`  claude mcp add --transport http polaris ${url}/mcp --header "Authorization: Bearer <mcp-token>"`);
      stdout(`  claude mcp add --transport http polaris-readonly ${url}/mcp/readonly --header "Authorization: Bearer <mcp-readonly-token>"`);
      if (flags['show-token']) {
        stdout(`API token (REST /api, dashboard):        ${tokens.api}`);
        stdout(`MCP token (full /mcp, agent):             ${tokens.mcp}`);
        stdout(`MCP readonly token (/mcp/readonly only):  ${tokens.mcpReadonly}`);
      }
      if (!webhookSecret) stdout('GitHub webhook receiver disabled (set GITHUB_WEBHOOK_SECRET to enable).');

      await new Promise<void>((resolveShutdown) => {
        let shuttingDown = false;
        const shutdown = () => {
          if (shuttingDown) return;
          shuttingDown = true;
          stdout('Shutting down...');
          void close().then(() => { app.close(); resolveShutdown(); });
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      });
      return 0;
    } catch (e) {
      stderr(e instanceof Error ? e.message : String(e));
      app.close();
      return 1;
    }
  },
};

export const commands: Command[] = [serveCommand];

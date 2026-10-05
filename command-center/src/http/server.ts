// Local HTTP server: REST API, MCP over Streamable HTTP, and the GitHub webhook receiver, all on
// one node:http server (no express, no other new deps). /api, /mcp, and /mcp/readonly each need
// their own bearer token (see ApiTokens in types.ts) so that holding one never grants access to
// another; the webhook route authenticates itself via HMAC instead. See src/http/README.md for
// the endpoint table.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { App } from '../app.ts';
import { createWebhookHandler } from '../ingest/github/webhook.ts';
import { readJsonBody } from './body.ts';
import { errorToPayload, sendError, sendNoContent } from './errors.ts';
import { GITHUB_UNAUTHENTICATED_GET_PATHS } from './github-routes.ts';
import { IDENTITY_PATH } from './identity.ts';
import { createMcpHandler, type McpRequestHandler } from './mcp.ts';
import { registerRestRoutes } from './rest.ts';
import { createRouter } from './router.ts';
import { createStaticHandler } from './static.ts';
import { isTailscaleOwner } from './tailscale.ts';
import type { HttpServerOptions } from './types.ts';

export type { ApiTokens, HttpServerOptions, JobStatus } from './types.ts';

const MAX_BODY_BYTES = 1024 * 1024;
const CORS_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS';
const CORS_HEADERS = 'Authorization, Content-Type';

function isAuthorized(req: IncomingMessage, tokenBuf: Buffer): boolean {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice('Bearer '.length), 'utf8');
  if (provided.length !== tokenBuf.length) return false;
  return timingSafeEqual(provided, tokenBuf);
}

/** Sets CORS headers when Origin is in the allow-list. Returns whether it was allowed. */
function applyCors(req: IncomingMessage, res: ServerResponse, allowedOrigins: string[]): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !allowedOrigins.includes(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
  res.setHeader('Access-Control-Allow-Methods', CORS_METHODS);
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

/**
 * The request target as a URL, or undefined when it cannot be one. An origin-form target (the
 * normal case, and all a proxy like tailscale serve forwards) stays a path even when it starts
 * with two slashes, which the WHATWG parser would otherwise read as an authority.
 */
function parseRequestTarget(target: string | undefined): URL | undefined {
  const raw = target ?? '/';
  try {
    return raw.startsWith('/') ? new URL(`http://localhost${raw}`) : new URL(raw, 'http://localhost');
  } catch {
    return undefined;
  }
}

/** Logs one line per request to stderr: method, path, status, duration. Never bodies or tokens. */
function logLine(method: string, pathname: string, status: number, startedAt: number): void {
  process.stderr.write(`${new Date().toISOString()} ${method} ${pathname} ${status} ${Date.now() - startedAt}ms\n`);
}

export function createHttpServer(app: App, opts: HttpServerOptions): Server {
  const router = createRouter();
  registerRestRoutes(router, app, opts);

  const mcpHandler = createMcpHandler(app, { readonly: false });
  const mcpReadonlyHandler = createMcpHandler(app, { readonly: true });
  const webhookHandler = opts.webhookSecret ? createWebhookHandler(app, { secret: opts.webhookSecret }) : undefined;
  const staticHandler = opts.dashboardDir ? createStaticHandler(opts.dashboardDir) : undefined;
  const apiTokenBuf = Buffer.from(opts.tokens.api, 'utf8');
  const mcpTokenBuf = Buffer.from(opts.tokens.mcp, 'utf8');
  const mcpReadonlyTokenBuf = Buffer.from(opts.tokens.mcpReadonly, 'utf8');

  return createServer((req, res) => {
    const start = Date.now();
    const method = (req.method ?? 'GET').toUpperCase();
    // Nothing served here may be framed: an embedded dashboard would read its saved token and
    // act on clicks the user never saw. Set before anything else so every answer carries the
    // headers, JSON errors and 304s included, and the service worker stores them with the shell.
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");

    // The request target is attacker-controlled and arrives before any token check. Parsing it
    // outside the error boundary let one malformed target (`GET //[/`) throw out of the listener
    // and take the whole daemon down. A bad target is a 400 like any other bad input.
    const reqUrl = parseRequestTarget(req.url);
    const pathname = reqUrl ? reqUrl.pathname : '(malformed)';

    res.on('finish', () => logLine(method, pathname, res.statusCode, start));

    void handle();

    async function handle(): Promise<void> {
      try {
        if (!reqUrl) { sendError(res, 400, 'BadRequest', 'malformed request target'); return; }
        const originAllowed = applyCors(req, res, opts.corsOrigins);

        if (method === 'OPTIONS') {
          if (!originAllowed) { sendError(res, 403, 'CorsError', 'origin not allowed'); return; }
          sendNoContent(res, 204);
          return;
        }

        if (pathname === '/webhooks/github') {
          if (!webhookHandler) { sendError(res, 404, 'NotFound', 'not found'); return; }
          if (method !== 'POST') { sendError(res, 405, 'MethodNotAllowed', 'method not allowed'); return; }
          webhookHandler(req, res);
          return;
        }

        // /mcp/readonly is checked before /mcp so the more specific path never falls through to
        // the /mcp branch's token (each route accepts only its own token; see ApiTokens).
        if (pathname === '/mcp/readonly') {
          if (!isAuthorized(req, mcpReadonlyTokenBuf)) { sendError(res, 401, 'Unauthorized', 'missing or invalid bearer token'); return; }
          const parsedBody = method === 'POST' ? await readJsonBody(req, MAX_BODY_BYTES) : undefined;
          await mcpReadonlyHandler(req, res, parsedBody);
          return;
        }

        if (pathname === '/mcp') {
          if (!isAuthorized(req, mcpTokenBuf)) { sendError(res, 401, 'Unauthorized', 'missing or invalid bearer token'); return; }
          const handler: McpRequestHandler = opts.readonlyMcp ? mcpReadonlyHandler : mcpHandler;
          const parsedBody = method === 'POST' ? await readJsonBody(req, MAX_BODY_BYTES) : undefined;
          await handler(req, res, parsedBody);
          return;
        }

        if (pathname === '/api' || pathname.startsWith('/api/')) {
          // The GitHub App's two OAuth callback routes are the only unauthenticated ones on this
          // server (see ADR-006 and github-routes.ts): GitHub redirects the user's browser to
          // them directly, so they cannot carry a bearer token. Each accepts only a valid,
          // single-use, unexpired state value in its place. GET only -- POST on the same paths
          // still requires the API token.
          // The identity check (identity.ts) is the fourth: it proves this server holds the api
          // token to a client that must not send that token first, and reveals nothing else.
          const isGithubCallback = method === 'GET' && GITHUB_UNAUTHENTICATED_GET_PATHS.has(pathname);
          const isIdentity = method === 'GET' && pathname === IDENTITY_PATH;
          // The owner's Tailscale sign-in, arriving through `tailscale serve` on this machine, stands
          // in for the api token here and nowhere else (tailscale.ts). Off until CC_TAILSCALE_LOGIN
          // names the login; the MCP branches above never look at the header.
          const isOwnerOverTailscale = isTailscaleOwner(req, opts.tailscaleLogin);
          if (!isGithubCallback && !isIdentity && !isOwnerOverTailscale && !isAuthorized(req, apiTokenBuf)) { sendError(res, 401, 'Unauthorized', 'missing or invalid bearer token'); return; }
          const body = method === 'POST' || method === 'PATCH' || method === 'PUT'
            ? await readJsonBody(req, MAX_BODY_BYTES)
            : undefined;
          const found = router.find(method, pathname);
          if (found.kind === 'not_found') { sendError(res, 404, 'NotFound', 'not found'); return; }
          if (found.kind === 'method_not_allowed') {
            res.setHeader('Allow', found.methods.join(', '));
            sendError(res, 405, 'MethodNotAllowed', 'method not allowed');
            return;
          }
          await found.handler({ req, res, url: reqUrl, body, app, params: found.params });
          return;
        }

        if (staticHandler && await staticHandler(req, res, pathname)) return;

        sendError(res, 404, 'NotFound', 'not found');
      } catch (e) {
        if (res.headersSent) { res.end(); return; }
        const { status, code, message } = errorToPayload(e);
        sendError(res, status, code, message);
      }
    }
  });
}

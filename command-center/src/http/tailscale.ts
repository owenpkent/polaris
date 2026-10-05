// Tailscale identity for the dashboard: the owner's own Tailscale sign-in standing in for the api
// token on /api/*, for a dashboard opened through `tailscale serve` on a phone or a second
// computer. docs/tailscale-identity.md is the plan and the trust statement.
//
// `tailscale serve` runs on this machine, connects to the daemon from loopback, and adds
// `Tailscale-User-Login` (the user's email as Tailscale knows it) to every request it forwards
// from a user-owned device. It deletes any such header the client sent first, and sets none for a
// tagged device or a Funnel request (tailscale/tailscale, ipn/ipnlocal/serve.go). So a request
// that arrives from loopback with the configured login in that header came through the proxy
// from one of the owner's devices, or from a process on this machine that chose to say so; the
// second is the same trust the token files next to the database already extend, which is why
// this is off until the owner names a login with CC_TAILSCALE_LOGIN.
//
// The header is only ever an alternative to the api token on /api/*. It opens neither MCP
// endpoint: agents keep their tokens. isAuthorized in server.ts stays the only token check.
import type { IncomingMessage } from 'node:http';

export const TAILSCALE_LOGIN_HEADER = 'tailscale-user-login';

/** The TCP peers `tailscale serve` can be: loopback, in either address family, or IPv4-mapped. */
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** A login as compared: trimmed and lower-cased. Tailscale logins are email addresses. */
export function normalizeTailscaleLogin(raw: string | undefined): string | undefined {
  const login = raw?.trim().toLowerCase();
  return login ? login : undefined;
}

/** CC_TAILSCALE_LOGIN, or undefined when unset or blank, which leaves identity off. */
export function tailscaleLoginFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return normalizeTailscaleLogin(env.CC_TAILSCALE_LOGIN);
}

/**
 * Whether `req` is the owner arriving through `tailscale serve`: a login is configured, the peer is
 * loopback (the proxy is on this machine; a daemon bound wider than loopback must not take the
 * header from a LAN peer), and the one `Tailscale-User-Login` header names that login.
 */
export function isTailscaleOwner(req: Pick<IncomingMessage, 'headers' | 'socket'>, login: string | undefined): boolean {
  const expected = normalizeTailscaleLogin(login);
  if (!expected) return false;
  const peer = req.socket?.remoteAddress;
  if (!peer || !LOOPBACK_PEERS.has(peer)) return false;
  const header = req.headers[TAILSCALE_LOGIN_HEADER];
  // node joins repeated headers with ", " for this name; a repeated login header is not one login.
  if (typeof header !== 'string' || header.includes(',')) return false;
  return normalizeTailscaleLogin(header) === expected;
}

/**
 * Whether `req` was sent by a page on this server's own origin, as the browser reports it.
 * server.ts requires it of every request other than GET or HEAD that is authorized by identity
 * alone.
 *
 * The identity header proves which device a request came from, not which page sent it. The
 * browser holds no credential here (the proxy adds the header), so any website open in a browser
 * on the owner's device could send a "simple" cross-site POST, which needs no preflight, to the
 * tailnet address, and the proxy would stamp it with the owner's login. A bearer token is safe
 * from that because a page from another site cannot read it. Identity is not, so a write over
 * identity must also show it came from the dashboard's own origin.
 *
 * Sec-Fetch-Site, which current browsers send on HTTPS and a page cannot set, is checked first and
 * must be `same-origin`. Without it, the Origin header must name this server's own host (the Host
 * header, which `tailscale serve` forwards as the client sent it by default). With neither, or with
 * an Origin that does not parse, the request is refused.
 */
export function isSameOriginBrowserRequest(req: Pick<IncomingMessage, 'headers'>): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined) return site === 'same-origin';
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host.toLowerCase();
  } catch {
    return false;
  }
}

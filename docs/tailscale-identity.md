# Tailscale identity for the dashboard

Status: plan, 2026-10-04. Built on branch feat/tailscale-identity, as described here.

Polaris is reached from a phone or a second computer through `tailscale serve` on the host, which gives the daemon a private HTTPS address and forwards to 127.0.0.1:8788. Today every one of those devices still has to be given the api token: it is pasted into the connect form once, and then sits in that browser's localStorage. This document describes letting the owner's own Tailscale sign-in stand in for the token on those devices, what that trusts, and what it leaves alone.

## Where things stand

- The server binds to loopback and trusts three bearer tokens, one per route group: api for `/api/*`, mcp for `/mcp`, mcp-readonly for `/mcp/readonly` (command-center/src/http/server.ts, types.ts). Each route accepts only its own token. That separation is what keeps an agent with an MCP token away from the REST route that enables a rule, and invariants.test.ts group 3 states it.
- Four routes take no token: the GitHub webhook (HMAC), the two GitHub sign-in callbacks (single-use state), and `GET /api/identity` (an HMAC challenge for the desktop shell).
- The dashboard keeps `{ baseUrl, token }` in localStorage (src/command-center/ConnectionContext.jsx). A production build defaults the server URL to the page's own origin, so a dashboard opened through `tailscale serve` already knows where the server is and only lacks the token.
- `tailscale serve` adds three headers to every request it forwards from a user-owned device: `Tailscale-User-Login`, `Tailscale-User-Name`, and `Tailscale-User-Profile-Pic`. It deletes any such headers the client sent first, sets none for a tagged device, and sets none for a Funnel (public) request (tailscale/tailscale, ipn/ipnlocal/serve.go, `addTailscaleIdentityHeaders`). The login is the user's email as Tailscale knows it, Q-encoded only when it holds non-ASCII characters.

## Alternatives

- **Keep the token, make it easier to hand over.** A QR code or a one-time link from the Settings page, carrying the `#cc-url=...&cc-token=...` handoff the desktop shell and the UI tests already use. Buys: no new trust. Costs: the token still lives in every browser, a lost phone still means rotating it everywhere, and the handoff has to be made on the host, where the token is.
- **Tailscale identity (chosen).** The daemon accepts a request on `/api/*` as the owner when it arrives from the proxy on the same machine carrying the owner's login. Buys: nothing to paste, nothing stored on the device, a lost phone is removed from the tailnet and that is the whole revocation. Costs: a second way into the REST API, described under "What this trusts" below.
- **An OAuth or OIDC login.** The right answer for a public address, and the "when to ask" list in CLAUDE.md puts it off until the owner wants one. Far more than a tailnet needs.

## Design

### Server

- One new setting, `CC_TAILSCALE_LOGIN`, the Tailscale login (email) allowed in. Unset means off, which is the default. Read by `serve` and by the daemon through `tailscaleLoginFromEnv()` in http/commands.ts, and carried as `HttpServerOptions.tailscaleLogin`.
- A new module, http/tailscale.ts, with one predicate: `isTailscaleOwner(req, login)` is true only when all of these hold.
  - A login is configured.
  - The TCP peer is loopback (127.0.0.1, ::1, or the IPv4-mapped form). `tailscale serve` runs on the host and connects from loopback. This closes the case of a daemon started with `--host 0.0.0.0` despite the warning, where a LAN peer could send the header itself.
  - The request carries exactly one `Tailscale-User-Login` header, and it equals the configured login, compared case-insensitively after trimming.
- server.ts applies the predicate to `/api` and `/api/*` only: a request there is authorized by the api token as before, or by the predicate. `/mcp`, `/mcp/readonly`, and the webhook do not look at the header. The GitHub callbacks and `/api/identity` keep their own rules.
- A write authorized by identity alone (any method but GET and HEAD, with no valid api token) must also be a same-origin browser request, or it is a 403: `Sec-Fetch-Site` must be `same-origin` when present, and otherwise `Origin` must name the request's own `Host` (`isSameOriginBrowserRequest` in http/tailscale.ts). The reason: the header proves which device a request came from, not which page sent it. The browser holds no credential of its own here, so without this check any website open in a browser on the owner's device could send a simple cross-site POST, which needs no CORS preflight, through `tailscale serve` and be taken for the owner. A token is not exposed this way because another site cannot read it. Reads are left alone, since another site cannot read the answer, and the token path is unchanged.
- The JSON body reader compares the media type exactly (`application/json`, parameters ignored). A substring match had let `text/plain;x=application/json` through, which is also a no-preflight simple request.
- `GET /api/health` gains `auth: { via: 'tailscale', login } | { via: 'token' }`, so the dashboard can say how it got in. It is derived from the same predicate, so it never reveals the configured login to a request that did not already present it.
- Startup prints one line when the setting is on, naming the login, so a daemon log shows whether identity is live.

### Dashboard

- On first load with nothing saved, when the page's origin is not loopback (that is, when it was opened through the tailnet and not on the host itself), ConnectionContext tries the connection test against the page's own origin with an empty token, silently. A 200 means identity is on: the connection is saved with no token, and every tab works as if the token had been pasted. A 401 means identity is off: the device stays in local mode and the connect form appears as today, with no error shown for a test the owner never ran.
- The Settings form shows "Connected through Tailscale as <login>. No token is stored on this device." when health says so. The token field stays, so a token can still be pasted where identity is off.
- The `#cc-url=...&cc-token=...` handoff, the Vite dev server, and a saved connection are unchanged: the probe runs only when there is nothing saved and no handoff.

### What does not change

- Every token keeps working everywhere it works today. Turning identity on removes no path.
- MCP stays token-only. An agent connecting over HTTP MCP from a tailnet device still configures the mcp token, and the read-only endpoint still takes only the read-only token.
- The desktop shell, the CLI, the GitHub sign-in, backups, and the offline copy are untouched.

## What this trusts

- **The proxy on the same machine.** Anything that can open a TCP connection to 127.0.0.1:8788 on the host can send the header itself. On the owner's own single-user machine that is the same trust the token files already extend (they sit next to the database), with one difference: the token files are mode 0600, while the loopback port is open to every local account. Turn identity on only where the host is yours alone. The port being reachable only from loopback is also what Tailscale's own guidance assumes before trusting these headers.
- **Every device on the tailnet as the owner.** The header says which Tailscale user owns the device, not which program sent the request. With identity on, any process on one of the owner's devices can reach the REST API through the tailnet address without a token, and the REST API is where a rule is enabled and an inbox item accepted. The token separation is unchanged (an MCP token is still refused by `/api`), but identity is a second door into `/api` that needs no api token at all. An agent that should stay fenced on the owner's laptop is fenced by its MCP token today only because it has no api token; with identity on, it is fenced by nothing but the fact that it was not told the tailnet address. If that matters, leave `CC_TAILSCALE_LOGIN` unset and keep pasting the token.
- **The browser, for writes.** A write over identity is accepted only when the browser says it came from the dashboard's own origin (`Sec-Fetch-Site: same-origin`, or an `Origin` equal to the `Host`). This assumes `tailscale serve` forwards the client's original `Host`, which is its default. A program that is not a browser can send either header itself; that is the "every device on the tailnet as the owner" trust above, not a new one.
- **Tailscale's identity.** A compromised Tailscale account, or a device left signed in, is the owner. Device removal in the Tailscale admin console is the revocation.
- **Not Funnel.** A Funnel request carries no identity header and gets a 401 like any other tokenless request, but the server was never meant to face the public internet. Do not Funnel it.

A later hardening, not built here: ask tailscaled over its local API (`tailscale whois`) who holds the `X-Forwarded-For` address and require the answer to match the header. That guards against a misconfigured proxy adding the header, not against a process on the host, which can forge both headers at once.

## Tests

- http/tailscale.test.ts: the predicate with fake requests. Off with no login. Off when the peer is not loopback. Off with the header missing, repeated, or naming another login. On for the configured login in any letter case. `tailscaleLoginFromEnv` trims and treats an empty value as unset. `isSameOriginBrowserRequest`: `Sec-Fetch-Site: same-origin` passes, every other value fails; without it an `Origin` naming the `Host` passes, another host or a malformed `Origin` fails; neither header fails.
- http/server.test.ts, writes: with the header and a foreign `Origin`, `POST /api/github/app/forget` and `POST /api/tasks/:id/complete` are 403 and change nothing; with `Sec-Fetch-Site: same-origin` or an `Origin` equal to the server they go through; a JSON body sent as `text/plain;x=application/json` creates nothing; a bearer token with a foreign `Origin` is unaffected; a read with a foreign `Origin` still works.
- http/body.test.ts: the media type must be exactly `application/json`.
- http/server.test.ts: with `tailscaleLogin` set, a tokenless `GET /api/health` carrying the header is 200 and reports `auth.via: 'tailscale'`; without the header, or with another login, it is 401; the same header on `/mcp` and `/mcp/readonly` is 401; with `tailscaleLogin` unset, the header opens nothing. A request that carries both a bad token and a good header is still authorized, since the header is an alternative, not an extra check.
- invariants.test.ts, group 10: Tailscale identity is off unless a login is named, opens only `/api`, and only from loopback, and a write over it from another origin, or from no stated origin, is refused.
- ConnectionContext.test.jsx: at a tailnet origin with nothing saved, a 200 from the probe connects with an empty token and persists; a 401 leaves the device local with no error shown; at a loopback origin nothing is fetched.
- SettingsForm.test.jsx: the Tailscale note appears when health says so and not otherwise.

## Docs

- command-center/src/http/README.md: the setting in the environment table and a paragraph under Auth.
- command-center/README.md: the setting in the environment table, and the "Phone and laptop" line.
- SECURITY.md: a bullet in the security model.
- CLAUDE.md: one line under "How the pieces work", so the constraints (REST only, loopback peer only, off by default, never an MCP path) are in front of whoever touches it next.

## Turning it on

1. Make sure `tailscale serve` already fronts the daemon: `tailscale serve status` should list `/` proxying to `http://127.0.0.1:8788`.
2. Give the daemon `CC_TAILSCALE_LOGIN=<your Tailscale login>` in its environment (a systemd drop-in on Linux, the task's environment on Windows) and restart it. The startup log says "Dashboard sign-in through Tailscale for <login>".
3. On the phone or laptop, open `https://<machine>.<tailnet>.ts.net/`. The dashboard connects on its own. Settings says it is connected through Tailscale.
4. A device that already had the token pasted keeps using it until Disconnect; the next load connects through identity.

## Out of scope

- Identity for MCP. Agents keep their tokens.
- WireGuard. A plain WireGuard tunnel adds no identity headers; devices behind it keep pasting the token.
- The whois cross-check described above.

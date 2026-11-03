# The Android app signs in through Tailscale, with no token on the phone

Status: built 2026-11-03 (feat/app-identity), as described here. Scoped as the alternative to a "Connect a phone" QR code: nothing here hands out the api token, because the phone stops needing one.

## Where things stand

The phone reaches the daemon through `tailscale serve` on GR9, so every request it sends already arrives from loopback carrying `Tailscale-User-Login` with the owner's login. With `CC_TAILSCALE_LOGIN` set, the daemon already accepts that as the owner on `/api/*` (docs/tailscale-identity.md, http/tailscale.ts). A browser on a second computer gets in this way today with nothing stored.

The Android app still needs the token pasted in, for two incidental reasons:

1. The dashboard only probes for identity from its own page origin (`tailnetOrigin` in src/command-center/ConnectionContext.jsx). Inside the app the page is `https://localhost`, a loopback hostname, so the probe is skipped, and the connect form treats the token as required.
2. A write authorized by identity alone must look same-origin (`isSameOriginBrowserRequest`, applied in http/server.ts). The app's requests are cross-origin by construction: the WebView sends `Sec-Fetch-Site: cross-site` and `Origin: https://localhost`, so every POST, PATCH, and DELETE would be a 403.

Everything else already works without a token: api.js omits the `Authorization` header when the token is empty, `testConnection` persists an empty token, the Settings page already shows "Connected through Tailscale as ... No token is stored on this device" when `/api/health` reports `auth.via: 'tailscale'`, and the OPTIONS preflight for `https://localhost` is answered before any auth check.

## The change

### Server: an identity write may come from an origin the owner listed

A write over identity alone is accepted when either holds:

- it is same-origin, exactly as today (`Sec-Fetch-Site: same-origin`, or without that header an `Origin` naming the request's `Host`), or
- its `Origin` header is one of the origins the owner set in `CC_CORS_ORIGINS`, whatever `Sec-Fetch-Site` says.

Only an explicitly configured list counts. The built-in default (`http://localhost:5173` and `http://127.0.0.1:5173`, the Vite dev server) is there so development works without configuration and does not become a write origin over identity; `corsOriginsFromEnv` keeps returning it for CORS, and a separate value, the explicit list or nothing, feeds the identity check. The owner already sets `CC_CORS_ORIGINS=https://localhost` for the app (mobile/README.md), so no new setting is needed.

Shape: `isSameOriginBrowserRequest(req)` stays as it is. A new predicate next to it, `isListedOriginBrowserRequest(req, origins)`, is true when `Origin` is exactly one of `origins` (string equality, as `applyCors` does). server.ts refuses the write only when both are false. `HttpServerOptions` gains `identityWriteOrigins: string[]`, which the daemon and `serve` fill from the explicit `CC_CORS_ORIGINS` value and the test server leaves empty.

Nothing else on the server moves. `isTailscaleOwner` is unchanged: still loopback peer only, still exactly one header naming the configured login. `/mcp` and `/mcp/readonly` still never look at the header. The read path is unchanged.

### Dashboard: the token is optional on the connect form

- The Access token field on the connect form (src/command-center/SettingsForm.jsx) stops being required. Its help text says the token is needed only when the server is not set up to accept the owner's Tailscale sign-in.
- Connect with an empty token runs the existing `testConnection(url, '')`. A 200 connects this device with nothing stored, and the existing Tailscale note appears. A 401 shows "This server needs a token: paste the one printed by serve --show-token" instead of the generic refusal. (A browser on a tailnet page keeps its silent probe on load; this only adds the same path to the form, which is the only way in from the app.)
- A saved connection with an empty token is already re-checked on load through `testConnection(baseUrl, '', { keepOnNetworkError: true })`, so nothing changes there.
- The outbox replay (`flushOutbox(base, token)`) and every other write go through the same client, so they pass once the server accepts the app's origin.

Share intake, reminders, the offline copy, and the handoff fragment (`cc-token`) are untouched. The app bundle does not change; this is a dashboard change the app picks up with the next `cap sync`.

### Docs

- docs/tailscale-identity.md: under "What this trusts", the browser-for-writes paragraph gains the listed-origin clause and says why `https://localhost` is the app and nothing else on a phone.
- mobile/README.md: first launch is "type the server URL and connect"; the token is only for a server without `CC_TAILSCALE_LOGIN`. The backup note changes from "server URL and token" to "server URL, and the token if one was used".
- CLAUDE.md, the Tailscale bullet: a write over identity comes from the dashboard's own origin or from an origin the owner listed in `CC_CORS_ORIGINS`; the "never widen" sentence stays and gains "or to an origin the owner did not list".

## What this trusts, and what changes

The existing trust is unchanged: a device on the tailnet signed in as the owner, reaching the daemon through `tailscale serve` on the host, is the owner. A program on such a device could already send any header it likes; that was accepted in the original design and is not new.

The one widening: a page actually served at an origin in `CC_CORS_ORIGINS`, open in a browser on such a device, can write as the owner. With the list set to `https://localhost`:

- On the phone, `https://localhost` is the Capacitor app and nothing else; Android has no other server at that origin.
- On a desktop on the tailnet, a page at `https://localhost` (port 443, with a certificate the browser trusts) would have to be something the owner runs themselves. A malicious third-party site cannot set its `Origin` to that value; the browser writes the header.
- A page at any other origin, including `https://evil.example` and the Vite dev origins, is refused as today.

Not widened: no non-loopback peer, no login the owner did not name, nothing on `/mcp`. No route returns, prints, or encodes the token. No QR code.

## Tests

- http/tailscale.test.ts: `isListedOriginBrowserRequest` passes a listed origin with `Sec-Fetch-Site: cross-site` and with no `Sec-Fetch-Site`, fails an unlisted origin, a missing `Origin`, a prefix or case variant, and an empty list.
- http/server.test.ts (the existing identity write test): with `identityWriteOrigins: ['https://localhost']`, a POST stamped as the owner with `Origin: https://localhost` and `Sec-Fetch-Site: cross-site` is 200 and the task changes; `https://evil.example` is still 403; with the option empty, `https://localhost` is 403; `http://localhost:5173` is 403 unless listed. The MCP branches with the header are still 401.
- commands.test.ts: the explicit list is parsed for the identity option; unset and blank yield an empty list, not the CORS default.
- invariants.test.ts group 10: a new test, "a cross-site write over identity is accepted only from an origin the owner listed", covering the three cases above (listed 200, unlisted 403, defaults do not count).
- src/command-center/SettingsForm.test.jsx: Connect with an empty token calls `saveSettings(url, '')`; a 401 shows the needs-a-token message; the form submits without a token.
- Android instrumented tests (mobile/scripts/test.mjs): unchanged. The scratch daemon is reached over `adb reverse`, not `tailscale serve`, so the token path is what it can exercise; the identity path is covered on the server side above.
- No visual change beyond the help text, so `npm run shots` runs once for the Settings page and its baseline is accepted if only that text moved.

## Rollout on GR9

1. Confirm `CC_TAILSCALE_LOGIN` and `CC_CORS_ORIGINS=https://localhost` are both set for the daemon. Both are expected to be already.
2. Deploy the release as usual (`cc update`).
3. On the phone: Settings, Disconnect (which clears the stored token), type the server URL, Connect with the token field empty. The Settings page should read "Connected through Tailscale as ... No token is stored on this device."
4. A phone that keeps its token keeps working; the token path is unchanged.

## Out of scope

- Any route, command, or code that returns the api token (the QR code options).
- Tailscale Funnel: it strips the identity headers, and the daemon is never made public.
- The `tailscale whois` cross-check from docs/tailscale-identity.md, still not built.
- Pointing the Capacitor WebView at the server's own origin instead of bundling dist/, which would make the app same-origin with no server change but changes the app model in CLAUDE.md.

## Size

One pull request: about thirty lines in http/tailscale.ts, server.ts, commands.ts, and types.ts; about twenty in SettingsForm.jsx; the tests and docs above.

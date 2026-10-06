# Command Center HTTP server

A single `node:http` server exposing three things on one port: the REST API the dashboard reads
and writes, the MCP server over Streamable HTTP, and the GitHub webhook receiver. No build step,
no express, no new dependencies beyond what the package already has (`@modelcontextprotocol/sdk`,
`zod`).

Everything here binds to `127.0.0.1` by default and trusts three independent bearer tokens, one
per route group (see [Auth](#auth)). The server is meant to stay on loopback: other devices
reach it through a reverse proxy on a private network you control, which needs no change here.
claude.ai is the one client that still cannot reach it, because that needs a public HTTPS endpoint
plus OAuth on the MCP routes, and it is deferred until the owner asks for it.

## Running it

```
npm run cc -- serve
npm run cc -- serve --port 8788 --host 127.0.0.1 --readonly-mcp --show-token
```

| Flag | Default | Notes |
|---|---|---|
| `--port` | `8788` | |
| `--host` | `127.0.0.1` | Leave it on loopback. A reverse proxy on your private network can forward to it, so remote devices need no other binding. A non-loopback host prints a warning, because exposing the server directly needs OAuth work that has not been done. |
| `--readonly-mcp` | off | Also serves the readonly tool set at `/mcp` (in addition to the always-readonly `/mcp/readonly`). Authentication for `/mcp` is unaffected: it still needs the mcp token, not the mcp-readonly token. |
| `--show-token` | off | Prints all three tokens, labeled, once at startup. They are otherwise never logged. |

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `CC_API_TOKEN` | (generated) | Bearer token for `/api/*`. If unset, a 32-byte random base64url token is created at `<dirname(dbPath)>/api-token` on first run and reused after that. |
| `CC_MCP_TOKEN` | (generated) | Bearer token for the full `/mcp` (read + write tools). Generated at `<dirname(dbPath)>/mcp-token` if unset. |
| `CC_MCP_READONLY_TOKEN` | (generated) | Bearer token for `/mcp/readonly` only. Generated at `<dirname(dbPath)>/mcp-readonly-token` if unset. |
| `CC_CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated list of origins allowed to receive CORS headers (including preflight). The Android app (mobile/) runs the dashboard at `https://localhost`, so a server it connects to needs that origin here. |
| `CC_TAILSCALE_LOGIN` | (unset) | Your Tailscale login (email). When set, a request on `/api/*` that arrives from `tailscale serve` on this machine carrying that login in `Tailscale-User-Login` is the owner without the api token. Never applies to `/mcp` or `/mcp/readonly`. See [Tailscale identity](#tailscale-identity). |
| `CC_DASHBOARD_DIR` | `<repo root>/dist` | Built dashboard directory served at `/` (see [Dashboard](#dashboard)). |
| `GITHUB_WEBHOOK_SECRET` | (unset) | Enables `POST /webhooks/github`. Without it the route is 404. |

Shut down with Ctrl+C (SIGINT) or SIGTERM; the store is closed cleanly before exit.

## Auth

There are three independent bearer tokens, one per trust boundary, each compared with a
constant-time check (`resolveTokens(dbPath, env)` in `token.ts`, returning `{ api, mcp,
mcpReadonly }`; `HttpServerOptions.tokens` carries them into `createHttpServer`):

| Token | Guards | Actor for mutations |
|---|---|---|
| api | `/api/*` | `human` |
| mcp | `/mcp` (read + write tools, or read-only if `--readonly-mcp`) | `agent` |
| mcpReadonly | `/mcp/readonly` (read tools only; write tools are not even registered) | n/a (read-only) |

Each route accepts **only** its own token: the api token does not work on `/mcp` or
`/mcp/readonly`, the mcp token does not work on `/api` or `/mcp/readonly`, and the mcp-readonly
token does not work on `/api` or `/mcp`. This is what stops an agent holding only the MCP token
from reaching `/api/rules/:id` to flip `enabled: true` on itself (that mutation is REST-only and
logged as actor `human`, so it must never be reachable with an MCP token). Missing or wrong token
for a route is `401`. Four routes check no bearer token: the webhook route verifies the GitHub
`X-Hub-Signature-256` HMAC instead; the two GitHub sign-in callbacks (`GET
/api/github/app/callback` and `GET /api/github/callback`), which GitHub redirects the browser to,
accept only a valid single-use `state` value in its place; and `GET /api/identity` answers a
challenge with an HMAC keyed with the api token, so a client that has the token can tell this
server from anything else on the port before sending the token to it (the desktop shell does
this; see `identity.ts`). The proof gives nothing away, and the route takes nothing but the
challenge.

### Tailscale identity

With `CC_TAILSCALE_LOGIN` set, `/api/*` takes one more credential besides the api token: the
owner's own Tailscale sign-in, as `tailscale serve` reports it (`tailscale.ts`,
docs/tailscale-identity.md). The proxy runs on this machine, connects from loopback, adds
`Tailscale-User-Login` to every request it forwards from a user-owned device, deletes any such
header the client sent, and sets none for a tagged device or a Funnel request. So a request is the
owner when a login is configured, the TCP peer is loopback, and the one `Tailscale-User-Login`
header equals that login (case-insensitively). `GET /api/health` then reports `auth: { via:
"tailscale", login }` instead of `{ via: "token" }`, which is how the dashboard knows it needs no
token. The header is only ever an alternative to the api token: every token keeps working, and
`/mcp` and `/mcp/readonly` never look at the header, so agents keep their tokens. Off by default.
What it trusts: any process that can reach the loopback port can send the header itself, which is
the same trust the token files next to the database extend on a single-user machine; and every
process on one of the owner's tailnet devices is the owner on `/api`, which is where a rule is
enabled. Leave it unset if either matters.

A write over identity (any method but GET and HEAD, without a valid api token) must also be a
same-origin browser request, or it is a `403`: `Sec-Fetch-Site` must be `same-origin` when the
browser sends it, and otherwise `Origin` must name the request's own `Host`
(`isSameOriginBrowserRequest`). The header proves the device, not the page, so without this any
website open in the owner's browser could send a simple cross-site POST, which needs no preflight,
through the proxy as the owner. Reads and the token path are unaffected. For the same reason
`body.ts` takes a body only when the media type is exactly `application/json`, so
`text/plain;x=application/json` is refused.

Every response carries `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors
'none'`, set in `server.ts` before anything else runs, so the dashboard cannot be embedded by a
page on another origin and clicked through with its saved token. A request target that is not a
URL is a `400`; one starting with two slashes is a path here, never another host.

CORS headers (`Access-Control-Allow-Origin`, `-Methods`, `-Headers`) are only ever added for an
`Origin` in the configured allow-list; a disallowed preflight (`OPTIONS`) gets `403`. This is a
browser-side control, not an access control -- a non-browser client without a matching Origin
still reaches the API as long as its bearer token is valid.

Request bodies are capped at 1 MB and must be `application/json` (or absent, for routes that don't
need one); oversized bodies are rejected as soon as the cap is crossed, without being buffered.
Errors are always `{ "error": { "code": string, "message": string } }`, with no stack traces.

One line is logged to stderr per request (method, path, status, duration) -- never request bodies
or the token.

## REST endpoints

All request/response bodies are JSON, camelCase, matching the shapes in `src/core/types.ts`
(`Task`, `Project`, `Section`, `Comment`, `Rule`, ...).

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | `{ ok, version, today, counts: { inbox, overdue, today } }` |
| GET | `/api/settings/agent` | `{ defaultAgentName }`: the stored kv value, or `'claude-code'` if none is set yet. |
| PATCH | `/api/settings/agent` | Body: `{ defaultAgentName }`, validated by `normalizeAgentName` (1 to 40 characters of letters, digits, spaces, `-`, `_`, `.`, starting with a letter or digit). `400` on an invalid name. `{ defaultAgentName }`. Used by the dashboard's "Assign to AI" button. |
| GET | `/api/identity` | No bearer token. Query `challenge` (32 to 128 lowercase hex characters). `{ proof }`: HMAC-SHA256 hex over `constellation-identity\n<port>\n<challenge>` keyed with the api token, `port` being the one the request arrived on. `400` for any other challenge. |
| GET | `/api/projects` | `?includeArchived=1` also lists archived projects. `{ projects: (Project & counts)[] }` |
| POST | `/api/projects` | Body: `{ name, type?, status?, description?, github?, category? }`. The slug comes from the name and must be new. `github` is `owner/repo` or a github.com URL and is stored as `https://github.com/owner/repo`; a project needs no repo. 201 with `{ project }`. |
| PATCH | `/api/projects/:ref` | Any of the POST fields, plus `archived`. `null` clears an optional field. The slug never changes. There is no DELETE: archive instead, so tasks keep their project. `path`, `todoFile`, and `meta` belong to the importers and are refused. |
| GET | `/api/projects/:ref` | `:ref` is id, slug, or name. `{ project, sections, tasks }` (non-dropped, position order) |
| GET | `/api/tasks` | Query: `text, status, project, section, priority, dueBefore, dueAfter, sourceType, blocked, assignee, unassigned, orderBy, limit, offset`. `assignee` is an exact match and `unassigned=true` keeps only tasks with none. `{ tasks, total }` |
| GET | `/api/tasks/:id` | `{ task, subtasks, blockers, blocking, comments, links, history }` |
| POST | `/api/tasks` | Body: `NewTask` fields plus `project` (ref), `section` (name, created if missing), `blockedBy: string[]`. The dashboard also sends `id`, `opId`, and `deviceId`: the identity the same create would carry through `/api/outbox`, so a create whose answer was lost is not made again by the replay. `201 { task }` |
| POST | `/api/tasks/import` | Bulk import from pasted text or CSV. Body: `{ text, format?: auto|csv|lines, project?, dryRun? }`. Dry run `200 { dryRun, format, rows, count, errors, ignoredColumns }`; success `201 { format, created, count, ignoredColumns }`; any row error `400 { error, errors: [{ line, message }] }` and nothing is created. Live-only |
| PATCH | `/api/tasks/:id` | Body: `TaskPatch` fields (status included). `{ task }` |
| POST | `/api/tasks/:id/complete` | `{ task, next }` |
| POST | `/api/tasks/:id/reopen` | `{ task }` |
| POST | `/api/tasks/:id/move` | Body: `{ project?, section?, parentId?, position? }`. `{ task }` |
| POST | `/api/tasks/:id/comments` | Body: `{ body, opId?, deviceId? }`, the op identity as for a create. `201 { comment }` |
| POST | `/api/outbox` | Offline edits from a dashboard. Body: `{ deviceId, ops: [{ opId, kind, taskId, at, base, body }] }`, where `kind` is one of `create_task`, `update_task`, `complete_task`, `reopen_task`, `move_task`, `add_comment`. `{ results: [{ opId, taskId, title, status, conflicts, error }], headId }`, with `status` one of `applied`, `conflict`, `duplicate`, `rejected`. Safe to retry: an `opId` is applied once. See core/outbox.ts for the merge |
| POST | `/api/tasks/:id/dependencies` | Body: `{ blockerId }`. `201 {}` |
| DELETE | `/api/tasks/:id/dependencies/:blockerId` | `204` |
| GET | `/api/inbox` | `{ tasks }`, status `inbox`, newest first |
| POST | `/api/inbox/:id/accept` | Body: `{ project?, section?, dueAt?, priority?, title? }`. `{ task }` |
| POST | `/api/inbox/:id/reject` | Body: `{ reason? }`. `{ task }` |
| GET | `/api/views` | `{ views: { name, description, builtin }[] }` |
| GET | `/api/views/:name` | `{ view, tasks }`. Built-in names are listed under Views in the command-center README. The `blocked` view also returns `blockers`, each task's incomplete blockers keyed by task id |
| GET | `/api/rules` | `{ rules }` |
| POST | `/api/rules` | Body: `{ name, definition, enabled? }`. `201 { rule }`. A human may enable a rule at creation (unlike the `create_rule` MCP tool, which always saves disabled). |
| PATCH | `/api/rules/:id` | Body: `{ enabled?, name?, definition? }`. `{ rule }` |
| DELETE | `/api/rules/:id` | `204` |
| POST | `/api/rules/run` | Body: `{ ruleId?, dryRun? }` (`dryRun` defaults `true`). Returns a `RuleRunReport` directly. |
| GET | `/api/digest` | Returns a `Digest` directly (`buildDigest` for `app.today()`). |
| GET | `/api/goals` | `?includeClosed=1` also lists achieved and dropped goals. Returns `{ goals: GoalDetail[], total, vision }`; `total` counts closed goals too. |
| POST | `/api/goals` | Body: `{ title, notes?, parentId?, periodLabel?, startsOn?, endsOn?, status?, statusNote?, progressMode?, currentValue?, targetValue?, unit? }`. 201 with the goal payload below. |
| GET | `/api/goals/:id` | Returns `{ goal: GoalDetail, linkedProjects, linkedTasks, openTasks }`. `openTasks` are the active tasks that can move the goal. |
| PATCH | `/api/goals/:id` | Any of the POST fields. `null` clears an optional field. Status is never computed; it changes only here or through `update_goal`. |
| DELETE | `/api/goals/:id` | 204. Sub-goals are kept and become top-level goals. |
| POST | `/api/goals/:id/links` | Body: exactly one of `{ project }` (id or slug) or `{ taskId }`. Idempotent. 201 with the goal payload. |
| POST | `/api/goals/:id/unlink` | Same body as `links`. A POST because a DELETE body is not reliably delivered. |
| PATCH | `/api/goal-vision` | Body: `{ text }` (4000 characters at most). The free-text vision statement shown above the goals. |
| GET | `/api/threads` | `?status=open|closed` filters. `{ threads: { thread, taskTitle, untrustedText, postCount, openClaims, objections, unansweredObjections, results, acceptedResults, lastProgressAt }[] }`, newest first. `untrustedText` is the task's flag: the thread title defaults to the task title, so both are third-party text when it is set. `unansweredObjections` are objections no later post answers by `parentPostId` or `refs`; `lastProgressAt` is the owner's last verdict, or the thread's creation when there is none. |
| GET | `/api/tasks/:id/thread` | The task's thread and its posts: `{ thread, posts, total, pinned }`. With no query, `posts` is the newest `limit` posts (default 500), oldest first, and `total` says how many the thread holds, so a client can tell when the window is short. Query `after` (a post id) returns only the posts added after it, in insertion order. `pinned` is the post the owner pinned, fetched by id so it is present even when it falls outside the window, or null. `404` when the task has no thread. |
| POST | `/api/tasks/:id/thread` | Body: `{ title? }`, defaulting to the task title. `201 { thread }`, or `200` with the existing thread: one per task. |
| GET | `/api/threads/:id` | `{ thread, posts, total, pinned }`, same query and window as above. |
| POST | `/api/threads/:id/posts` | Body: `{ type, body, confidence?, refs?, parentPostId? }` with `type` one of `claim`, `evidence`, `objection`, `question`, `failed_attempt`, `summary`, `result`. Recorded as the human. `201 { post }`. No op identity and no outbox kind: a post is a live write, and the dashboard disables the form offline. A claim or result starts with `status: open`; only the owner changes it, below. |
| PATCH | `/api/threads/:id` | Body: any of `{ pinnedPostId (a post of this thread, or null), authorHidden, dailyCap (positive integer, or null) }`. `{ thread }`. Hidden authors read as "participant" over MCP; the cap is per agent name per UTC day and never applies to the owner. |
| POST | `/api/threads/:id/close` | `{ thread }`. A closed thread takes no posts. `400` if already closed. |
| POST | `/api/threads/:id/reopen` | `{ thread }`. A successor set by a fork stays recorded. |
| POST | `/api/threads/:id/fork` | Body: `{ title }`. Creates a subtask of the thread's task with a thread of its own, closes this thread with `successorThreadId` pointing at it. `201 { thread, successor, task }`. `400` on a closed thread. |
| PATCH | `/api/posts/:id` | Body: `{ status }`, one of `open`, `accepted`, `rejected`, `superseded`. Claims and results only. Sets `judgedAt`. `{ post }`. |
| GET | `/api/posts` | Query: `type`, `status`, `q` (body text), `taskId`, `limit` (default 50, max 500). `{ posts: { post, taskId, taskTitle, threadTitle, untrustedText }[] }`, newest first: the library across threads. `untrustedText` is the task's flag, as on `/api/threads`. |
| GET | `/api/events` | Query: `after` (event id, default 0), `limit`. `{ events, lastId, headId }` -- poll with `after=<lastId>` to resume; `lastId` never regresses. `headId` is the newest event id overall, for clients that only need change detection. |
| GET | `/api/github/status` | `{ mode: 'app' \| 'none', app, user, signedIn, refreshExpiresAt, installations, error? }` |
| POST | `/api/github/app/manifest` | Body `{}`. `{ action, manifest }` for the dashboard to POST to github.com. `409 github_app_exists`. |
| GET | `/api/github/app/callback` | No bearer token. Needs a valid single-use `state`; exchanges the manifest code, then redirects to the app's install page. `400` HTML page otherwise. |
| POST | `/api/github/login` | Body `{}`. `{ url }` to GitHub's authorize page with PKCE. `409 github_app_missing`. |
| GET | `/api/github/callback` | No bearer token. Needs a valid single-use `state`; saves the user token and shows a "GitHub connected" page. `400` HTML page otherwise. |
| POST | `/api/github/logout` | `{ ok: true }`. Keeps the app. |
| POST | `/api/github/app/forget` | `{ ok: true }`. Clears the app and sign-in. |
| GET | `/api/github/repos` | `{ repos: { fullName, private, installationId, tracked, project, syncIssues, readChecklists }[] }`. `409 github_not_connected`. |
| PATCH | `/api/github/repos/:owner/:repo` | Body `{ tracked?, syncIssues?, readChecklists? }`. `tracked: true` makes the repo a project (or brings its archived project back); `false` archives it. `{ repo: { fullName, tracked, project, syncIssues, readChecklists } }` |
| GET | `/api/backup` | Backup status for the Backups card: `{ encryption, folder, keep, copies, plainCopies, newest, job, minPassphraseLength }`. `job` is null under `serve`, which runs no jobs. |
| POST | `/api/backup/encryption` | Body `{ passphrase, replace? }`. Turns backup encryption on by storing the passphrase in the secret store; `409` when it is already on and `replace` is not true. Returns the status. The passphrase is never returned or logged. |
| DELETE | `/api/backup/encryption` | Turns backup encryption off. Copies already encrypted still need their passphrase. Returns the status. |
| POST | `/api/backup/check` | The restore drill on the newest copy, with the stored passphrase: `{ checked: true, ok, name, encrypted, problems, counts?, schemaVersion? }`, or `{ checked: false, message }` when there is no copy yet. |
| GET | `/api/sync` | `{ jobs: getJobStatus() ?? {}, warnings }` |
| POST | `/api/sync/:job` | Starts `opts.jobs[job]()` in the background. `202 { started: true }`. `404` for an unknown job, `409` if `getJobStatus()` already reports it running. |

`opts.jobs` / `opts.getJobStatus` are not wired up by the `serve` CLI command -- under `serve`
alone, `GET /api/sync` reports `{}` and any `POST /api/sync/:job` is `404`. The daemon
(`src/daemon/daemon.ts`, `npm run cc -- daemon`) does pass them into `startHttp`, so both routes
work when the daemon is running.

## MCP over Streamable HTTP

`POST` / `GET` / `DELETE` on `/mcp` and `/mcp/readonly`, each gated by its own token as above.
Each request gets a brand-new `McpServer` + `StreamableHTTPServerTransport` in **stateless mode**
(`sessionIdGenerator: undefined`), closed when the response ends -- no session state is kept
between requests. `/mcp/readonly` always serves the readonly tool set (no mutating tools
registered at all); `/mcp` serves the full read/write set unless `opts.readonlyMcp` is set, in
which case it serves readonly too (still under the mcp token).

An `X-Agent-Name` header lets the connection declare a name for itself (the stdio server has the
equivalent `--agent-name <name>` or `--agent-name=<name>` flag), recorded beside actor `agent` on every write it makes --
`core/agentName.ts`'s `normalizeAgentName` accepts or rejects it, and an invalid value is just
ignored (recorded as no name), never a `400`. The name is self-declared and is never an identity
or a permission: it never changes which actor a write is recorded under.

To add it to Claude Code:

```
claude mcp add --transport http polaris http://127.0.0.1:8788/mcp --header "Authorization: Bearer <mcp-token>"
claude mcp add --transport http polaris-readonly http://127.0.0.1:8788/mcp/readonly --header "Authorization: Bearer <mcp-readonly-token>"
```

(the tokens are the `api-token`, `mcp-token`, and `mcp-readonly-token` files next to the
database, `command-center/data/` by default; `npm run cc -- serve --show-token` also prints
them, but only when the daemon is not already holding the port).

## Dashboard

`GET /` (and any other path that is not `/api`, `/mcp`, `/mcp/readonly`, or `/webhooks/github`)
serves the built React dashboard from `CC_DASHBOARD_DIR` (default `<repo root>/dist`, the output
of `npm run build` run at the repo root) so the dashboard and the API share one origin. This is a
fall-through handled directly in `server.ts`, not a router route -- `router.ts` has no wildcard
support. Until `npm run build` has produced `dist/index.html`, `/` is a `404` like any other
unknown path. A production build defaults its API base URL to the page's own origin, so a
dashboard opened through this server, on the machine that runs it or through your private network, needs only the api token.

Files under `/assets/` (Vite's content-hashed output) get `Cache-Control: public, max-age=31536000,
immutable`; everything else, including `index.html`, gets `no-cache` and a weak `ETag` so the
browser can revalidate with `If-None-Match` and get a `304`.

The app shell needs no bearer token, unlike everything else on this server: a plain browser
navigation (typing the URL, opening a bookmark) cannot attach an `Authorization` header, so the
shell itself must be reachable without one. Every `/api` call it then makes from the browser still
needs the api token as usual. Same-origin serving also means no CORS entry is needed for the
dashboard once it is served this way; the `CC_CORS_ORIGINS` allow-list stays only for the Vite dev
server on a different port.

## GitHub webhook

`POST /webhooks/github` delegates to `createWebhookHandler` from `src/ingest/github/webhook.ts`
when `GITHUB_WEBHOOK_SECRET` (or `opts.webhookSecret`) is set. It authenticates via the
`X-Hub-Signature-256` HMAC header, not a bearer token, and returns `404` when no secret is
configured at all.

## Files

- `server.ts` -- `createHttpServer(app, opts)`: routing, per-route auth, CORS, body limits, logging.
- `router.ts` -- tiny `:param` path router.
- `static.ts` -- `createStaticHandler(root)`: serves the built dashboard at `/` (see [Dashboard](#dashboard)).
- `rest.ts` -- REST route handlers, other than GitHub (registers `github-routes.ts` at the end).
- `github-routes.ts` -- GitHub App setup, sign-in, status, and the per-repo routes (`/api/github/*`).
- `backup-routes.ts` -- backup status, encryption on and off, and the restore drill (`/api/backup*`).
- `warnings.ts` -- the `warnings` on `GET /api/sync`: a failing job or a stale backup, shown as a banner by the dashboard.
- `schemas.ts` -- zod request-body schemas.
- `mcp.ts` -- mounts `createMcpServer` on Streamable HTTP in stateless mode.
- `body.ts`, `errors.ts` -- body reading (1 MB cap, JSON only) and the `{ error: { code, message } }` envelope.
- `types.ts` -- `ApiTokens` (`{ api, mcp, mcpReadonly }`) and `HttpServerOptions` (`tokens: ApiTokens`, ...).
- `token.ts` -- `resolveTokens(dbPath, env)`: `CC_API_TOKEN` / `CC_MCP_TOKEN` / `CC_MCP_READONLY_TOKEN`, or three persisted generated tokens.
- `tailscale.ts` -- `isTailscaleOwner(req, login)` and `tailscaleLoginFromEnv(env)`: the owner's Tailscale sign-in through `tailscale serve` as an alternative to the api token on `/api/*` (see [Tailscale identity](#tailscale-identity)).
- `commands.ts` -- the `serve` CLI command, and `startHttp(app, opts)`, also used by the daemon (`src/daemon/daemon.ts`).
- `test-support.ts` -- shared test helpers (not a test file itself), including `TEST_TOKENS`.

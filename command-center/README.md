# Polaris Command Center

A single-user, agent-operated task graph. It holds the tasks you create yourself and pulls work from your repos and GitHub into one SQLite database, and exposes it to Claude over MCP and to the dashboard over a local REST API.

Design and phases: [initiatives/agentic-command-center.md](../initiatives/agentic-command-center.md). Decisions: [ADR-003 hosting](../decisions/003-command-center-hosting.md), [ADR-004 task model](../decisions/004-command-center-task-model.md).

## Requirements

- Node 24 or newer. There is no build step: Node runs the TypeScript directly.
- `npm install` in this folder.
- The read-only GitHub App (see GitHub setup) for GitHub ingestion. It is the only GitHub credential the Command Center uses.

## Quick start (PowerShell, from this folder)

```powershell
npm install
npm run cc -- import          # initiatives/*.md under the repo root, if that folder exists
npm run cc -- export          # regenerate PROJECT_STATUS.md (--check says whether the file is current)
npm run cc -- sync            # every source once: import, github, repo-files, rules
npm run cc -- inbox           # what ingestion proposes
npm run cc -- ls              # active tasks by due date
npm run cc -- digest          # the daily digest
npm run cc -- daemon          # keep everything running, plus the HTTP API on 127.0.0.1:8788
```

The same commands work from the repo root as `npm run cc -- <command>`.

Run `npm run cc` with no arguments for the full command list, and `npm run cc -- <command> --help` for options.

## Using it from Claude

- **Claude Code in this repo:** the repo root `.mcp.json` registers the stdio server. Approve it when Claude Code asks.
- **Claude Code elsewhere:** `claude mcp add polaris -- node <ABS_PATH_TO_REPO>\command-center\src\mcp\stdio.ts`
- **Over HTTP** while the daemon or `serve` is running: `claude mcp add --transport http polaris http://127.0.0.1:8788/mcp --header "Authorization: Bearer <token>"`, using the token in `command-center/data/mcp-token`. For read-only access use `/mcp/readonly` with `data/mcp-readonly-token`.
- **Phone and laptop:** keep the server on loopback and reach it behind a reverse proxy on a private network you control, such as Tailscale (`tailscale serve`). Never expose it publicly: the MCP routes have no OAuth. With `CC_TAILSCALE_LOGIN` set to your Tailscale login, a dashboard opened through `tailscale serve` signs in with your Tailscale identity and needs no token pasted; MCP clients still need theirs. docs/tailscale-identity.md says what that trusts.
- **claude.ai:** not yet. It needs a public HTTPS endpoint with OAuth, deferred until you ask for it.

Details: [src/mcp/README.md](src/mcp/README.md) and [src/http/README.md](src/http/README.md).

## Views

A view is a named task query, run for today's date. The built-in ones (src/automation/views.ts) are what the `get_view` MCP tool, `GET /api/views/:name`, the digest, and the My tasks filters read. Saved views are stored filters with a name of your own.

| Name | What it lists |
|------|---------------|
| today | Active tasks (open, in progress, or waiting) due today or earlier |
| upcoming | Active tasks due in the next 7 days |
| later | Active tasks with no due date, or due more than 7 days out |
| overdue | Active tasks due before today |
| waiting | Tasks marked waiting, or blocked by an incomplete dependency |
| ready | What could be started right now: open tasks (not inbox, waiting, or in progress) with no incomplete blocker, not a subtask of a done or dropped parent, and with no start date later than today. Priority first, then due date |
| blocked | Open or in-progress tasks held by at least one incomplete blocker. The answer lists each task's blockers, so a reader can see why |
| inbox | Unreviewed items awaiting triage |
| milestones | Active milestones, soonest due first |
| recently-completed | Tasks completed in the last 7 days |

On My tasks, the Filter menu's Ready and Blocked choices are these two views applied to the list; a blocked task's panel shows the blockers under Blocked by.

## Dashboard

Start the daemon (or `npm run cc -- serve`), then run `npm run dev` at the repo root. Once `dist/` exists (`npm run build` at the repo root), the same built dashboard is also served directly at http://127.0.0.1:8788/, on the API's own origin. The dashboard opens on My tasks; use the menu button (top left) for Inbox and Board, and open More for Goals, Projects, Rules, Digest, and GitHub. Until you connect, any Command Center page shows a connect form: when the dashboard was opened from the server itself (http://127.0.0.1:8788/ on the machine that runs it, or its private-network address), the server URL is already filled in with the page's own origin and only the token from data/api-token is needed; from the Vite dev server the URL defaults to http://127.0.0.1:8788. Append `?view=inbox` (or board, goals, projects, rules, digest, github, settings) to the dashboard URL to open it on that view instead.

To try the dashboard without touching your real database, run `npm run mockup` from the repo root. It builds a scratch database in the temp folder (`%TEMP%\constellation-mockup`) from the real importer and `sync repo-files` (skipped if GitHub is unreachable), plus demo tasks and inbox items (src/dev/seed-demo.ts, which refuses to run without a scratch `CC_DB`), starts `serve` and Vite, and opens the dashboard already connected. `--fresh` rebuilds the scratch database and `--port` changes the API port. The script passes the token in the URL fragment, which the dashboard reads once and clears from the address bar.

My tasks:

- **Columns.** Drag the edge of a column header to resize it, or use the header menu (Wider, Narrower, Reset width) so resizing never needs a drag. Double-click an edge to reset. The header menu also sorts by that column and hides it; Columns in the toolbar shows hidden columns again. Widths and hidden columns are saved in the browser.
- **Toolbar.** Filter by readiness (Ready: what could be started now; Blocked: held by an unfinished task), project, goal, priority, source, and assignee (Unassigned, or any name the list holds); sort by due date, priority, project, or name; group by due date, project, priority, or none. Choices are saved in the browser.
- **Inline edits.** Click a row's Due date, Project, or Priority to change it from a dropdown without opening the task panel. Changing the project clears the task's section.

Projects:

- **Made by hand.** New project asks for a name and, if you want, a type, a status, a GitHub repo, and a description in markdown. A project needs no repo, so it can hold work that has nothing to do with GitHub.
- **Archive, not delete.** Archiving hides a project and keeps its tasks. Show archived brings it back into the list, where it can be unarchived.
- **Tracked from GitHub.** Switching on Track as project for a repo on the dashboard's GitHub page creates its project; switching it off archives the project and keeps its tasks, and switching it back on brings the same project back. Every field, including name and GitHub repo, can be edited here.

Goals:

- **What a goal is.** A title, an optional period (one click for this quarter, this year, or next year), a status you set by hand (on track, at risk, off track, achieved, dropped) with a short note, and optional sub-goals.
- **Progress.** Either counted from linked work or typed in as a number out of a target. Counted work is the tasks linked to the goal plus the milestone tasks of linked projects; inbox and dropped tasks never count, and a parent goal includes its sub-goals' work. Status is never computed from progress.
- **Needs attention.** A goal is flagged when nothing open can move it (no active task linked, and none in a linked project) or when its status has not been updated in 14 days. The daily digest lists the same flags.
- **Linking.** Open a goal's details to link a project from a dropdown or a task by typing part of its name. Linking never changes the project or the task.
- **One-time import.** The old Goals tab kept its data in one browser. While the server has no goals, the new tab offers to import what that browser holds.

Task panel:

- **Assignee.** Who a task is handed to, as a plain name (initiatives/teammates-and-goals.md, Teammates Step 1). Empty means unclaimed, which today means the owner. Type a name and leave the field to save it; the clear button beside it makes the task unclaimed again. The same field is `assignee` on the API and on the `create_task` and `update_task` tools (null clears it), `search_tasks` filters by exact name or `unassigned: true`, and each change lands in the task's history like any other field edit. This is the data field only: nothing runs on behalf of an assignee, and no permission follows from the name.
- **Assign to AI.** The task panel's header has an `Assign to <name>` button that sets `assignee` to your default agent name in one click; an assigned task shows an `Assigned to <name>` chip with a Take back button that clears it the same way the plain clear button does. The button is disabled while the dashboard is offline. The default name lives on the server at `GET` and `PATCH /api/settings/agent` (body and response `{ defaultAgentName }`, falling back to `claude-code`), edited from the Agents card beside Backups in Settings. An agent that declared a name when it connected over MCP has that name recorded beside the actor on every event and comment it writes, and in `get_task` and `cc show`.
- **Hand off to Claude Code.** Copy a prompt for Claude Code with the task, its project, and the GitHub repo, open the repo on GitHub, or, for a task that came from a code TODO before that source was removed, open the file at the line. Text from GitHub (and from older Gmail, Drive, or Calendar tasks) is wrapped in a third-party warning inside the prompt.

Live updates:

- **Changes from anywhere show up on their own.** My tasks, Inbox, Board, Goals, Projects, Rules, Digest, and an open task panel check `GET /api/events` every 10 seconds and refetch when the newest event id moves. That covers edits from Claude Code over MCP, the CLI, sync jobs, and other browser tabs, all within about 10 seconds. Polling pauses while the browser tab is hidden and checks again as soon as it is visible.
- **Your typing is kept.** When the task panel refreshes in the background, a field you have changed but not saved (title, notes, and the rest) keeps your text; only untouched fields take the new values.
- **Same database only.** The dashboard sees what its server's database sees. The stdio MCP server opens `command-center/data/constellation.db` unless `CC_DB` says otherwise, so MCP writes made while the mockup is open land in the real database and do not appear in the mockup.

Offline:

- **Every device keeps a copy.** The dashboard stores every answer it reads from the server in the browser (IndexedDB), and keeps that copy complete in the background, including tabs you have not opened on that device. A service worker keeps the app itself, in a built dashboard only, not under `npm run dev`.
- **When the server cannot be reached,** every tab opens on the copy, and a banner under the top bar says "Offline. Showing data from 14:02." It turns red once the copy is more than a day old. A stopped daemon behind a reverse proxy (a 502, 503, or 504) counts as unreachable. A refused token does not: that still shows the connect form.
- **Task edits keep working.** Adding a task, editing its fields, completing or reopening it, moving it on the Board, and commenting are saved on the device and sent when the server is back. The banner counts them while they wait, then reports "Back online. 3 offline changes sent, 1 conflict."
- **Everything else is off until then.** Inbox accept and reject, rules, goals, projects, GitHub switches, and deletes are disabled offline. Navigation, filters, Refresh, Retry, and the Connection form stay on.
- **Conflicts.** If the same field was changed somewhere else in the meantime, the newer edit wins and the other value is written to the task history, so nothing disappears without a trace. Fields that did not collide merge cleanly.
- **Disconnect clears the copy** and any edits still waiting, so it asks first when there are some.

Polaris never writes to repos or GitHub ([ADR-005](../decisions/005-command-center-repo-todos.md)). Changes inside a repo, such as checking a TODO.md box, are made there by you or Claude Code, and the next import picks them up.

## Sources

| Job | What it creates | Default cadence | Setup |
|-----|-----------------|-----------------|-------|
| import | Tasks from the repo root's initiatives/*.md (see cc import below); skipped when there is no such folder | 30 min | None |
| repo-files | Checkboxes in each project's TODO file, README.md, CLAUDE.md, and docs/*.md, read through the GitHub API for every project with a GitHub repo. A local clone is never read, so every machine sees the same tasks, and an edit shows up once it is pushed. A repo that cannot be read (not found, or the GitHub App is not installed on it) is skipped whole and reported; its tasks are left as they are | 30 min | GitHub App (see GitHub setup) |
| github | Inbox items for assigned issues, review requests, your PRs with failing checks or requested changes, and new issues in tracked repos | 15 min | GitHub App (see GitHub setup) |
| rules | Runs enabled rules | 1 min | None |
| digest | Writes data/digests/YYYY-MM-DD.md | daily at CC_DIGEST_AT (07:30) | None |
| backup | A checked copy of the database (see Backups) | daily at CC_BACKUP_AT (03:15), and at daemon start when the last one is over a day old | None |

`npm run cc -- sync` with no job named runs the interval jobs only. The two daily jobs run when named: `sync digest`, `sync backup`.

Owner-authored sources (repo checklists and initiatives) create open tasks. Nothing reads a local clone: the TODO comment scan and the local git hygiene tasks were removed on 2026-09-20, and tasks they created stay as ordinary tasks. GitHub is the one third-party source, and its items always land in the inbox until you accept them. Gmail, Drive, and Calendar ingest was removed on 2026-09-20; tasks that came from them stay, still marked as third-party text.

### cc import

`npm run cc -- import` is for a repo that keeps its plans as `initiatives/*.md`: each file becomes an initiative project, and the checkboxes under its Tasks and Success Criteria headings become tasks. It reads that one folder under the repo root (`CC_REPO_ROOT`, by default two directories above `command-center/src`) and nothing else. A checkout without an `initiatives/` folder, such as the public repo or an installed desktop app, has nothing to import: the command prints one line saying so and exits 0, and the daemon's `import` job records itself as skipped, the way the GitHub jobs do when nobody is signed in. To import plans kept elsewhere, point `CC_REPO_ROOT` at that repo.

### Editing project data

PROJECT_STATUS.md is a generated snapshot (since 2026-09-20). Nothing reads it back, so an edit made in the file is overwritten by the next `export`. It lists every project that is not archived and not an initiative: type, status, GitHub repo, the description, and a Next Steps checklist of unfinished tasks that the owner owns. A task that carries third-party text is never written to it. To change a project's type, status, or description, use the dashboard's Projects tab. To change Next Steps, change the tasks (CLI, MCP, or dashboard).
### GitHub setup

Until the GitHub App is connected, nothing is synced from GitHub, and the `github` and `repo-files` jobs report themselves as skipped. `GITHUB_TOKEN` and the `gh` login are not used (removed 2026-09-20): they can read and write every repo you can, and the App exists to avoid exactly that. For read-only access to repos you choose ([ADR-006](../decisions/006-command-center-github-app.md)), connect the GitHub App from the dashboard's GitHub page (under More), with `serve` or the daemon running. Do it in a browser on the machine that runs the daemon, not through a proxy from another device: GitHub sends each step back to `127.0.0.1`.

1. **Create app.** GitHub opens in a new tab with a read-only app filled in. Click Create GitHub App.
2. **Install on GitHub.** Install it on your account and on any organization whose repos you want, choose Only select repositories, and tick the repos Polaris may read. Change the selection later with Change repos on GitHub.
3. **Sign in with GitHub.** Approve, then close the tab.

The app is public only so it can be installed on the organization; that exposes no data. Its permissions are read-only (metadata, contents, issues, pull requests, checks, statuses) with webhooks off. On Windows the client secret and your sign-in are encrypted with DPAPI under %APPDATA%\constellation\secrets, so the connection is per PC and shared by every database, including the mockup's. On any other platform they are in `secrets.json` next to the database, readable by its owner only (mode 0600), and the server refuses the file if group or others can read it. `CC_SECRETS_DIR` moves the store on either platform; the UI tests set it so they never touch the real one. Sign-in renews itself for six months. GitHub accepts each refresh token once, so a renewal runs under a lock beside the secrets, and the daemon and a CLI command never renew at the same time.

The GitHub page also lists every repo the app can read, with three switches each: Track as project, Sync issues and PRs, and Read checklists. Track as project creates the repo's project, or brings it back if it was archived; the other two switches apply only to a repo that is tracked. Turning any switch off stops new updates from that repo and leaves its existing tasks as they are (turning off Track as project archives the project). `npm run cc -- github status` prints the same information, and `github logout` signs out.

## Backups

The daemon's `backup` job copies the database once a day, to `data/backups` or to `CC_BACKUP_DIR`, and keeps the newest `CC_BACKUP_KEEP` (14). Point `CC_BACKUP_DIR` at another machine or disk: the default folder is on the same disk as the database, so it only protects against a bad write. Use a UNC path for a network share (`\\server\share\folder`), since a mapped drive letter may not exist yet when the daemon starts at logon.

- **Every copy is checked.** It is made with SQLite's `VACUUM INTO` in a temp folder on the local disk, then checked: `integrity_check`, `foreign_key_check`, the schema version, and the row counts against the live database. Only the finished file is written to the backup folder, and it is read back and compared before it gets its dated name. A copy that fails is deleted and the job fails.
- **When something stops.** A failing job, or a backup that never ran or is over 36 hours old, shows as a red strip under the dashboard's top bar (`warnings` on `GET /api/sync`).
- **Encryption is your choice.** It is off until a passphrase is set, from the Backups card on the dashboard's Connection tab or with `npm run cc -- backup encrypt`. From then on the copies are `constellation-YYYY-MM-DD.db.enc`. The passphrase is kept in the secret store, never in the database, an environment variable, or a log, and the server never sends it back. Save it in a password manager: without it no encrypted backup can be read, on this machine or any other. `backup encrypt --status`, `--replace`, and `--off` do what they say; copies made before a change still need the old passphrase.
- **The restore drill.** `npm run cc -- backup check [file]` proves a copy can be read back. It never opens the live database, so it works on a recovery machine, and it asks for the passphrase when the secret store has none.
- **Restoring.** Stop the daemon. For an encrypted copy, run `npm run cc -- backup decrypt <file.db.enc> [output.db]`, which never overwrites. Put the SQLite file where `CC_DB` points and start the daemon. An older copy is migrated when it is opened.
- **Format.** scrypt (N=2^17, r=8, p=1), then ChaCha20-Poly1305, from `node:crypto` alone. The byte layout is at the top of `src/daemon/backupCrypto.ts`, so a copy can be read without this code.

## Desktop app

`desktop/` wraps all of this in one installable Windows app (Tauri): node.exe, the server as a single bundled file, and the built dashboard. Starting the app starts the daemon as a child process with the same `daemon` command and the same environment variables as below, then opens the dashboard at the daemon's own URL, so the app is the browser and nothing else changes. Closing the window stops the daemon. If a daemon is already answering on the port with this database's token (the logon task, or `cc daemon` in a terminal), the app uses it and leaves it running.

- **Data.** `CC_DB` if set, else `%APPDATA%\constellation\data\constellation.db`, beside the secret store the CLI uses, so the app and `npm run cc` share the GitHub sign-in and the backup passphrase. `CC_PORT` picks the port. Without `CC_REPO_ROOT` the import job is skipped, since an install has no initiatives to read. The daemon's output is in daemon.log next to the database, and the app's own steps and failures are in desktop.log beside it.
- **One machine per backup folder.** The backup job replaces the day's dated copy in `CC_BACKUP_DIR`. On a second machine that shares that folder, set `CC_DB` before the first start or clear `CC_BACKUP_DIR` there, or its empty new database becomes that day's backup.
- **Updates.** The app checks the releases repo (owenpkent/constellation-releases) shortly after it opens and offers to install a newer signed build.
- **Building.** `npm run desktop -- build` makes an installer under desktop/src-tauri/target/release/bundle/nsis; `npm run desktop -- release` builds, writes latest.json, and publishes the release. Both code-sign with the EV token unless given `--unsigned`, which only costs a SmartScreen warning when the installer is run by hand. The updater signature is on every build, so an unsigned install updates itself to a signed one later. `npm run test:desktop` runs the shell's Rust tests. Details and decisions are in [initiatives/desktop-app.md](../initiatives/desktop-app.md).

## Running at logon

```powershell
powershell -ExecutionPolicy Bypass -File ..\scripts\install-command-center-task.ps1
powershell -ExecutionPolicy Bypass -File ..\scripts\install-command-center-task.ps1 -Uninstall
```

The task runs the daemon from this working tree, as you, while you are logged on. It reads user environment variables (`CC_TZ`, `CC_BACKUP_DIR`), so set those with `[Environment]::SetEnvironmentVariable(name, value, 'User')` and restart the task. Output goes to `data/daemon.log`. After a dashboard change, run `npm run build` at the repo root and restart the task.

To restart it, wait for the old daemon to let go of the port before starting the new one. A daemon started while the old one still listens exits at once with `EADDRINUSE`:

```powershell
Stop-ScheduledTask 'Constellation Command Center'
while (Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 250 }
Start-ScheduledTask 'Constellation Command Center'
```

## Safety model

- **Propose, do not act.** Third-party input is inbox-only, and the store enforces it: an item from a third-party source (GitHub today; the list also still names gmail, gdrive, and gcal so their old tasks keep the marker) that asks for any starting status except `inbox` is refused, so a new ingest module cannot skip the inbox by mistake. Nothing writes to GitHub or Google. Nothing writes into tracked repos.
- **Rules organize, never decide.** Rule actions cannot complete, drop, or accept tasks. Rules created by an agent are saved disabled until you run `rules enable`.
- **Injection boundary.** No model reads third-party text on the server: the LLM extractor went with Gmail ingest. MCP output marks third-party titles as UNTRUSTED-TEXT and the server instructions tell Claude not to follow them.
- **Goals are a judgement.** A goal's status changes only when you set it, or when an agent calls `update_goal` because you asked. Progress and the "stalled" flag are computed; status never is. Rules cannot act on a goal or trigger on a goal event.
- **Offline edits are your own.** An edit replayed from a dashboard (`POST /api/outbox`, merged in `src/core/outbox.ts`) can create, edit, complete, reopen, move, or comment on a task, and nothing else. There is no op for the inbox, a rule, a goal, a project, or a delete, and an op aimed at a task still in the inbox is refused, so accepting a suggestion is always a live click. A task made offline is recorded as the human, with no source. A sync conflict is not a rule trigger.
- **The rules are tests.** `src/invariants.test.ts` states everything in this section as tests, and each was checked by breaking the code on purpose and watching it fail. If one fails, the change is wrong, not the test.
- **Audit log.** Every change is an event with an actor (human, agent, system, rule). `npm run cc -- show <id>` prints a task's history.
- **Secrets.** Three separate bearer tokens live in data/: api-token for the dashboard, mcp-token for full MCP, and mcp-readonly-token for read-only MCP. An MCP token cannot call the REST API, so an agent cannot enable its own rules. The GitHub App's client secret and sign-in, and the backup passphrase if one is set, are in the secret store (DPAPI on Windows, a 0600 file elsewhere). None of them is stored in the database or in git. The backup passphrase can be set over the REST API and never read back, and there is no MCP tool for it: an agent cannot turn backup encryption off or set a passphrase you do not have.
- **Local only.** The HTTP server binds to 127.0.0.1 and requires a bearer token. The only exceptions are the two GitHub sign-in callbacks (`GET /api/github/app/callback` and `GET /api/github/callback`), which GitHub redirects your browser to and which accept only a single-use state value that expires after 10 minutes, and `GET /api/identity`, which answers a challenge with an HMAC keyed with the api token so the desktop app can recognize its own daemon before handing the token over. Every response forbids framing, so the dashboard cannot be embedded and clicked through by another page.
- **Rules and recurrence always finish.** A rule's `matches` pattern is run by a linear-time engine (src/automation/pattern.ts), not by RegExp, so no pattern can stall the daemon; the everyday syntax is supported and backreferences and lookaround are refused when the rule is saved. A recurrence rule is walked day by day over a bounded horizon (src/automation/recurrence.ts): FREQ is DAILY, WEEKLY, MONTHLY, or YEARLY, INTERVAL and COUNT are positive, and BYSETPOS, BYWEEKNO, BYYEARDAY, and the time-of-day parts are refused.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| CC_REPO_ROOT | repo root (two directories above `command-center/src`) | The repo whose initiatives/*.md `cc import` reads and where `cc export` writes PROJECT_STATUS.md. Optional: without an initiatives/ folder the import does nothing |
| CC_DB | data/constellation.db | Database file |
| CC_TZ | system timezone | Timezone for "today", recurrence, and the daily jobs. An IANA name such as America/Chicago; a name the machine does not know stops the start |
| CC_DIGEST_AT | 07:30 | Daily digest time |
| CC_BACKUP_AT | 03:15 | Daily backup time |
| CC_BACKUP_DIR | data/backups | Where backups go. Another machine or disk is the point |
| CC_BACKUP_KEEP | 14 | How many dated copies to keep |
| CC_SECRETS_DIR | %APPDATA%\constellation\secrets on Windows, the database's folder elsewhere | Where the secret store lives |
| CC_API_TOKEN, CC_MCP_TOKEN, CC_MCP_READONLY_TOKEN | generated | Bearer token overrides |
| CC_CORS_ORIGINS | localhost:5173 | Dashboard origins allowed to call the API |
| CC_TAILSCALE_LOGIN | unset | Your Tailscale login. A dashboard opened through `tailscale serve` on this machine then needs no token (docs/tailscale-identity.md). Never applies to MCP |
| CC_DASHBOARD_DIR | repo root's dist/ | Built dashboard directory served at / |
| GITHUB_WEBHOOK_SECRET | unset | Enables POST /webhooks/github |

## Layout

```
src/
  core/        task graph store, schema, types (runtime-portable)
  importer/    initiatives/*.md
  export/      writes PROJECT_STATUS.md from the database
  ingest/      github, plus the shared secret store and PKCE helper
  automation/  views, rules, recurrence, digest, scheduler
  mcp/         MCP server (stdio and HTTP)
  http/        REST API (backup settings and job warnings included), MCP over Streamable HTTP, webhook receiver
  daemon/      job catalog, one-shot sync, long-running daemon, backups and their encryption
  tasks/       human CLI commands
  dev/         demo and UI-test database seeders; both refuse to run against the real database
```

## Development

```powershell
npm test            # server tests (node:test), about 780 of them
npm run typecheck   # tsc --noEmit
```

From the repo root, `npm run test:fast` runs these two plus the dashboard unit tests, which is what the pre-push hook and CI run. `npm run test:ui` builds the dashboard and drives it in Microsoft Edge against a throwaway server seeded by `src/dev/seed-demo.ts` and `src/dev/seed-ui-test.ts`; both seed scripts refuse to run against the real database. The plan and the rules every test follows are in [initiatives/automated-testing.md](../initiatives/automated-testing.md).

`src/invariants.test.ts` states the safety rules in one place: third-party items only ever arrive in the inbox, rules never complete, drop, accept, or reject a task, an agent cannot enable a rule, the read-only MCP endpoint cannot write, goal status is never computed, every change records its actor, and offline edits replay only what the owner did to their own tasks. A failure there means a promise was broken, so fix the code, not the test.

Tests never read `data/`. They use `openStore(':memory:')` or a temp folder, make no network calls, and must not depend on the machine: no real paths under the dev folder, and no reliance on a real GitHub sign-in (pass a token, or an in-memory secret store, explicitly).

The source uses erasable TypeScript only (no enums, namespaces, or parameter properties), and relative imports end in `.ts`.

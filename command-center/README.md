# Polaris Command Center

A single-user, agent-operated task graph. It holds the tasks you create yourself and pulls work from your repos and GitHub into one SQLite database, and exposes it to Claude over MCP and to the dashboard over a local REST API.

Design and phases: [initiatives/agentic-command-center.md](../initiatives/agentic-command-center.md). Decisions: [ADR-003 hosting](../decisions/003-command-center-hosting.md), [ADR-004 task model](../decisions/004-command-center-task-model.md).

## Requirements

- Node 24 or newer. There is no build step: Node runs the TypeScript directly.
- `npm install` in this folder.
- The read-only GitHub App (see GitHub setup) for GitHub ingestion. It is the only GitHub credential the Command Center uses.

## Quick start (PowerShell, from this folder)

First time? Follow [docs/getting-started.md](../docs/getting-started.md) for install, phone access, Claude, GitHub, and backups step by step.

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
- **Another computer, including sessions you drive through Claude Code Remote Control:** add the server once per computer at user scope over the private HTTPS address, with a name for that computer: `claude mcp add --scope user --transport http polaris https://<host>.<tailnet>.ts.net/mcp --header "Authorization: Bearer <token>" --header "X-Agent-Name: claude@laptop"`. Every session on that computer, including one started from claude.ai/code or the Claude app through `claude remote-control`, can then read a handed-off task, comment, and complete it, and the task's history names the computer. The MCP connection goes from that computer to your server, so it needs no public endpoint. Use HTTP, not the stdio server, on any computer other than the host: stdio opens a local database and would start a second, empty Polaris.
- **Phone and laptop:** keep the server on loopback and reach it behind a reverse proxy on a private network you control, such as Tailscale (`tailscale serve`). Never expose it publicly: the MCP routes have no OAuth. With `CC_TAILSCALE_LOGIN` set to your Tailscale login, a dashboard opened through `tailscale serve` signs in with your Tailscale identity and needs no token pasted; MCP clients still need theirs. docs/tailscale-identity.md says what that trusts. On the phone, use the browser or the Android app in [../mobile/](../mobile/README.md), which needs `CC_CORS_ORIGINS=https://localhost` on the server.
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

Start the daemon (or `npm run cc -- serve`), then run `npm run dev` at the repo root. Once `dist/` exists (`npm run build` at the repo root), the same built dashboard is also served directly at http://127.0.0.1:8788/, on the API's own origin. The dashboard opens on My tasks; use the menu button (top left) for Inbox and Board, and open More for Goals, Projects, Checklists, Threads, Rules, Digest, and GitHub. Until you connect, any Command Center page shows a connect form: when the dashboard was opened from the server itself (http://127.0.0.1:8788/ on the machine that runs it, or its private-network address), the server URL is already filled in with the page's own origin and only the token from data/api-token is needed; from the Vite dev server the URL defaults to http://127.0.0.1:8788, and in the Android app ([../mobile/](../mobile/README.md)) it starts empty, since the page's origin is the app itself. Append `?view=inbox` (or board, goals, projects, checklists, threads, rules, digest, github, settings) to the dashboard URL to open it on that view instead.

To try the dashboard without touching your real database, run `npm run mockup` from the repo root. It builds a scratch database in the temp folder (`%TEMP%\constellation-mockup`) from the real importer and `sync repo-files` (skipped if GitHub is unreachable), plus demo tasks and inbox items (src/dev/seed-demo.ts, which refuses to run without a scratch `CC_DB`), starts `serve` and Vite, and opens the dashboard already connected. `--fresh` rebuilds the scratch database and `--port` changes the API port. The script passes the token in the URL fragment, which the dashboard reads once and clears from the address bar.

My tasks:

- **Columns.** Drag the edge of a column header to resize it, or use the header menu (Wider, Narrower, Reset width) so resizing never needs a drag. Double-click an edge to reset. The header menu also sorts by that column and hides it; Columns in the toolbar shows hidden columns again. Widths and hidden columns are saved in the browser.
- **Toolbar.** Filter by readiness (Ready: what could be started now; Blocked: held by an unfinished task), project, goal, priority, source, and assignee (Unassigned, or any name the list holds); sort by due date, priority, project, or name; group by due date, project, priority, or none. Choices are saved in the browser.
- **Inline edits.** Click a row's Due date, Project, or Priority to change it from a dropdown without opening the task panel. Changing the project clears the task's section.
- **Quick add from a share.** Opening the dashboard with `share-title`, `share-text`, or `share-url` in the query (the web app manifest's `share_target`, or a share to the Android app) opens the new-task sheet prefilled, with a link kept as `sourceUrl`, for you to confirm or edit. The parameters are removed from the address bar at once so a reload does not repeat it. A share is your own action, like pasting, so the task is your own trusted text and never an inbox item.
- **Reminders.** In the Android app only, and per device, off until switched on under Settings. The dashboard schedules one notification on the phone for each task with a due date, at the time of day you pick (a due with a time fires at that time), from its own task list; nothing is sent anywhere. Tapping a reminder opens that task. Opening the dashboard with `?task=<id>` opens a task's panel the same way.

Projects:

- **Made by hand.** New project asks for a name and, if you want, a type, a status, a GitHub repo, and a description in markdown. A project needs no repo, so it can hold work that has nothing to do with GitHub.
- **Archive, not delete.** Archiving hides a project and keeps its tasks. Show archived brings it back into the list, where it can be unarchived.
- **Tracked from GitHub.** Switching on Track as project for a repo on the dashboard's GitHub page creates its project; switching it off archives the project and keeps its tasks, and switching it back on brings the same project back. Every field, including name and GitHub repo, can be edited here.

Checklists:

- **A template you reuse.** A checklist is a name, optional notes, and items in order, such as "Packing: weekend trip" or "Clean the kitchen". Make one with New checklist; add items with Add item (or Enter), and reorder or remove them with the up, down, and remove buttons beside each one. Delete asks for a second click.
- **Start.** Start asks for an optional due date and project (the task title starts as the checklist's name), then makes a new open task with the checklist's notes and one subtask per item, in order, and opens it. Tick items off as subtasks in the task panel, which also works offline. The checklist itself is never changed by starting it, so it can be started again; deleting it leaves the tasks started from it alone. The started task records the checklist's id in its custom field `checklistId`.
- **Repeats.** The Start form's "Bring the items back each time it repeats" box is on by default and is stored on the task as the custom field `checklistRepeatItems`. If you later give the task a repeat, completing it makes the next occurrence with fresh, unticked copies of its subtasks as they stand then (dropped ones left out), and that carries on for every later repeat. With the box off, a repeat comes back without subtasks, as every other repeating task does. The same choice is `repeatItems` on `POST /api/checklists/:id/start`, `--repeat-items on|off` on `cc checklist start`, and `repeat_items` on `start_checklist`, all on by default. A rule cannot set it.
- **Save as checklist.** A task with subtasks has Save as checklist under its subtasks in the task panel, which makes a checklist named after the task from its notes and its subtask titles (dropped ones left out). A task holding third-party text, or with a subtask that does, cannot be saved as one.
- **Everywhere else.** `npm run cc -- checklist list`, `checklist show <id|name>`, `checklist add <name> --items "First; Second"`, and `checklist start <id|name> [--title] [--project] [--due] [--repeat-items on|off]`; REST under `/api/checklists` (see src/http/README.md); and for agents `list_checklists` on both MCP endpoints, with `create_checklist` and `start_checklist` on the write endpoint only (no tool edits or deletes one). Up to 200 items of 500 characters each. Every write is live only: there is no offline op for a checklist, so its controls are off while the server cannot be reached. Checklist events are not rule triggers, and rules have no checklist action.

Goals:

- **What a goal is.** A title, an optional period (one click for this quarter, this year, or next year), a status you set by hand (on track, at risk, off track, achieved, dropped) with a short note, and optional sub-goals.
- **Progress.** Either counted from linked work or typed in as a number out of a target. Counted work is the tasks linked to the goal plus the milestone tasks of linked projects; inbox and dropped tasks never count, and a parent goal includes its sub-goals' work. Status is never computed from progress.
- **Needs attention.** A goal is flagged when nothing open can move it (no active task linked, and none in a linked project) or when its status has not been updated in 14 days. The daily digest lists the same flags.
- **Linking.** Open a goal's details to link a project from a dropdown or a task by typing part of its name. Linking never changes the project or the task.
- **One-time import.** The old Goals tab kept its data in one browser. While the server has no goals, the new tab offers to import what that browser holds.

Task panel:

- **Assignee.** Who a task is handed to, as a plain name (initiatives/teammates-and-goals.md, Teammates Step 1). Empty means unclaimed, which today means the owner. Type a name and leave the field to save it; the clear button beside it makes the task unclaimed again. The same field is `assignee` on the API and on the `create_task` and `update_task` tools (null clears it), `search_tasks` filters by exact name or `unassigned: true`, and each change lands in the task's history like any other field edit. This is the data field only: nothing runs on behalf of an assignee, and no permission follows from the name.
- **Threads.** A task can carry one discussion thread, where several agents and you work a hard problem out in short typed posts: claim, evidence, objection, question, failed_attempt, summary, or result, each with optional confidence and references to the posts it answers. Agents read and write it over MCP (`list_threads`, `get_thread`, `create_thread`, `post_to_thread`; the read-only endpoint has the first two), and you do from the command line (`npm run cc -- thread show <taskId>`, `thread post <taskId> --type claim <body>`, which opens the thread if there is none) or over REST (`GET /api/threads`, `GET` and `POST /api/tasks/:id/thread`, `GET /api/threads/:id`, `POST /api/threads/:id/posts`). A post never changes the task. What counts is yours alone: `thread judge <postId> accepted|rejected|superseded|open` sets a claim's or result's status, `thread pin` makes a post the current state shown first, `thread close` and `thread reopen` do what they say, `thread fork <taskId> <title>` closes the thread and continues it on a new subtask with a thread of its own, `thread set --hide-authors on` makes every author read as "participant" to agents (the dashboard still shows names), `thread set --daily-cap <n>` limits posts per agent per UTC day (never yours), `thread list` shows each thread's open claims, unanswered objections, accepted results, and days since your last verdict, and `thread search` is the library across threads (agents have `search_posts`). A read with no cursor returns the newest 500 posts and says "showing the last N of M" when that is not all of them; `--after <postId>` reads only what is new. A thread on a task with third-party text is marked UNTRUSTED-TEXT in `thread list`, `thread search`, and every agent-facing line, because the thread title defaults to the task's. The same controls are `PATCH /api/threads/:id`, `POST /api/threads/:id/close|reopen|fork`, `PATCH /api/posts/:id`, and `GET /api/posts`; none exists over MCP. Thread events are not rule triggers, there is no offline op for a post or for any of these controls, and a post on a task with untrusted text is marked the same way the task is. The design and its later stages are in docs/agent-threads-proposal.md.
- **Assign to AI.** The task panel's header has an `Assign to <name>` button that sets `assignee` to your default agent name in one click; an assigned task shows an `Assigned to <name>` chip with a Take back button that clears it the same way the plain clear button does. The button is disabled while the dashboard is offline. The default name lives on the server at `GET` and `PATCH /api/settings/agent` (body and response `{ defaultAgentName }`, falling back to `claude-code`), edited from the Agents card beside Backups in Settings. An agent that declared a name when it connected over MCP has that name recorded beside the actor on every event and comment it writes, and in `get_task` and `cc show`.
- **Hand off to Claude Code.** Copy a prompt for Claude Code with the task, its project, the GitHub repo, and the task id with how to report back over MCP (claim, comment, complete, or set waiting with a question), so a session started anywhere, including through Claude Code Remote Control from a phone, keeps the task up to date, open the repo on GitHub, or, for a task that came from a code TODO before that source was removed, open the file at the line. Text from GitHub (and from older Gmail, Drive, or Calendar tasks) is wrapped in a third-party warning inside the prompt.

Live updates:

- **Changes from anywhere show up on their own.** My tasks, Inbox, Board, Goals, Projects, Checklists, Rules, Digest, and an open task panel check `GET /api/events` every 10 seconds and refetch when the newest event id moves. That covers edits from Claude Code over MCP, the CLI, sync jobs, and other browser tabs, all within about 10 seconds. Polling pauses while the browser tab is hidden and checks again as soon as it is visible.
- **Your typing is kept.** When the task panel refreshes in the background, a field you have changed but not saved (title, notes, and the rest) keeps your text; only untouched fields take the new values.
- **Same database only.** The dashboard sees what its server's database sees. The stdio MCP server opens `command-center/data/constellation.db` unless `CC_DB` says otherwise, so MCP writes made while the mockup is open land in the real database and do not appear in the mockup.

Offline:

- **Every device keeps a copy.** The dashboard stores every answer it reads from the server in the browser (IndexedDB), and keeps that copy complete in the background, including tabs you have not opened on that device. A service worker keeps the app itself, in a built dashboard only, not under `npm run dev`. The Android app registers no service worker, since the app shell is inside it; the copy and the queue work the same there.
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

## Importing tasks

Paste text or load a CSV to create many tasks at once. These are your own tasks: they start `open` (not in the inbox), are never marked untrusted, and are created all or nothing in one transaction. Any row error means nothing is created.

- **Lines**: one task per line. Leading bullets (`-`, `*`, `+`, `1.`, `1)`) and `[ ]` / `[x]` checkboxes are stripped (checked means done). Indenting nests: a deeper line is a subtask of the nearest shallower line above it (a tab counts as four columns). Markdown headings and fenced code blocks are skipped.
- **CSV / TSV**: a header row is required, with a comma, semicolon, or tab delimiter (detected from the header, so a spreadsheet paste works). Headers ignore case, spaces, underscores, and hyphens. Columns: `title` (also name, task, content, summary; required), `notes` (description, details, body), `status`, `priority`, `due` (duedate, deadline, date), `start`, `estimate` (minutes), `assignee` (owner, assignedto), `project`, `section`. Unknown columns are ignored and reported.
- **Values**: status is one of inbox, open, in_progress, waiting, done, dropped (also "in progress", "todo", "completed"). Priority is none, low, medium, high, urgent (or p1 to p4). Dates are `YYYY-MM-DD` or a full ISO datetime. Estimates are minutes, `90m`, `1h`, `1h30m`, or `1.5h`. A row's `project` overrides the default project; a section is created if it does not exist. At most 1000 rows.

```sh
npm run cc -- tasks import tasks.csv --project nimbus --dry-run   # preview, creates nothing
npm run cc -- tasks import tasks.txt --format lines               # - reads stdin
```

Over REST, `POST /api/tasks/import` takes `{ text, format?: "auto"|"csv"|"lines", project?, dryRun? }`. A dry run answers `200 { dryRun, format, rows, count, errors, ignoredColumns }`. A real run answers `201 { format, created, count, ignoredColumns }`, or `400 { error, errors: [{ line, message }] }` with nothing created. Import is live-only: there is no MCP tool, rule action, or offline queue entry for it.

## Backups

The daemon's `backup` job copies the database once a day, to `data/backups` or to `CC_BACKUP_DIR`, and keeps the newest `CC_BACKUP_KEEP` (14). Point `CC_BACKUP_DIR` at another machine or disk: the default folder is on the same disk as the database, so it only protects against a bad write. Use a UNC path for a network share (`\\server\share\folder`), since a mapped drive letter may not exist yet when the daemon starts at logon.

- **Every copy is checked.** It is made with SQLite's `VACUUM INTO` in a temp folder on the local disk, then checked: `integrity_check`, `foreign_key_check`, the schema version, and the row counts against the live database. Only the finished file is written to the backup folder, and it is read back and compared before it gets its dated name. A copy that fails is deleted and the job fails.
- **When something stops.** A failing job, or a backup that never ran or is over 36 hours old, shows as a red strip under the dashboard's top bar (`warnings` on `GET /api/sync`).
- **Encryption is your choice.** It is off until a passphrase is set, from the Backups card on the dashboard's Settings tab or with `npm run cc -- backup encrypt`. From then on the copies are `constellation-YYYY-MM-DD.db.enc`. The passphrase is kept in the secret store, never in the database, an environment variable, or a log, and the server never sends it back. Save it in a password manager: without it no encrypted backup can be read, on this machine or any other. `backup encrypt --status`, `--replace`, and `--off` do what they say; copies made before a change still need the old passphrase.
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

## Updating

`npm run cc -- update` moves an install to the newest `origin/main`, the way the manual steps did, with a checked snapshot and a rollback; `--release` and `--to` move it to a signed release instead (the design is docs/update-proposal.md; the release checklist and the key setup are docs/releases.md; the scheduled updater is `--auto` under Automatic updates below, and the dashboard's update icon asks it to install). You run it, or the OS scheduler runs `--auto` as you; the daemon never does, and never starts a program.

What it does, in order, logging each step to `data/update.log` and the outcome to `data/update-status.json`:

1. Refuses when the working tree has uncommitted changes, is on a branch other than `main`, or has local commits not on the remote. A deploy checkout carries no local work; keep development in a second clone. The target must be newer (below), else nothing is installed.
2. Fetches (with the tags) and shows the commits, whether `src/core/schema.ts` changes, whether a lockfile changes, and for a release its notes. `--check` stops here. Otherwise it asks once; `--yes` skips the question.
3. Checks out the target (`origin/main` fast-forwarded, or the release tag with HEAD detached) and reads its package.json, which must say the version that was chosen, else the checkout is put back and nothing else runs. Then `npm ci --ignore-scripts` here and at the root, `npm rebuild esbuild` (the one install script the build needs; a test pins that list), `npm run test:fast`, and `vite build --outDir dist.next`. The live `dist/` is untouched until the restart, and the daemon keeps taking writes throughout.
4. Puts up the write barrier, `data/update-barrier.json`, and stops the daemon. While the barrier stands (its pid alive and under two hours old) nothing writes the database: the daemon answers 503 to every write on `/api` with a body saying Polaris is updating (reads, `GET /api/health`, and `GET /api/identity` go on; the dashboard keeps a refused edit in its outbox and sends it later), the MCP write tools return an error, and a `cc` command that opens the store says "Polaris is being updated (started <time>). Try again in a minute." and exits 1. `cc update`, `cc backup check`, and `cc backup decrypt` never open the store that way and are not blocked. A barrier left by a crashed update is ignored and removed by whoever finds it.
5. With the daemon stopped, snapshots the database through the backup code as `constellation-pre-update-<version>-<moment>.db` (`.enc` when backup encryption is on) in the backup folder. The daily copy never replaces it; the newest three snapshots are kept. The copy is taken now, and not before the checkout as it once was, so that everything written during steps 3 and 4 is in it: it is what a rollback restores, and a write taken after it would be lost. Then swaps `dist.next` into `dist`, keeping the old one as `dist.prev`, starts the daemon, and checks it: `GET /api/identity` must answer with the proof for this install's api token, and `GET /api/health` must say ok and report the new version, within 90 seconds. The token is read from the file next to the database and never printed. `--port` names the daemon's port (8788). The barrier comes down once the check has passed.
6. On any failure after the checkout moved: back to the previous commit (the branch, or the release tag it started on), `npm ci` again if it had run, `dist.prev` back, and, when the new code had migrated the database, the snapshot restored (with the daemon stopped, and the `-wal` and `-shm` files removed) before the restart. A failure before the restart leaves the daemon running the old code throughout, with no barrier and no snapshot. A snapshot that fails leaves the daemon stopped and nothing swapped; the rollback starts it again on the old code. The barrier comes down after the rollback, whether it worked or not. If the rollback fails too, the command says so, with the previous commit and the snapshot path.

What counts as newer. The running version is the checkout's root package.json. `origin/main` is a target when it is strictly ahead of HEAD (a fast-forward with at least one commit) and its version is not older than the running one, so a merge need not bump the version. A release is a target only when its version is strictly newer than the running one.

### Releases

A release is a tag `vX.Y.Z` (nothing after the patch) signed with the owner's SSH key; docs/releases.md has the key setup and the checklist. The command never trusts the signature by itself: it trusts the keys the install has pinned.

| Command | What it does |
|---|---|
| `cc update --release` | Fetches the tags from `origin` (credential-free, the same remote `git pull` uses), takes the newest release strictly newer than the running version that `git verify-tag` accepts against the pinned keys, and installs it as above. A tag that does not verify is skipped and reported, never installed. Starting from a release tag (a detached HEAD on a verified `vX.Y.Z`) is fine |
| `cc update --to v2.1.0` | That release, verified and strictly newer, else refused. Moving back to an older release is a deliberate `git checkout` by you |
| `cc update --check` | Fetches, reports what `origin/main` would change (when on `main`) and the newest verified newer release (version, notes, whether the schema changes, and which tags were skipped and why), installs nothing, and writes the release it found into `data/update-status.json` as `available` for the dashboard |
| `cc update --trust-signers` | Shows the pinned keys and the committed keys side by side (principal, key type, SHA256 fingerprint from `ssh-keygen -lf`), asks, and replaces the pinned copy. `--yes` skips the question; without a terminal and without `--yes` nothing changes |

The pinned signers file. `release-signers` at the repo root lists the keys allowed to sign a release, in OpenSSH allowed_signers format. The first `--release`, `--to`, or `--check` copies it to `data/release-signers` (owner-only), and every verification from then on is `git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=data/release-signers verify-tag <tag>`, with the OpenPGP and X.509 programs pointed at nothing, and only for a tag whose object carries exactly one signature block, an SSH one: `git verify-tag` picks its verifier from the signature in the tag, so a tag signed with OpenPGP by a key in this machine's keyring would otherwise pass, and such a tag is skipped with the format named. Nothing but `--trust-signers` changes that copy: a commit that changes the committed file is reported as "the signers file changed; run cc update --trust-signers to review it", and verification carries on against the pinned copy. A pinned file with no keys means no release can verify, which `--release` and `--to` refuse on and `--check` reports. A pinned file that other users can write is refused, as the secret store refuses one they can read.

How the daemon is restarted comes from `CC_UPDATE_RESTART`, or is detected: the logon task on Windows, then `systemctl is-active polaris`, then the user unit, otherwise by hand.

| Method | `CC_UPDATE_RESTART` | What happens |
|---|---|---|
| Windows logon task | `task` | `Stop-ScheduledTask`, wait for the port to free, snapshot, swap, `Start-ScheduledTask` |
| systemd system unit | `systemd:<unit>` | `sudo -n systemctl stop <unit>`, wait for the port to free, snapshot, swap, `sudo -n systemctl start <unit>`. Needs one sudoers line (below) |
| systemd user unit | `systemd-user:<unit>` | `systemctl --user stop`, snapshot, swap, `systemctl --user start` |
| A plain process | `manual` | Prints that you must stop the daemon, waits for the port to free, snapshots and swaps, asks you to start it, waits, then health-checks. A rollback restores the code, `dist`, and the database and asks you to restart once more |

For a system unit, add this line with `visudo`, naming your user and the unit (`scripts/install-updater-systemd.sh` prints it with the paths filled in, and writes it with `--sudoers`): it allows `systemctl` with those three verbs on that one unit and nothing else, because an update stops the daemon, snapshots the database and swaps the built dashboard (or restores both, on a rollback) while nothing holds the port, then starts it; a line with `restart` alone would give it no such moment.

```
owen ALL=(root) NOPASSWD: /usr/bin/systemctl stop polaris, /usr/bin/systemctl start polaris, /usr/bin/systemctl restart polaris
```

Before anything moves, `cc update` asks `sudo -n -l` about all three verbs, so a missing or older sudoers line is reported while the daemon is still up and nothing has changed. The restart itself only ever runs stop and start.

### Automatic updates

Off until you install the scheduled updater, which runs `npm run cc -- update --auto` every five minutes, as you, outside the daemon (the design is docs/update-proposal.md, section 3). It installs only signed releases, never `main`, and only a version strictly newer than the one running, and it never asks a question. Each run appends to `data/updater.log` (its own output) and, when it does something, to `data/update.log` (the update steps), and writes what it is doing to `data/update-status.json`, which the dashboard's update icon and the warnings strip read. One run, in order:

1. Writes the heartbeat (`updaterInstalled`, `lastRunAt`). A heartbeat within fifteen minutes is what makes the panel show its Update now button.
2. Asks the daemon on its port for the current update request, with the api token from the file next to the database. A daemon that does not answer ends the run: nothing is installed when there is nothing to restart into, and the status file's `problem` says so until a run reaches the daemon again. A pending request (the dashboard's Update now) is picked up, re-verified against the pinned signers, required to be strictly newer, installed through the same path as `cc update --to` (checkout, `npm ci`, tests, build, then behind the write barrier: stop, snapshot, swap, start, health check, rollback), and finished as done or failed with the one-line reason. A request whose tag does not verify, or whose version is not newer, is finished as failed and nothing is installed. If the daemon cannot be reached after the restart, the status file's `request` entry carries the outcome and the daemon takes it from there. A request is picked up on every run, even while the updater backs off or has stopped: your click is the override, a success clears the failure count, and a failure during a pause leaves the ladder where it is. A request the updater picked up and never finished (it was stopped or killed mid-run) expires two hours after the pickup, or you can cancel it, and the panel offers Update now again. On a plain-process daemon (no logon task, no systemd unit, no `CC_UPDATE_RESTART`) the updater installs nothing: it refuses with "no restart method" and a request comes back failed with that reason, so run `cc update --release` by hand there.
3. With no request, and only while not backed off or stopped, the daily check. The quiet window is one hour from `CC_UPDATE_AT` (04:00 by default, in the daemon's timezone, after the 03:15 backup). Inside it, the first run fetches the tags, writes what it found as `available` and `lastCheckAt`, and installs the newest verified newer release at once. Outside it, `available` is refreshed once a day and nothing is installed, so the icon still lights the morning after a release when the window was missed. A refusal (an untracked file, another branch, no restart method) counts as that day's check, so it is not retried every five minutes; the reason is the status file's `problem` and is in `data/updater.log`.
4. After a failed install (a rollback, or a rollback that failed), the backoff ladder: no automatic install for one day after the first failure in a row, three days after the second, and after the third the updater stops and waits for you. The status file keeps the count (`failures`) and the pause (`backoffUntil`), and the dashboard shows "The last update failed: ..." while it backs off and "Automatic updates have stopped: ..." once it has stopped. A success clears the count.

To restart a stopped updater, run `npm run cc -- update --release` by hand: any run by hand (not `--check`) clears the count and the pause, whatever its outcome, and the next scheduled run carries on. The failure itself is in `data/update.log`.

Windows, a scheduled task beside the logon task, run whether or not you are logged on:

```powershell
powershell -ExecutionPolicy Bypass -File ..\scripts\install-updater-task.ps1
powershell -ExecutionPolicy Bypass -File ..\scripts\install-updater-task.ps1 -Uninstall
```

Linux, a systemd user service and timer in `~/.config/systemd/user/`, with lingering turned on so the timer runs with no session open:

```sh
../scripts/install-updater-systemd.sh
../scripts/install-updater-systemd.sh --uninstall
```

When the daemon is a system unit (`systemctl is-active polaris`, or `--unit <name>`), the script prints the sudoers line above with your user and paths filled in, and `--sudoers` writes it to `/etc/sudoers.d/polaris-updater` after `visudo -cf` has accepted it.

The updater's environment. It must see the same `CC_*` variables the daemon runs with, or it looks for the database, the backups, and the secrets in their default places. The Windows task inherits your user environment variables, as the daemon's task does (set them with `[Environment]::SetEnvironmentVariable(name, value, 'User')`). A systemd user unit carries none, so the service reads `~/.config/polaris/updater.env`: the installer creates it owner-only with a commented example of every variable the updater reads (`CC_DB`, `CC_BACKUP_DIR`, `CC_SECRETS_DIR`, `CC_UPDATE_RESTART`, `CC_UPDATE_AT`, `CC_TZ`, `CC_REPO_ROOT`, `CC_DASHBOARD_DIR`, and `CC_API_TOKEN` for a daemon that runs with the token in its environment), copies in any of them set when the installer runs and each `--env NAME=value`, keeps what is already there on a rerun, and prints where the file is. Edit it any time; the next run reads it. A daemon on another port needs `--port N`, which goes on the unit's `ExecStart` line.

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
| CC_UPDATE_RESTART | detected | How `cc update` restarts the daemon: `task`, `systemd:<unit>`, `systemd-user:<unit>`, or `manual` (see Updating) |
| CC_UPDATE_AT | 04:00 | When the scheduled updater's daily check runs, the start of its one-hour quiet window, in CC_TZ (see Automatic updates). Read by `cc update --auto` only |
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
  update/      cc update: releases, signers, the install steps, the restart, the scheduled --auto run, and the status file the daemon reads
  dev/         demo and UI-test database seeders; both refuse to run against the real database
```

## Development

```powershell
npm test            # server tests (node:test), about 780 of them
npm run typecheck   # tsc --noEmit
```

From the repo root, `npm run test:fast` runs these two plus the dashboard unit tests, which is what the pre-push hook and CI run. `npm run test:ui` builds the dashboard and drives it in Microsoft Edge against a throwaway server seeded by `src/dev/seed-demo.ts` and `src/dev/seed-ui-test.ts`; both seed scripts refuse to run against the real database. The plan and the rules every test follows are in [initiatives/automated-testing.md](../initiatives/automated-testing.md).

`src/invariants.test.ts` states the safety rules in one place: third-party items only ever arrive in the inbox, rules never complete, drop, accept, or reject a task, an agent cannot enable a rule, the read-only MCP endpoint cannot write, goal status is never computed, every change records its actor, offline edits replay only what the owner did to their own tasks, and a thread is talk, not action: a post never changes a task, only the human actor judges, pins, closes, or forks, and nothing about a thread reaches the rule engine or the outbox. A failure there means a promise was broken, so fix the code, not the test.

Tests never read `data/`. They use `openStore(':memory:')` or a temp folder, make no network calls, and must not depend on the machine: no real paths under the dev folder, and no reliance on a real GitHub sign-in (pass a token, or an in-memory secret store, explicitly).

The source uses erasable TypeScript only (no enums, namespaces, or parameter properties), and relative imports end in `.ts`.

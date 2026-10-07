# Getting started with Polaris

This guide takes you from a fresh clone to a Polaris you use every day: on your computer, on your phone, and with Claude working tasks for you. Each step ends with a check, so you know it worked before you move on.

You need to be comfortable in a terminal. You do not need to have run a server before.

## Contents

1. [What Polaris is](#1-what-polaris-is)
2. [Install and first run](#2-install-and-first-run)
3. [Your first ten minutes](#3-your-first-ten-minutes)
4. [Your phone and other computers](#4-your-phone-and-other-computers)
5. [Connecting Claude](#5-connecting-claude)
6. [GitHub (optional)](#6-github-optional)
7. [Backups](#7-backups)
8. [Updating and troubleshooting](#8-updating-and-troubleshooting)
9. [Where to go next](#9-where-to-go-next)

## 1. What Polaris is

Polaris is a task tracker for one person and the AI agents that work for them. Your tasks live in one SQLite file on your own disk. A small program, the daemon, serves a dashboard in your browser, an API, and an MCP server that agents such as Claude Code connect to. A command line, `cc`, works on the same data.

Agents can read everything and propose changes, but the decisions stay with you. Items from outside (GitHub, today) wait in an inbox until you accept them. A rule an agent writes starts switched off. Text written by third parties is marked and never followed as instructions. A goal's status is whatever you say it is. The rest of this guide shows each of these as you meet it.

### The shape: one host

Polaris has exactly one database, on one machine that stays on. Call that machine the host. Everything else, your phone, your laptop, Claude on another computer, connects to the host. Nothing syncs between machines, because there is only one copy.

```
                      +--------------------------------+
  phone (browser) --+ |  HOST: an always-on computer   |
  laptop (browser) -+-+  tailscale serve (HTTPS)        |
  Claude Code ------+ |    -> 127.0.0.1:8788 daemon     |
    (MCP over HTTPS)  |  the one SQLite database        |
                      +--------------------------------+
```

The daemon only listens on 127.0.0.1, so nothing outside the host can reach it directly. Section 4 adds private HTTPS access for your own devices.

If you only ever use one computer, that computer is the host and you can skip section 4.

## 2. Install and first run

### Step 1: Install Node and clone the repo

You need Node 24 or newer. Check with `node --version`. There is no build step for the server: Node runs the TypeScript directly.

```sh
git clone https://github.com/owenpkent/polaris.git
cd polaris
npm install
npm --prefix command-center install
```

**You should now see** both installs finish without errors.

### Step 2: Try it on a scratch database first (optional)

To look around without creating your real database, run:

```sh
npm run mockup
```

It builds a scratch database with demo tasks in your temp folder and opens the dashboard already connected. Close it with Ctrl+C. Your real data, which you create next, is untouched.

If you ever run the daemon by hand for an experiment, point it at scratch locations so it cannot touch your real files. Do it in a separate terminal window and close that window when you are done:

```sh
# Linux and macOS
CC_DB=/tmp/polaris-try/polaris.db CC_BACKUP_DIR=/tmp/polaris-try/backups CC_SECRETS_DIR=/tmp/polaris-try/secrets npm run cc -- daemon
```

```powershell
# Windows PowerShell
$env:CC_DB="$env:TEMP\polaris-try\polaris.db"; $env:CC_BACKUP_DIR="$env:TEMP\polaris-try\backups"; $env:CC_SECRETS_DIR="$env:TEMP\polaris-try\secrets"
npm run cc -- daemon
```

The Linux and macOS line sets the variables for that one command only. The PowerShell lines set them for the whole window, so after Ctrl+C every `npm run cc` in that window would still use the scratch database. If you want to carry on in the same window, clear them first:

```powershell
Remove-Item Env:CC_DB, Env:CC_BACKUP_DIR, Env:CC_SECRETS_DIR
```

### Step 3: Add a task from the command line

```sh
npm run cc -- add "Read the Polaris getting started guide" --priority medium
npm run cc -- ls
```

The first command creates the database at `command-center/data/constellation.db`.

**You should now see** your task in the list. `npm run cc` with no command prints every command, and `npm run cc -- <command> --help` shows its options.

### Step 4: Build the dashboard and start the daemon

```sh
npm run build
npm run cc -- daemon
```

The daemon serves the dashboard and the API on http://127.0.0.1:8788/ and runs the scheduled jobs: rules every minute, a daily digest, a daily backup, and the GitHub syncs once you connect GitHub. Leave it running.

**You should now see** a line like:

```
HTTP API and MCP endpoint at http://127.0.0.1:8788 (tokens: api-token, mcp-token, mcp-readonly-token in .../command-center/data)
```

### Step 5: Find your tokens

The daemon creates three tokens next to the database, in `command-center/data/`:

| File | Who uses it |
|---|---|
| `api-token` | The dashboard and the REST API. This is you. |
| `mcp-token` | Agents with full MCP access. |
| `mcp-readonly-token` | Agents that may only read. |

Each token works on its own routes only. That separation is what stops an agent with an MCP token from using the REST route that switches a rule on. Never commit these files or paste them anywhere public.

### Step 6: Open the dashboard

Open http://127.0.0.1:8788/ in your browser. It opens on My tasks, empty, with a blue strip that says **Not connected yet**. Click **Connect** in that strip (or open http://127.0.0.1:8788/?view=connection) to reach the **Connection** view, where **Server URL** is already filled in. Paste the contents of `command-center/data/api-token` into **Access token** and click **Connect**. Then go back to **My tasks** (in the sidebar on a computer, or through the menu button at the top left on a phone).

**You should now see** My tasks, with the task you added in step 3.

### Step 7: Keep it running

You want the daemon to start on its own when the host starts.

**Windows.** Install the logon task from the `command-center` folder:

```powershell
powershell -ExecutionPolicy Bypass -File ..\scripts\install-command-center-task.ps1
```

It runs the daemon as you while you are logged on, and writes its output to `command-center/data/daemon.log`. The same script with `-Uninstall` removes it. There is also a Windows desktop app in [desktop/](../desktop/) that starts the daemon for you.

**Linux.** Use a systemd unit. Polaris does not ship one, so here is a minimal example. Change the user and paths to match yours:

```ini
# /etc/systemd/system/polaris.service
[Unit]
Description=Polaris task tracker daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=you
WorkingDirectory=/home/you/polaris
ExecStart=/usr/bin/node command-center/src/cli.ts daemon
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now polaris
journalctl -u polaris -f
```

Settings go in as `Environment=NAME=value` lines under `[Service]`. Do not add `--host`: the daemon defaults to 127.0.0.1, and that is where it should stay.

**You should now see**, after a restart of the host, the dashboard answering at http://127.0.0.1:8788/ without you starting anything.

## 3. Your first ten minutes

On a computer, the sidebar on the left lists every view: **My tasks**, **Inbox**, **Board**, **Goals**, **Projects**, **Threads**, **Rules**, **Digest**, **GitHub**, and **Connection**, which holds your connection and settings. On a phone there is no sidebar. The menu button at the top left (**Open navigation**) opens a drawer with **My tasks**, **Inbox**, and **Board**; **More** in the drawer (or **More views** in the bar along the bottom) adds **Goals**, **Projects**, **Threads**, **Rules**, **Digest**, and **GitHub**. **Connection** is in the drawer too. Later steps say "open **X**": click it in the sidebar, or on a phone reach it through **More**.

### Step 1: Make a project

Open **Projects** (on a phone: **More**, then **Projects**) and click **New project**. A project needs only a name. A GitHub repo is optional, so a project can hold work that has nothing to do with code.

Projects are never deleted. Archiving one hides it and keeps its tasks.

**You should now see** your project in the list.

### Step 2: Add a few tasks

On **My tasks**, click **New task**, give it a name, and pick your project. Add two or three more. Click a task to open its panel, where you can set its due date, priority, status, notes, recurrence, and assignee, comment on it, and see its subtasks and anything blocking it.

The toolbar filters by readiness (Ready: could be started now; Blocked: waiting on an unfinished task), project, goal, priority, source, and assignee. You can also click a row's due date, project, or priority to change it in place.

**You should now see** your tasks in My tasks, and the same list from `npm run cc -- ls`. A change made in one place shows up in the other within about ten seconds.

### Step 3: Look at the views

- **Board** shows one project at a time, with its sections as columns, and lets you move tasks between them.
- `npm run cc -- views` lists the saved views, and `npm run cc -- view ready` shows what you could start right now.

### Step 4: Understand the inbox

The inbox is where Polaris puts work it found but did not write itself: issues assigned to you on GitHub, review requests, and the like. Nothing in the inbox is a real task until you **Accept** it (and choose its project, due date, and priority) or **Reject** it. Agents can only propose. This is the rule Polaris calls "propose, do not act".

Your inbox is empty until you connect GitHub in section 6.

### Step 5: Set a goal

Open **Goals** (on a phone: **More**, then **Goals**) and click **Add goal**. Give it a title and, if you like, a period such as this quarter.

- **Progress** is counted for you, from tasks you link to the goal and the milestones of projects you link.
- **Status** (on track, at risk, off track, achieved, dropped) is yours alone. Polaris never computes it, and agents set it only when you ask them to.

A goal with nothing open that could move it, or whose status you have not updated in 14 days, is flagged as needing attention, here and in the daily digest.

**You should now see** your goal, with progress at zero until you link work to it.

### Step 6: Meet rules

Open **Rules** (on a phone: **More**, then **Rules**). A rule watches for an event or a schedule and organizes tasks: it can set a field, move a task, add a comment, create a follow-up, or notify you. A rule can never complete, drop, or accept a task.

A rule you create here can start enabled. A rule an agent creates is always saved disabled, and stays that way until you tick **Enabled** yourself (or run `npm run cc -- rules enable <id>`).

**You should now see** the Rules tab, empty for now.

## 4. Your phone and other computers

The daemon only listens on 127.0.0.1. To reach it from your other devices, put [Tailscale](https://tailscale.com/) in front of it. Tailscale gives the host a private HTTPS address that only devices signed in to your own tailnet can reach.

Never expose Polaris to the public internet. Its MCP routes use bearer tokens with no OAuth, so it is built for your own private network only. Do not use Tailscale Funnel, a public tunnel, or `--host 0.0.0.0`.

### Step 1: Serve the daemon on your tailnet

On the host, install Tailscale, sign in, and turn on MagicDNS and HTTPS certificates for your tailnet in the Tailscale admin console. Then:

```sh
tailscale serve --bg 8788
tailscale serve status
```

**You should now see** an address like `https://<host>.<tailnet>.ts.net` that proxies to `http://127.0.0.1:8788`, marked as tailnet only. Open it from another device on your tailnet. The first request can be slow while the certificate is issued.

Always use this HTTPS address, never the host's bare Tailscale IP. The dashboard's offline copy, the installable app, and the Android app all need HTTPS.

### Step 2: Sign in with your Tailscale identity (optional)

Without this, each new device needs the api token pasted once. With it, your Tailscale login stands in for the token on the dashboard. Set `CC_TAILSCALE_LOGIN` to your Tailscale login (the email Tailscale shows) in the daemon's environment and restart it.

It only applies to `/api` requests that arrive through `tailscale serve` on the same machine and carry exactly that login. MCP clients still need their tokens. [tailscale-identity.md](tailscale-identity.md) explains what this trusts.

**You should now see** the dashboard connect from your phone without asking for a token, and the daemon log a line that starts "Dashboard sign-in through Tailscale for".

### Step 3: Install the dashboard as an app

Open the tailnet address in Chrome or Edge and install it: on a phone, **Add to Home screen** or **Install app** from the browser menu; on a computer, the install icon in the address bar. It opens in its own window, and on a phone you can share text or a link from another app into a new task.

Pick one address, the tailnet one, and use it on every device, including the host. The browser keeps the offline copy and queued edits separately for each address.

### Step 4: The Android app (optional)

[mobile/](../mobile/README.md) builds an Android app around the same dashboard. It adds a share target and optional due-date reminders that are scheduled on the phone. Inside the app every request is cross-origin, so the daemon needs:

```
CC_CORS_ORIGINS=https://localhost
```

On first launch, type the tailnet address and connect.

### How offline works

Every device keeps a copy of what it has read. When the host cannot be reached, the dashboard opens on that copy and a banner says "Offline. Showing data from 14:02." Task edits (create, edit, complete, reopen, move, comment) are saved on the device and sent when the host is back. Inbox decisions, rules, goals, projects, and GitHub switches are disabled until then. If the same field was changed in two places, the newer edit wins and the other value goes into the task's history.

### The second-database trap

Only the host should ever open the database. On every other computer, use a browser and MCP over HTTPS, and nothing else:

- The desktop app always starts its own daemon with its own local database.
- `npm run cc` and the stdio MCP server open `command-center/data/constellation.db` (or `CC_DB`) on the machine they run on.

Run any of those on a second computer and you get a second, empty Polaris that never syncs with the first.

## 5. Connecting Claude

### Step 1: Add Polaris to Claude Code

On each computer where you use Claude Code, add Polaris once at user scope, so every session on that computer has it. Use the host's tailnet address (or `http://127.0.0.1:8788` on the host itself), the contents of `mcp-token`, and a name for that computer:

```sh
claude mcp add --scope user --transport http polaris https://<host>.<tailnet>.ts.net/mcp \
  --header "Authorization: Bearer <mcp-token>" \
  --header "X-Agent-Name: claude-laptop"
```

`X-Agent-Name` is the name recorded beside everything that session writes, so a task's history says which computer did what. It is self-declared, 1 to 40 letters, digits, spaces, hyphens, underscores, or periods, starting with a letter or digit. Any other character (an `@`, for example) makes the daemon drop the name without an error, and that session's writes are recorded with no name.

For an agent that should only read, use `/mcp/readonly` with `mcp-readonly-token` instead.

**You should now see** `polaris` in `claude mcp list`, and in a Claude Code session, asking "what are my open Polaris tasks?" lists them.

### Step 2: What an agent may and may not do

Over MCP an agent can search and read tasks, create and edit tasks and comments, create projects and goals, propose rules, and post to task threads. It cannot enable a rule, set a goal's status unless you ask, rename or archive a project, delete anything, or write to GitHub. Anything that came from a third party is labeled `UNTRUSTED-TEXT`, and agents are told to treat it as data. `npm run cc -- mcp tools` prints the full list.

### Step 3: Hand a task to Claude

Open a task and use **Hand off to Claude Code**, then **Copy prompt for Claude Code**. The prompt carries the task, its project and repo, the Polaris task id, and how to report back. Paste it into a Claude Code session in the project's folder. With Polaris connected, the agent:

1. reads the task with `get_task`,
2. claims it, setting itself as assignee and the status to in progress,
3. writes what it did as a comment,
4. completes the task, or sets it to waiting with a question for you,
5. files out-of-scope work it notices as new tasks.

Text from a third party is wrapped in a warning inside the prompt, so the agent treats it as data.

**You should now see** the agent's comments and status changes on the task, under the name you gave it in step 1 (`claude-laptop` in the example).

### Step 4: Assign to AI

The task panel's **Assign to <name>** button sets the task's assignee to your default agent name in one click, and **Take back** clears it. It starts nothing by itself: an agent connected under that name finds the task when it looks for its work. Set the default name in the **Agents** card on the **Connection** tab. It starts as `claude-code`; to match the computer you set up in step 1, make it the same `X-Agent-Name` (`claude-laptop` in the example). The same character rules apply.

### Step 5: Work from your phone with Remote Control

Claude Code's Remote Control lets you start and steer sessions on a computer from claude.ai/code or the Claude mobile app. On the computer that has your project:

```sh
cd /path/to/your/project
claude remote-control --spawn worktree
```

Remote Control pre-creates one session in the project folder itself when it starts, so you have somewhere to type right away. `--spawn worktree` gives each further session you start from your phone its own git worktree. Then, on your phone: copy a task's prompt in Polaris, open the Claude app, pick that computer, start a new session rather than the pre-created one, and paste. Because Polaris is set up at user scope on that computer (step 1), the session reports back on the task as above.

### Threads

For a hard problem, agents and you can work it out in a task's thread: short typed posts such as claim, evidence, objection, question, and result. A post never changes the task. Only you decide which claims stand, pin a summary, or close the thread. The **Threads** view (under **More** on a phone) shows them all. [agent-threads-proposal.md](agent-threads-proposal.md) has the design.

## 6. GitHub (optional)

Polaris can pull your GitHub work in, read-only. It uses a GitHub App you create yourself, which can only read the repos you pick. It never writes to GitHub, and it never uses a personal access token or your `gh` login, because those can write to every repo you can.

### Step 1: Open the GitHub page in the right browser

GitHub sends each step of the setup back to `http://127.0.0.1:<port>`, so do it in a browser where that address is the daemon:

- On the host itself, open http://127.0.0.1:8788/.
- From another computer, tunnel the port first, then open http://127.0.0.1:8788/ there:

  ```sh
  ssh -L 8788:127.0.0.1:8788 <host>
  ```

  Port 8788 must be free on that computer while you do this.

Starting from the tailnet address on your phone will not work for this one step.

### Step 2: Create, install, sign in

Open **GitHub** (on a phone: **More**, then **GitHub**) and follow its three steps:

1. **Create app.** GitHub opens with a read-only app filled in. Click Create GitHub App.
2. **Install on GitHub.** Install it on your account (and any organization), choose Only select repositories, and tick the repos Polaris may read.
3. **Sign in with GitHub.** Approve, then close the tab.

**You should now see** the GitHub page list the repos the app can read.

### Step 3: Track repos

Each repo has three switches:

- **Track as project** creates a project for the repo. Turning it off archives the project and keeps its tasks.
- **Sync issues and PRs** brings in issues assigned to you, review requests, your PRs with failing checks or requested changes, and new issues in tracked repos.
- **Read checklists** turns the checkboxes in the repo's todo file, README.md, CLAUDE.md, and top-level docs/*.md into tasks, read over the GitHub API.

GitHub items land in the **Inbox**, marked as third-party text, and stay there until you accept or reject them. Checklist items are your own writing, so they become open tasks.

**You should now see**, within 15 minutes (or after `npm run cc -- sync github`), issues assigned to you in the Inbox, not in My tasks. `npm run cc -- github status` shows the connection.

## 7. Backups

The daemon makes a checked copy of the database every day at 03:15 (`CC_BACKUP_AT`), and at start when the last copy is more than a day old. It keeps the newest 14 (`CC_BACKUP_KEEP`).

### Step 1: Send backups to another disk

By default copies go to `command-center/data/backups`, on the same disk as the database, which only protects you from a bad write. Point `CC_BACKUP_DIR` at another disk, a NAS, or another machine, and restart the daemon. On Windows, use a UNC path (`\\server\share\folder`) rather than a mapped drive letter.

Never point two Polaris hosts at the same backup folder: each replaces that day's copy.

### Step 2: Run the restore drill

```sh
npm run cc -- backup check
```

It reads the newest copy back and checks it, without opening your live database, so it also works on a recovery machine.

**You should now see** the check pass.

### Step 3: Encryption (your choice)

Backups are not encrypted until you set a passphrase, from the **Backups** card on the **Connection** tab or with `npm run cc -- backup encrypt`. Polaris never sets one for you. Keep the passphrase in a password manager: without it, no encrypted copy can be read. `npm run cc -- backup decrypt <file.db.enc>` turns a copy back into a plain database.

### When a backup fails

A failing job, or a backup that is missing or more than 36 hours old, shows as a red strip under the dashboard's top bar. The Digest tab has the details.

## 8. Updating and troubleshooting

### Updating

Stop the daemon, update, rebuild, and start it again:

```sh
git pull --ff-only
npm install
npm --prefix command-center install
npm run build
```

Then restart: `sudo systemctl restart polaris` on Linux, or stop and start the logon task on Windows. If the update changes `command-center/src/core/schema.ts`, copy `command-center/data/constellation.db` somewhere safe first. Migrations run when the database is opened.

### Troubleshooting

| What you see | What it means | What to do |
|---|---|---|
| A red strip under the top bar | A scheduled job failed, or the backup is missing or stale | Open the Digest tab for details. For backups, check that `CC_BACKUP_DIR` is reachable, then run `npm run cc -- sync backup`. |
| "skipped: Not signed in to GitHub" in the log | The GitHub App is not connected | Expected until you finish section 6. It is recorded as skipped, not as a failure. |
| The daemon exits with `EADDRINUSE` | An old daemon still holds the port | Wait for it to stop, then start again. |
| The service will not start at boot | Usually something it depends on is not ready yet, such as a network share for backups | Read `journalctl -u polaris -b`. Do not make the service require a network mount: a failed mount should fail the backup job, not Polaris. |
| "Offline. Showing data from ..." | The dashboard cannot reach the daemon | Check the daemon is running and, from another device, that `tailscale serve status` still shows the proxy. Your task edits are queued meanwhile. |
| **Connect** fails on the Connection view, or the "Not connected yet" strip stays | The token was refused | Paste the current `api-token`, or check `CC_TAILSCALE_LOGIN` matches your Tailscale login exactly. |
| An empty Polaris on a second computer | The desktop app, `npm run cc`, or stdio MCP was run there and made its own database | Use the browser and MCP over HTTPS on that computer instead. See the second-database trap in section 4. |
| The Android app cannot connect | The daemon does not allow the app's origin | Set `CC_CORS_ORIGINS=https://localhost` and restart. Use the HTTPS tailnet address. |

## 9. Where to go next

- [README.md](../README.md): what Polaris is for, the agent model, and known limitations.
- [command-center/README.md](../command-center/README.md): every source, job, setting, and the safety model in full.
- [command-center/src/http/README.md](../command-center/src/http/README.md): the REST API and MCP over HTTP.
- [decision-maps.md](decision-maps.md): running a large piece of work with an agent as a map of decisions.
- [tailscale-identity.md](tailscale-identity.md): signing in with your Tailscale identity, and what it trusts.
- [agent-threads-proposal.md](agent-threads-proposal.md): how threads work.
- [mobile/README.md](../mobile/README.md): building and installing the Android app.
- [SECURITY.md](../SECURITY.md): reporting a vulnerability, and the security model.
- [CONTRIBUTING.md](../CONTRIBUTING.md): changing Polaris itself.

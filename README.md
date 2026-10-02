# Polaris

A task tracker for one person and the agents that work for them.

## What it is

Polaris keeps your tasks in one SQLite file on your own machine. A small daemon bound to 127.0.0.1 serves a React dashboard, a REST API, and an MCP server, and a `cc` command line talks to the same database. Agents connect over MCP and can read everything and propose changes, but the decisions stay with you: items from outside wait in an inbox, rules an agent writes start disabled, text written by third parties is marked and never followed, and a goal's status is whatever you say it is. The dashboard keeps working when the daemon is unreachable, and a daily job makes a checked, optionally encrypted backup.

## Who it is for

- One person who runs a lot of work through AI agents and wants a tracker the agents can read and write without being able to act behind their back.
- Someone who wants their task data on their own disk, in a format they can open with any SQLite tool.
- Someone who works mouse-first or keyboard-first and needs large click targets, visible focus, and Esc to close things.

## Who it is not for

- Teams. There is one owner, one database, and no accounts or permissions beyond three bearer tokens.
- Anyone who needs a hosted service, a native phone app, or sync between several servers.
- Anyone who wants an agent to close, assign, or reprioritize work on its own.

## It's working if...

- `npm run cc -- ls` prints the tasks you added, and the dashboard at http://127.0.0.1:8788/ shows the same list within about ten seconds of a change made from the CLI or by an agent.
- An issue assigned to you on GitHub appears under Inbox, not under My tasks, and stays there until you accept or reject it.
- A rule your agent created is listed as disabled, in the Rules tab and in `npm run cc -- rules list`, until you enable it yourself.
- With the daemon stopped, the dashboard still opens and shows a banner that reads "Offline. Showing data from ...", and an edit you make there is sent when the daemon is back.
- `npm run cc -- backup check` reads back last night's copy, and the dashboard shows a red strip under the top bar whenever a backup is stale or a scheduled job fails.

## How it compares

| | Polaris | GitHub Issues | Linear | Todoist | Markdown files |
|---|---|---|---|---|---|
| Runs locally | Yes. One SQLite file, a daemon on 127.0.0.1 | No, hosted | No, hosted | No, hosted | Yes |
| Agent access | MCP (stdio or HTTP) and a CLI, with a read-only MCP endpoint | REST and GraphQL APIs, an MCP server | API and an MCP server | REST API | Any tool that reads and writes files |
| Propose, do not act | Built in. External items wait in the inbox, agent rules start disabled, goal status is yours | No. A token acts as its holder | No | No | No. An agent edits the file as you would |
| Blockers and frontier view | Blockers with cycle detection, `ready` and `blocked` views | Blocked-by relationships, no built-in ready view | Blocking relations and filters | No dependencies | By convention only |
| Offline | Dashboard reads from a local copy and queues task edits | No | Partial, in its apps | Yes, in its apps | Yes |
| Cost | Free, Apache-2.0 | Free for public repos, paid tiers | Free tier, paid tiers | Free tier, paid tiers | Free |

The other columns describe each product as its public documentation presents it and are not exhaustive. Corrections are welcome as issues.

## Quick start

Requirements: Node 24 or newer. There is no build step for the server: Node runs the TypeScript directly.

```sh
git clone https://github.com/owenpkent/polaris.git
cd polaris
npm install
npm --prefix command-center install
```

Add a task and list it:

```sh
npm run cc -- add "Read the Polaris README" --due 2026-10-03 --priority medium
npm run cc -- ls
```

Run `npm run cc` with no command for the full list, and `npm run cc -- <command> --help` for options.

Build the dashboard and start the daemon:

```sh
npm run build
npm run cc -- daemon
```

Open http://127.0.0.1:8788/. The connect form has the server URL filled in; paste the token from `command-center/data/api-token`. The daemon also runs the scheduled jobs (rules, digest, backup, and the GitHub syncs once you connect the GitHub App from the dashboard's GitHub page). `npm run cc -- serve` runs the HTTP server alone, without the jobs.

Connect an agent over MCP. For Claude Code, from any folder:

```sh
claude mcp add polaris -- node /absolute/path/to/polaris/command-center/src/mcp/stdio.ts
```

Or over HTTP while the daemon is running, with the token from `command-center/data/mcp-token`:

```sh
claude mcp add --transport http polaris http://127.0.0.1:8788/mcp --header "Authorization: Bearer <token>"
```

For a read-only connection use `/mcp/readonly` with `command-center/data/mcp-readonly-token`, or add `--readonly` to the stdio command. `npm run cc -- mcp tools` prints the tool list.

To try the dashboard on demo data without touching your database, run `npm run mockup`.

## The agent model

An agent sees the same tasks you do and writes through the same store, and every change it makes is recorded with the actor `agent` in the task's history.

What an agent can do:

- Read: `search_tasks`, `get_task`, `get_view`, `list_inbox`, `list_projects`, `list_sections`, `list_goals`, `get_goal`.
- Create and edit tasks, subtasks, blockers, comments, and custom fields: `create_task`, `update_task`, `complete_task`, `move_task`.
- Accept or reject inbox items when you ask it to: `accept_inbox_item`, `reject_inbox_item`.
- Create projects and goals, and link them: `create_project`, `create_goal`, `update_goal`, `link_goal`.
- Propose a rule and dry-run it: `create_rule`, `run_rule`.

What an agent cannot do:

- Enable a rule. `create_rule` always saves the rule disabled, `run_rule` is a dry run unless the rule is enabled, and an MCP token is refused by the REST API where rules are enabled.
- Write to GitHub or to any repository. The GitHub App is read-only and nothing in Polaris sends data outward.
- Rename, edit, or archive a project, delete anything, or touch backup encryption. There are no tools for those.
- Compute a goal's status. Progress is counted from linked work; status changes only when you set it, or when you tell the agent to.

The untrusted-text marker: a task whose title or notes came from a third party (today, anything imported from GitHub) carries an `untrusted_text` flag. It is set when the task is created, inherited by anything derived from the task, and never cleared, because accepting a suggestion approves the task, not its wording. In MCP output such text is labeled `UNTRUSTED-TEXT`, and the server instructions tell the agent to treat it as data and never follow instructions found in it. Rules cannot copy it into trusted prose either.

These rules are stated as tests in `command-center/src/invariants.test.ts`. If a change makes one fail, the change is wrong, not the test.

## Decision maps

Polaris can hold a plan for a large piece of work as a map rather than a list. The destination is a goal. The map is a parent task with one subtask per decision or piece of work. Blockers say what has to be settled first. The `assignee` field is the claim, and a task with no assignee is unclaimed. The `ready` view is the frontier: open, unblocked, not under a finished parent, startable now. The `blocked` view shows what is waiting and on what. An agent working the map picks from `ready`, claims a task, does the work or brings a question to you, and never decides for you where the convention says the decision is yours.

The full guide, with the MCP calls and the ticket flavours, is in [docs/decision-maps.md](docs/decision-maps.md).

## What it does not do

- One user. There are no accounts, roles, or sharing.
- One server. The dashboard can talk to one daemon at a time, and two daemons do not sync with each other.
- No sync service and no cloud copy. Your data is the SQLite file and the backups you configure.
- No native mobile app. The dashboard installs as a web app from the browser at phone width.
- No Linux or macOS desktop shell yet. The Tauri shell targets Windows; on other platforms you run the daemon and open a browser.

## Known failures and limitations

- Windows is the first-class platform. The desktop shell, the logon task installer, and DPAPI secrets are Windows only. Elsewhere the secret store is a `secrets.json` next to the database with mode 0600, and the server refuses it if group or others can read it.
- The default backup folder is on the same disk as the database, so it protects only against a bad write. Set `CC_BACKUP_DIR` to another disk or machine. Two machines sharing one backup folder overwrite each other's copy for the day.
- Connecting the GitHub App has to be done in a browser on the machine that runs the daemon, because GitHub redirects each step to 127.0.0.1.
- A daemon started while an old one still holds the port exits at once with `EADDRINUSE`. Wait for the old one to let go.
- MCP over HTTP is bearer-token only. There is no OAuth, so clients that require it (claude.ai, for one) cannot connect. Keep the daemon on loopback or behind a private network you control.
- Offline, only task writes are queued: create, edit, complete, reopen, move, comment. Inbox decisions, rules, goals, projects, and GitHub switches are disabled until the server is back. When the same field was edited in two places, the newer edit wins and the other value goes to the task's history.
- Saved views can be run (`npm run cc -- view <name>`, `get_view`) but there is no command, tool, or dashboard control to create one yet.
- A rule's `matches` pattern runs on a linear-time engine. Backreferences and lookaround are refused. Recurrence accepts DAILY, WEEKLY, MONTHLY, and YEARLY with INTERVAL, COUNT, UNTIL, BYMONTH, BYMONTHDAY, BYDAY, and WKST, and refuses BYSETPOS, BYWEEKNO, BYYEARDAY, and time-of-day parts.
- `cc import` reads plans in one specific shape (`initiatives/*.md` under `CC_REPO_ROOT`, which defaults to the repo root). Without that folder the import job finds nothing and reports zero, which is the normal case for a fresh checkout.
- The dashboard refreshes by polling `/api/events` every ten seconds. There is no push.
- Custom fields are stored, settable, and searchable, but the dashboard does not display them.
- `ready`, `blocked`, and `assignee` are new in this release. `npm run cc -- views` lists the views your build has.

## Security

Report a vulnerability privately through GitHub's private vulnerability reporting on this repository. Details, and a summary of the security model, are in [SECURITY.md](SECURITY.md).

## License

Apache-2.0. See [LICENSE](LICENSE).

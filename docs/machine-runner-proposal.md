# Machine runners: proposal

Status: proposal, 2026-10-06, awaiting the owner's approval. Nothing here is built. This is Stage 2 of docs/assign-to-ai-options.md (the `cc dispatch` idea, option 2B), reshaped for several machines: the daemon now lives on GR9, an always-on Linux host behind `tailscale serve`, and the owner's working clones live on the other computers where the owner writes code.

This document proposes a small program, the runner, that runs on each computer the owner chooses. It asks Polaris for tasks assigned to that computer, starts Claude Code there in the computer's own copy of the project, and reports back on the task. A second, later feature lets the runner read checklist files from that computer's clones. Each change it makes to the project rules is listed at the end for the owner to approve one by one.

## Where things stand

- Stage 1 of the assign doc is merged (PR #2). "Assign to AI" sets `assignee` to the owner's default agent name through the ordinary task patch, so it works offline as an outbox op. The agent pulls: a Claude Code session the owner started finds tasks with its name over MCP and writes its own comments and status. Nothing starts the session. Inbox tasks and tasks with `untrusted_text` are kept off the button.
- An MCP connection can declare a name (`--agent-name` over stdio, `X-Agent-Name` over HTTP). It rides beside the actor as `actor_name` (migration 7). It is self-declared, not an identity.
- The daemon runs on GR9 from the `polaris-server` checkout, bound to 127.0.0.1:8788, reached by every other device at https://owen-gr9.tail220e4e.ts.net through `tailscale serve`. GR9 holds no working clones of the owner's projects.
- The daemon never starts a program and nothing reads a local clone or path. Both are in CLAUDE.md, and reading a local path is on the "When to ask" list.
- Three bearer tokens, one per trust boundary: api, mcp, mcp-readonly. Tailscale identity stands in for the api token on `/api` only.
- `npm run cc` and the stdio MCP server open a local database when run on a machine other than the host, which creates a second, empty Polaris (polaris-admin's multi-device review, trap 2).

Claude Code 2.1.292, as installed on GR9, has the flags this needs: `--bg` starts a background session and prints its id, `-p` runs one prompt non-interactively, `--session-id <uuid>` fixes the id ahead of time, `-w`/`--worktree` makes a fresh git worktree, `--permission-mode acceptEdits` allows file edits, `--permission-prompts none` denies anything that would otherwise prompt, `--max-budget-usd` caps spend, and `--mcp-config` with `--strict-mcp-config` loads only the MCP servers given. `claude agents`, `attach`, `logs`, `stop`, and `rm` take the session id. (The assign doc's `--permission-prompt-tool none` is not a flag in this version; `--permission-prompts none` is.)

## The shape

```
  laptop                                 GR9
  +---------------------------+          +------------------------------+
  | cc runner (name: laptop)  |  HTTPS   | tailscale serve              |
  |   polls /runner/* --------+--------->|   -> 127.0.0.1:8788 daemon   |
  |   starts claude --bg      | tailnet  |   one SQLite database        |
  |   in ~/dev/<project>      |          |   never starts a program     |
  +---------------------------+          +------------------------------+
  desktop: cc runner (name: desktop), same shape
```

- The runner calls Polaris. Polaris never calls the runner. The runner opens no port.
- Everything that gives the runner power on its machine lives on that machine: which projects it may work, the folder for each, the spending cap, and the Claude Code flags. Polaris has no field for any of them, so a stolen Polaris token cannot widen what a runner does.
- The runner talks to Polaris over HTTP only and never opens a store, the same way `cc backup check` never does. Running it on a laptop does not create a second database.

## 1. What a runner is

### 1A. A `cc runner` command (recommended)

A new command under command-center/src/runner, started with `npm run cc -- runner` on each machine that should do work. It reads a config file on that machine, polls Polaris every 30 seconds, and keeps going until stopped.

- Buys: same language and repo as the rest of Polaris, so it can share the HTTP client, the secret store (DPAPI on Windows, a 0600 file elsewhere), and the tests. Each development machine already has a clone of polaris.
- Costs: Node 24 and a polaris clone on every runner machine. One more long-running process for the owner to install per machine.

### 1B. A standalone script

A small shell or PowerShell script per machine that curls Polaris and starts `claude`.

- Buys: nothing to install beyond Claude Code.
- Costs: two scripts to keep in step, no tests, token handling by hand. Hard to state invariants about.

### 1C. Anchor

Anchor's Polaris channel (the assign doc's Stage 3) does this job with approvals and an audit log.

- Buys: approvals, policy, hash-chained audit.
- Costs: Anchor has not passed its M0 checks. This proposal keeps the runner's protocol close to the assign doc's option 7A (the runtime polls Polaris), so Anchor can speak the same routes later and replace the runner's insides.

## 2. How a task reaches a machine

### 2A. The assignee names the machine (recommended)

Each runner has a name the owner chose when registering it, such as `laptop`, `desktop`, or `gr9`. Assigning a task to "Claude on laptop" sets `assignee` to `claude@laptop` through the existing task patch. The runner asks for tasks whose assignee is its own `claude@<name>`.

- Buys: no change to what `assignee` means: it stays a plain name. Assigning works offline because it is already an outbox op, and the runner sees it once the edit reaches the server. The pull model from Stage 1 is unchanged; a runner is just an agent that is always on.
- Costs: the name is a string convention. A typed assignee of `claude@laptop` would also reach the runner, which is the intended behaviour, since only the owner and agents can set an assignee.

### 2B. A dispatch route with a target machine

A live-only route that records the target runner beside the task.

- Buys: an explicit record of the dispatch.
- Costs: either a new offline op kind (forbidden without asking) or a control disabled offline. Duplicates what `assignee` already carries.

## 3. What the runner does with a task

1. Heartbeat: `POST /runner/heartbeat` with its version and the projects in its config. Polaris records last seen.
2. Ask: `GET /runner/tasks` returns open tasks assigned to `claude@<name>`, in projects the runner listed, never in the inbox, never with `untrusted_text`. The server filters; the runner checks again.
3. Claim: `POST /runner/runs` with the task id and a session id the runner minted. This records a run (section 5) and sets the task to in progress. A second claim of the same task while a run is open is refused.
4. Start, in the project's folder from the machine config:

   ```sh
   claude --bg -p "<brief>" --session-id <uuid> -w polaris-<task id> \
     --permission-mode acceptEdits --permission-prompts none \
     --max-budget-usd <cap from machine config> \
     --mcp-config <polaris over https, mcp token, X-Agent-Name claude@laptop> --strict-mcp-config
   ```

   The brief is built the same way the Hand off menu builds it today. The session gets the Polaris MCP server and nothing else, so it reads the task, comments, and sets status over MCP as Stage 1 agents do, under the name `claude@laptop`.
5. Watch: the runner checks the session with `claude agents` on its own machine. When the session ends it posts the outcome to `POST /runner/runs/:id` (finished, failed, stopped, lost, and the spend if Claude Code reports it), and Polaris adds a comment on the task: what ran, where, for how long, and `claude logs <id>` on which machine for the full transcript.
6. Stuck: anything that would prompt is denied, so the agent cannot wait forever on an approval. Its instructions say to set the task to `waiting` with a comment saying what it needed. A run that hits the budget cap ends, and the comment says so.

The work stays on the machine, in the worktree, on a local branch. Pushing would need a command the permission mode does not allow, so it is denied. The owner reviews the branch and pushes it themselves.

## 4. The Assign menu

- The button becomes a menu: "Assign to <default name>" as today (a session the owner runs pulls it), then one item per registered runner: "Claude on laptop, seen 2 min ago".
- A runner not seen for more than 2 minutes reads "Claude on laptop, offline since 14:05". It can still be chosen; the task waits until the machine is back.
- An assigned task shows a chip "Claude on laptop" with "Take back", which clears the assignee as today. If a run is open, Take back also asks the runner to stop it on its next poll.
- An open run shows its state on the task panel: started at, machine, session id, and the latest outcome.
- Inbox tasks and tasks with `untrusted_text` stay off the menu, as they are off the button now, and the server refuses to hand them to a runner whatever the assignee says.
- 44px targets, a visible focus ring, a keyboard path, Esc closes the menu. A new shots state for the open menu.

## 5. What Polaris stores

An additive migration with two new tables and no change to an existing column:

- `runners`: name, a hash of its token, created at, last seen at, last reported version and project list, revoked at.
- `runs`: task id, runner name, Claude Code session id, started at, ended at, outcome, spend in dollars when known.

The machine's folders, budget, and flags are not stored. A run with no heartbeat for 10 minutes is shown as "not heard from", not failed: a sleeping laptop is not a broken one.

## 6. The runner token

A fourth kind of token, one per runner, created when the owner registers a machine (`cc runner add laptop` on the host, or a Runners card on the Settings tab) and shown once. The owner revokes it the same way. The runner keeps it in its machine's secret store.

The token is accepted on `/runner/*` only, and nothing else is accepted there. With it a runner may:

- send a heartbeat,
- read open tasks assigned to its own `claude@<name>` in the projects it reported,
- open, update, and close runs on those tasks,
- set a task's status to in progress when claiming, and add the run's outcome comment.

It may not accept or reject an inbox item, create or enable a rule, set a goal's status, use any owner thread control, create or edit a project, read tasks assigned to anyone else, or change an assignee. Writes through it are recorded as the `agent` actor with the runner's name as `actor_name`, so the four actors stay as they are. Unlike an MCP agent name, this name is authenticated: the server takes it from the token, not from a header.

Tailscale identity does not apply to `/runner/*`, as it does not apply to `/mcp`.

## 7. Local checklists (a later phase)

Today the `repo-files` job reads each tracked repo's todo file, README.md, CLAUDE.md, and docs/*.md over the GitHub API. The owner asked whether Polaris could read local repos instead.

### 7A. The daemon reads clones on GR9 (rejected)

- It only sees GR9's disk, and the owner's working clones are on other machines. GR9 would need its own clones of every project.
- Keeping them current needs `git pull`, which needs a git credential on GR9. A normal SSH key can push to every repo the owner can, which is the reason a personal token is forbidden. Deploy keys are read-only but one per repo, and still a second GitHub credential, which CLAUDE.md rules out.
- Unpushed work on the laptop would still be invisible, so it would not even buy freshness.
- Issues and PRs are not in a clone, so the GitHub App would still be needed.

### 7B. The runner reads its machine's clones (proposed)

For each project in its config, the runner reads the same files from the local folder and sends them to Polaris, which parses them with the code `repo-files` uses now.

- A project has one checklist source: GitHub, or a named home machine. The owner sets it per project. Two machines with different copies of a repo never fight over its tasks.
- The same care as `repo-files`: the runner confirms the folder exists and is a git repo before reading any file, and reports an unreadable folder instead of reporting its files missing, so a laptop with an unmounted drive does not retire every task. A missing file retires that file's tasks only when the folder itself was readable. A file over 1 MB is skipped and reported.
- Checklist tasks stay the owner's own trusted text, as they are from `repo-files` today.
- Buys: no GitHub credential involved, and the tasks follow unpushed edits on the home machine.
- Costs: the tasks only change while the home machine's runner is running. A second parser path to test.

The GitHub App stays for issues and PRs, which land in the inbox as now. Its one-time sign-in is still needed for that.

## 8. Rule changes for the owner to approve

Each is a separate yes or no.

1. **Reading local paths, in the runner only.** CLAUDE.md says nothing ever reads a local clone or path. Proposed: the daemon never does; the runner reads only the folders named in its own machine's config, and only for Claude Code's working folder and (phase C) the checklist files.
2. **Starting a program, in the runner only.** The daemon still never starts a program. The runner starts exactly one, Claude Code, with the flags in section 3, and reads its own machine's `claude agents` list.
3. **A fourth token kind**, one per runner, with the boundary in section 6.
4. **An additive migration**: the `runners` and `runs` tables. No existing column changes meaning; `assignee` stays a plain name.
5. **No new offline op kind.** Assigning uses the existing assignee edit. Registering, revoking, and every `/runner` route are live-only.
6. **New "When to ask" lines**: widening the runner's permission mode past `acceptEdits` or its prompts past `none`; letting a runner push or open a PR; letting Polaris set a runner's folders, budget, or flags; letting the runner read anything outside its configured folders.

## 9. Invariants to add

A new group 11 in command-center/src/invariants.test.ts:

- The runner token is refused on `/api`, `/mcp`, and `/mcp/readonly`, and the api, mcp, and read-only tokens are refused on `/runner`. Tailscale identity opens nothing under `/runner`.
- A runner token reads and writes only tasks assigned to its own `claude@<name>`, and the name comes from the token, never from the request.
- No `/runner` route accepts or rejects an inbox item, creates or enables a rule, sets a goal's status, closes or pins anything in a thread, edits a project, or changes an assignee.
- A task in the inbox or with `untrusted_text` is never returned to a runner and cannot have a run opened on it, by any route.
- A runner's writes are recorded as the `agent` actor with the runner's name, and the four actors are unchanged.
- The schema has no column for a runner's folders, budget, or flags.
- The daemon and the http server do not import `child_process` (a source check, as group 8 checks the fake GitHub).
- The `runner` command never opens a store.
- Run events are not rule triggers, and rules have no run action.
- The outbox has no runner or run op kind.

## 10. Phases

- **Phase A: one machine, one run at a time.** `cc runner` with heartbeat, task polling, claim, start, and outcome. The `runners` and `runs` tables, the runner token, the Assign menu with runners, the run line on the task panel. Group 11.
- **Phase B: liveness and spend.** Reconciling after a reboot (an open run whose session is gone becomes "lost" with a comment), spend on runs when Claude Code reports it, a daily cap per runner in the machine config, Take back stopping a run.
- **Phase C: local checklists**, section 7B, with the per-project checklist source.
- **Later:** Anchor speaks the `/runner` protocol and brings approvals (the assign doc's Stage 3).

## Open questions

- Installing the runner: a logon task on Windows (the daemon's installer in scripts/ is a model) and a systemd user unit on Linux. Does the owner's main development machine run Windows or Linux?
- Transcripts. The outcome comment plus `claude logs <id>` on the named machine is the proposal. A long run may deserve a short summary the agent writes before it ends. A thread is for argument, not transcripts.
- Spend. Does Claude Code report a background session's cost anywhere the runner can read after the fact? If not, Phase B records the cap instead of the actual spend.
- Sleep. GR9 does not sleep; laptops do. A background session on a sleeping laptop pauses and resumes. How long before an open run is shown as "not heard from" (10 minutes is the guess), and should a task come back to the owner after a day with no heartbeat?
- Should GR9 itself run a runner? It holds no working clones today, only the deploy checkout, which must never be worked in.
- Worktree cleanup: Claude Code removes a `-w` worktree when that is safe. A run that made changes leaves its worktree and branch for the owner. How does the owner find them: the outcome comment names the branch and folder.

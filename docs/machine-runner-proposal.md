# Machine runners: proposal

Status: proposal, 2026-10-06, awaiting the owner's approval; revised the same day to make security a requirement (section 6). Nothing here is built. This is Stage 2 of docs/assign-to-ai-options.md (the `cc dispatch` idea, option 2B), reshaped for several machines: the daemon now lives on GR9, an always-on Linux host behind `tailscale serve`, and the owner's working clones live on the other computers where the owner writes code.

This document proposes a small program, the runner, that runs on each computer the owner chooses. It asks Polaris for work the owner has dispatched to that computer, starts Claude Code there in the computer's own copy of the project, and reports back on the task. A second, later feature lets the runner read checklist files from that computer's clones. Each change it makes to the project rules is listed at the end for the owner to approve one by one.

Security is a requirement, not a phase. A runner turns text in Polaris into an agent acting on a real computer, so section 6 sets out who could try to misuse it and what stops each of them, and every other section follows from it. Three rules carry most of the weight:

1. **Only the owner starts a run.** A run exists only after the owner dispatches it in a live click. No agent, rule, token other than the owner's, or offline replay can start one.
2. **The session can edit files in one worktree and nothing else.** Claude Code runs in `--restricted` mode with no shell, no web tools, none of the owner's settings, and a token that reaches one task.
3. **Everything fails closed.** Any doubt at any step (a changed task, a revoked token, an unreadable config, a missing flag) means no run, never a run with less protection.

## Where things stand

- Stage 1 of the assign doc is merged (PR #2). "Assign to AI" sets `assignee` to the owner's default agent name through the ordinary task patch, so it works offline as an outbox op. The agent pulls: a Claude Code session the owner started finds tasks with its name over MCP and writes its own comments and status. Nothing starts the session. Inbox tasks and tasks with `untrusted_text` are kept off the button.
- An MCP connection can declare a name (`--agent-name` over stdio, `X-Agent-Name` over HTTP). It rides beside the actor as `actor_name` (migration 7). It is self-declared, not an identity.
- The daemon runs on GR9 from the `polaris-server` checkout, bound to 127.0.0.1:8788, reached by every other device at https://owen-gr9.tail220e4e.ts.net through `tailscale serve`. GR9 holds no working clones of the owner's projects.
- The daemon never starts a program and nothing reads a local clone or path. Both are in CLAUDE.md, and reading a local path is on the "When to ask" list.
- Three bearer tokens, one per trust boundary: api, mcp, mcp-readonly. Tailscale identity stands in for the api token on `/api` only.
- `npm run cc` and the stdio MCP server open a local database when run on a machine other than the host, which creates a second, empty Polaris (polaris-admin's multi-device review, trap 2).

Claude Code 2.1.292, as installed on GR9, has the flags this needs: `--bg` starts a background session and prints its id, `-p` runs one prompt non-interactively, `--session-id <uuid>` fixes the id ahead of time, `-w`/`--worktree` makes a fresh git worktree, `--permission-mode acceptEdits` allows file edits, `--permission-prompts none` denies anything that would otherwise prompt, `--max-budget-usd` caps spend, and `--mcp-config` with `--strict-mcp-config` loads only the MCP servers given. `claude agents`, `attach`, `logs`, `stop`, and `rm` take the session id. (The assign doc's `--permission-prompt-tool none` is not a flag in this version; `--permission-prompts none` is.)

It also has the flags that lock a session down, which section 3 depends on:

- `--restricted` removes Bash, PowerShell, the REPL, the other code-running tools, and WebFetch unless `--tools` names them; ignores the user, project, and local settings files; confines the file tools to the working directories; refuses `bypassPermissions`; and lets only a person or the configured permission handler approve writes to settings, git, and tool-configuration files.
- `--bare` skips hooks, plugins, auto-memory, keychain reads, and CLAUDE.md discovery. Authentication is then only `ANTHROPIC_API_KEY` or an `apiKeyHelper` given through `--settings`, never the owner's own login.
- `--tools` names the built-in tools the session gets, and `--disallowedTools` denies more on top.

Without these, a background session would load the owner's user settings: their allow rules (a rule such as `Bash(git *)` would let it push), their hooks, their plugins, and their git and `gh` credentials. The first draft of this proposal said pushing "is denied"; with the owner's settings loaded that depends on what the owner has allowed, so it was not true.

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

## 2. How work reaches a machine

### 2A. The assignee names the machine (rejected on security grounds)

The first draft had the runner pick up any task whose `assignee` was `claude@<name>`.

- Buys: no new route, and assigning works offline as an outbox op.
- Costs: anyone who can set an assignee could start an agent on the owner's computer. That includes every MCP agent: an agent can edit a task's title and description and set its assignee over MCP. One agent that read a poisoned page, or one compromised MCP token, could write instructions into a task and dispatch it to the laptop. An offline edit replayed later could also start a run the owner no longer wants. Rejected.

### 2B. An owner-only dispatch (recommended)

A run starts only from `POST /api/tasks/:id/dispatch` with a runner name, which the dashboard's "Run on" menu calls (section 4).

- The route requires the human actor in the store: the api token or the owner's Tailscale identity. The MCP tokens, the runner tokens, rules, and the outbox cannot reach it. There is no MCP tool, no rule action, and no offline op kind for it, and the control is disabled offline, like an inbox decision.
- It refuses a task in the inbox, a task with `untrusted_text`, a task in a project the runner did not report, a revoked runner, and a task that already has an open run.
- It freezes the brief at that moment (section 3) and stores it on the run with its SHA-256. The runner works from the frozen brief, never from the live task, so an edit made after the click cannot change what the agent is told.
- It also sets the assignee to `claude@<name>` so the task shows who has it, but the assignee is only a label. Setting it by any other path starts nothing.

- Buys: one decision point, made by the owner, live, with the exact text recorded.
- Costs: dispatching needs the server reachable. A task cannot be dispatched from a phone that is offline.

## 3. What the runner does with a run

1. Heartbeat: `POST /runner/heartbeat` with its version and the projects in its config. Polaris records last seen.
2. Ask: `GET /runner/runs` returns runs in `queued` state for this runner only. The runner's name comes from its token.
3. Check, and stop at the first failure:
   - the run is still queued and the owner has not paused runners (section 6, kill switches),
   - the task is not in the inbox and has no `untrusted_text` (asked again now, not trusted from the dispatch),
   - the brief's SHA-256 matches the one stored at dispatch,
   - the project is in this machine's config and its folder is a git repository owned by the expected user,
   - the machine's daily run count and spend are under the caps in its config.
4. Claim: `POST /runner/runs/:id/claim` with the session id the runner minted. Polaris moves the run to `running`, sets the task to in progress, and returns a run token (section 5) that works for this run only.
5. Start, in a fresh worktree of the project's folder:

   ```sh
   claude --bg -p --session-id <uuid> -w polaris-<task id> \
     --bare --restricted --tools Read,Edit,Write,Glob,Grep \
     --disallowedTools Bash,WebFetch,WebSearch \
     --permission-mode acceptEdits --permission-prompts none \
     --settings <0600 file: apiKeyHelper for the runner's own API key> \
     --mcp-config <0600 file: Polaris over https with the run token> --strict-mcp-config \
     --max-budget-usd <cap from machine config> < <0600 file: the frozen brief>
   ```

   The flag list is a constant in the runner's source, not something the config or Polaris can change. The runner refuses to start if it cannot confirm that its Claude Code version supports every one of these flags, so an older or changed Claude Code fails closed instead of running without them. Secrets and the brief go through 0600 files in a private temp folder, never on the command line, where any user on the machine could read them with `ps`. The files are deleted when the run ends.
6. Watch: the runner checks the session with `claude agents` on its own machine. When the session ends it posts the outcome to `POST /runner/runs/:id` (finished, failed, stopped, lost, and the spend if Claude Code reports it). The run token stops working at that moment. Polaris adds a comment on the task, written from facts the runner observed rather than from the agent: what ran, where, for how long, the branch and worktree folder, how many files changed, and `claude logs <id>` on which machine for the full transcript.
7. Stuck: anything that would prompt is denied, so the agent cannot wait forever on an approval. Its instructions say to set the task to `waiting` with a comment saying what it needed. A run that hits the budget cap ends, and the comment says so.

### The brief

The brief is built at dispatch from text the owner wrote: the task's title, description, and the owner's own comments (human actor). It leaves out agent comments, thread posts, and anything from a third party. Posts in a thread are claims from other agents and could carry injected instructions, so they never reach a session that can edit files. The brief ends with fixed instructions: work only in this worktree, do not try to push, report through the Polaris tools, set `waiting` when blocked.

### What the session can and cannot do

- It can read, search, and edit files in its worktree, and read and comment on its one task through the run token.
- It cannot run a command, so it cannot push, run `gh`, install a package, run the project's tests, or start a process. It has no WebFetch or WebSearch, so it cannot send data out or read a poisoned page. Its only network peers are Anthropic's API and Polaris.
- It loads none of the owner's settings, hooks, plugins, memory, or CLAUDE.md files from outside the worktree, and never reads the owner's Claude login. It authenticates with an API key kept for runners, so its spend is visible and capped on its own and the key can be revoked without touching the owner's login.
- Its file tools are confined to the worktree. It cannot read `~/.ssh`, the secret store, other repos, or the Polaris data folder.
- The work stays on a local branch in the worktree. The owner reads the diff, runs the tests, and pushes it themselves.

Not running tests is the price of having no shell. Section 10 describes the only route to giving a session a shell, and it needs the owner's word.

## 4. The "Run on" menu

- Next to Assign to AI, a "Run on" menu lists each registered runner: "Claude on laptop, seen 2 min ago". Choosing one opens a confirmation sheet that shows the exact brief the agent will get, the machine, the project folder name, and the budget cap, with Run and Cancel. Run calls the dispatch route.
- A runner not seen for more than 2 minutes reads "Claude on laptop, offline since 14:05". It can still be chosen; the run waits until the machine is back.
- An open run shows on the task panel: queued or running, machine, started at, session id, and a Stop button. Stop is owner-only and moves the run to `stopping`; the runner stops the session on its next poll. Taking back the assignee also stops the run.
- Inbox tasks and tasks with `untrusted_text` never show the menu, and the server refuses them whatever the dashboard sends.
- The menu and Stop are disabled offline (`useOffline()`), since neither has an outbox op.
- 44px targets, a visible focus ring, a keyboard path, Esc closes the menu and the sheet. New shots states for the open menu and the confirmation sheet.

## 5. What Polaris stores

An additive migration with two new tables and no change to an existing column:

- `runners`: name, a hash of its token, created at, last seen at, last reported version and project list, revoked at.
- `runs`: task id, runner name, state (queued, running, stopping, finished, failed, stopped, lost), the frozen brief and its SHA-256, a hash of the run token, Claude Code session id, dispatched at and by, started at, ended at, outcome, spend in dollars when known.

The machine's folders, budget, flags, and API key are not stored. A run with no heartbeat for 10 minutes is shown as "not heard from", not failed: a sleeping laptop is not a broken one.

**The run token** is minted at claim, stored only as a hash, and valid only while that run is `running`. It is accepted on the MCP endpoint for one task: it can read that task, add a comment, and set its status to in progress or waiting (or done, where the ticket kind lets an agent complete it). It cannot read or touch any other task, set an assignee, edit a title or description, create anything, or call any tool that is not on that short list. This is narrower than the owner's mcp token, which the session never receives.

## 6. Security

### Who might try to misuse a runner, and what stops them

| Threat | What it could try | What stops it |
|---|---|---|
| Instructions hidden in third-party text (a GitHub issue, a web page) | Steer an agent into doing something on the owner's machine | Untrusted tasks cannot be dispatched (route and runner both check). The brief has only owner-written text. The session has no web tools, so it cannot fetch new text. |
| A hijacked or misbehaving MCP agent | Edit a task and get it run on the laptop | Only the owner's live click creates a run. An edit after the click fails the brief hash check. MCP has no dispatch tool. |
| A misbehaving session (bad instructions, bad model output, injected text inside the repo) | Push, run commands, read keys, send data out, spend money | `--restricted`, no shell, no web tools, file tools confined to the worktree, none of the owner's settings or credentials, a run token for one task, a budget cap per run and per day. The worst outcome is bad edits on a local branch the owner reviews. |
| A stolen runner token | Pretend to be the runner | It reaches `/runner/*` only and can only claim runs the owner already dispatched to that runner. It cannot create a run, read other tasks, or touch the inbox, rules, goals, or threads. Revoking it is one click. |
| A stolen run token | Act as the session | Valid for one task and only while that run is open. |
| A stolen api token, or a lost phone with the dashboard signed in | Dispatch runs with a brief of its choosing | The session limits above still hold, so the damage is edits on a local branch. The confirmation sheet and the run history show every dispatch. A machine can also require local confirmation (below). The owner revokes the api token as today. |
| GR9 itself compromised | Same as a stolen api token | Same limits. The flags, folders, and caps live on each machine, so nothing on GR9 can widen what a runner does. |
| Someone else on a runner machine | Read the runner's secrets or the brief | Runner token in the machine's secret store (DPAPI, or 0600 file). Secrets and briefs in 0600 files, never in a process's arguments. The runner refuses a config file or secret file that other users can write. |
| A tampered Polaris response in transit | Feed the runner a fake run | The runner talks only to the HTTPS address in its config, with normal certificate checks, and refuses plain http except to 127.0.0.1. |

### Fail closed

Every check in section 3 stops the run when it cannot be confirmed: a network error, a 401, an unexpected response, a missing flag, a config the runner cannot parse. A 401 on any runner route also makes the runner stop its open sessions and exit, so revoking a token ends everything that runner is doing.

### Kill switches

- **Pause all runners**: an owner-only switch on the Settings tab and `cc runner pause`. Runners check it on every poll and before every start; while paused nothing new starts, and the owner chooses whether open runs stop too.
- **Revoke a runner**: on the same card and `cc runner revoke <name>`.
- **Stop a run**: the Stop button on the task.
- **On the machine**: stopping the runner process, or `claude stop <id>`.

### Local confirmation (optional per machine)

A machine's config can set `confirm = true`. The runner then shows a desktop notification for each run and starts it only after the owner approves it on that machine. This protects a machine even against a stolen api token, at the cost of not running while the owner is away. Off by default, since the owner already confirmed in the dashboard.

### Audit

Each dispatch, claim, start, stop, and end is an event in the task's history with its actor. The runner also keeps an append-only log on its machine with each run's brief hash, flags, and outcome, so the two records can be compared.

## 7. Local checklists (a later phase)

Today the `repo-files` job reads each tracked repo's todo file, README.md, CLAUDE.md, and docs/*.md over the GitHub API. The owner asked whether Polaris could read local repos instead.

### 7A. The daemon reads clones on GR9 (rejected)

- It only sees GR9's disk, and the owner's working clones are on other machines. GR9 would need its own clones of every project.
- Keeping them current needs `git pull`, which needs a git credential on GR9. A normal SSH key can push to every repo the owner can, which is the reason a personal token is forbidden. Deploy keys are read-only but one per repo, and still a second GitHub credential, which CLAUDE.md rules out.
- Unpushed work on the laptop would still be invisible, so it would not even buy freshness.
- Issues and PRs are not in a clone, so the GitHub App would still be needed.

### 7B. The runner reads its machine's clones (proposed)

For each project in its config, the runner reads the same files from the local folder and sends them to Polaris, which parses them with the code `repo-files` uses now.

- A project has one checklist source: GitHub, or a named home machine. The owner sets it per project. Two machines with different copies of a repo never fight over its tasks, and a runner's report for a project whose source is not that runner is refused.
- The runner reads only the fixed file list (the todo file, README.md, CLAUDE.md, docs/*.md at the top level), never a path Polaris sends. Each file's real path, after following links, must lie inside the project folder, so a link to `~/.ssh` or another repo is skipped and reported, never read.
- The same care as `repo-files`: the runner confirms the folder exists and is a git repo before reading any file, and reports an unreadable folder instead of reporting its files missing, so a laptop with an unmounted drive does not retire every task. A missing file retires that file's tasks only when the folder itself was readable. A file over 1 MB is skipped and reported.
- Checklist tasks stay the owner's own trusted text, as they are from `repo-files` today.
- This uses the runner token with one more permission, to report checklist files for its own projects, and starts no program.
- Buys: no GitHub credential involved, and the tasks follow unpushed edits on the home machine.
- Costs: the tasks only change while the home machine's runner is running. A second parser path to test.

The GitHub App stays for issues and PRs, which land in the inbox as now. Its one-time sign-in is still needed for that.

## 8. Rule changes for the owner to approve

Each is a separate yes or no.

1. **Reading local paths, in the runner only.** CLAUDE.md says nothing ever reads a local clone or path. Proposed: the daemon never does; the runner reads only the folders named in its own machine's config, for Claude Code's working folder and (phase C) the fixed checklist files inside them.
2. **Starting a program, in the runner only.** The daemon still never starts a program. The runner starts exactly one, Claude Code, with the fixed locked-down flags in section 3, and reads its own machine's `claude agents` list.
3. **An owner-only dispatch route**, live only, with no MCP tool, rule action, or offline op kind.
4. **Two new token kinds**: one runner token per machine (section 6) and a run token per run (section 5), each with the boundary stated there.
5. **An additive migration**: the `runners` and `runs` tables. No existing column changes meaning; `assignee` stays a plain name.
6. **No new offline op kind.** Dispatching, stopping, pausing, registering, revoking, and every `/runner` route are live-only.
7. **A separate Anthropic API key for runners**, kept in each runner machine's secret store, never in Polaris.
8. **New "When to ask" lines**: removing any flag from the runner's fixed list, or adding a tool to it (above all Bash or a web tool); letting a session or runner push or open a PR; letting Polaris set a runner's folders, budget, flags, or key; letting the runner read anything outside its configured folders; letting anything but the owner's live click start a run; including agent or third-party text in a brief.

## 9. Invariants to add

A new group 11 in command-center/src/invariants.test.ts:

- Only the human actor can create a run. The dispatch route refuses the mcp, read-only, runner, and run tokens; no MCP tool, rule action, or outbox op creates, starts, or resumes a run.
- Setting `assignee` to `claude@<name>` by any route creates no run.
- A task in the inbox or with `untrusted_text` can never be dispatched or claimed, by any route.
- A frozen brief contains only the task's title, description, and human-actor comments. No agent comment, thread post, or untrusted text reaches it.
- A claim fails when the brief's hash no longer matches.
- The runner token is refused on `/api`, `/mcp`, and `/mcp/readonly`, and the api, mcp, and read-only tokens are refused on `/runner`. Tailscale identity opens nothing under `/runner`. A runner's name comes from its token, never from the request.
- A run token reaches only its own task, only the short tool list in section 5, and stops working when the run leaves `running`.
- No `/runner` route or run token accepts or rejects an inbox item, creates or enables a rule, sets a goal's status, uses an owner thread control, edits a project, or changes an assignee.
- The runner's Claude Code arguments always include `--bare`, `--restricted`, `--strict-mcp-config`, `--permission-prompts none`, and `--max-budget-usd`; its `--tools` list never includes Bash, PowerShell, WebFetch, WebSearch, or another code-running tool; and no config value or server response reaches the argument list except the session id, the worktree name, and the budget figure (a source check on the runner).
- The runner never passes a secret or the brief as a command-line argument.
- The schema has no column for a runner's folders, budget, flags, or API key.
- The daemon and the http server do not import `child_process` (a source check, as group 8 checks the fake GitHub).
- The `runner` command never opens a store.
- Run events are not rule triggers, and rules have no run action.
- The outbox has no runner or run op kind.

## 10. Phases

- **Phase A: one machine, one run at a time, locked down from the first run.** `cc runner` with heartbeat, polling, the checks, claim, start, and outcome. The dispatch route, the confirmation sheet, the run token, the `runners` and `runs` tables, Pause all runners, revoke, Stop, and group 11. Nothing from section 6 is deferred to a later phase.
- **Phase B: liveness and spend.** Reconciling after a reboot (an open run whose session is gone becomes "lost" with a comment), spend on runs when Claude Code reports it, a daily spend cap per runner, the optional local confirmation.
- **Phase C: local checklists**, section 7B, with the per-project checklist source.
- **Only with the owner's word: a shell.** Running tests needs Bash, and Bash with the owner's credentials in reach is the risk this design exists to avoid. If it is ever wanted, the session runs as a separate OS account with no SSH keys, no `gh` login, and no git credentials, in its own clone, with outbound network limited to Anthropic's API and Polaris, and Bash only inside that boundary. That is its own proposal.
- **Later:** Anchor speaks the `/runner` protocol and brings approvals (the assign doc's Stage 3).

## Open questions

- Installing the runner: a logon task on Windows (the daemon's installer in scripts/ is a model) and a systemd user unit on Linux. Does the owner's main development machine run Windows or Linux?
- Does `--restricted` confine the file tools on Windows as it does on Linux? Phase A checks this on each platform before a runner is enabled there.
- Transcripts. The outcome comment plus `claude logs <id>` on the named machine is the proposal. A long run may deserve a short summary the agent writes before it ends. A thread is for argument, not transcripts.
- Spend. Does Claude Code report a background session's cost anywhere the runner can read after the fact? If not, Phase B records the cap instead of the actual spend. The runner API key's own spend limit in the Anthropic Console is the backstop either way.
- Sleep. GR9 does not sleep; laptops do. A background session on a sleeping laptop pauses and resumes. How long before an open run is shown as "not heard from" (10 minutes is the guess), and should a run be stopped after a day with no heartbeat?
- Should GR9 itself run a runner? It holds no working clones today, only the deploy checkout, which must never be worked in. Recommended: no.
- How `--bg` takes its prompt. The plan is standard input or a prompt file, so the brief never appears in a process's arguments. Phase A confirms which one works before anything else is built on it.
- Worktree cleanup: Claude Code removes a `-w` worktree when that is safe. A run that made changes leaves its worktree and branch for the owner, and the outcome comment names both.

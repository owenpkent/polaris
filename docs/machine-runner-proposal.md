# Machine runners: proposal

Status: proposal, 2026-10-06, awaiting the owner's approval; revised the same day to make security a requirement (section 6), and again after review to drop `--bg` for a supervised print-mode child, to bind run-token reads to the frozen brief, to have the runner make the worktree itself with nothing ignored in it, and to tie the session's life to the runner's by a mechanism per platform rather than by parenthood. Nothing here is built. This is Stage 2 of docs/assign-to-ai-options.md (the `cc dispatch` idea, option 2B), reshaped for several machines: the daemon now lives on GR9, an always-on Linux host behind `tailscale serve`, and the owner's working clones live on the other computers where the owner writes code.

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

Claude Code 2.1.292, as installed on GR9, has the flags this needs: `-p`/`--print` runs one prompt non-interactively and exits, `--output-format json` makes it print a single result object at the end, `--session-id <uuid>` fixes the id ahead of time, `--permission-mode acceptEdits` allows file edits, `--permission-prompts none` denies anything that would otherwise prompt, `--max-budget-usd` caps spend, and `--mcp-config` with `--strict-mcp-config` loads only the MCP servers given. (The assign doc's `--permission-prompt-tool none` is not a flag in this version; `--permission-prompts none` is.)

It also has `--bg`, which starts a detached background session that `claude agents`, `attach`, `logs`, `stop`, and `rm` manage by id. The first draft used it together with `-p`. That combination does not exist: `--bg` and `--print` conflict, and Claude Code 2.1.292 exits with status 1 and the message `--bg and --print conflict: --print never starts the interactive session that claude agents attaches to` (checked on GR9 against an empty config folder and an unreachable API address, so no session started). The two controls that matter most here, `--permission-prompts none` and `--max-budget-usd`, are documented as print-mode flags. So this proposal uses print mode and no `--bg`: the runner starts `claude -p` as its own child process, supervises it, and reads its result when it exits (section 3).

It also has `-w`/`--worktree`, which makes a git worktree for the session. The runner does not use it. A worktree made that way honours the project's `.worktreeinclude`, which copies files the owner has gitignored, `.env` among them, from the main checkout into the new worktree, where the session's file tools are allowed to read them. The runner makes the worktree itself with git (section 3, step 5).

It also has the flags that lock a session down, which section 3 depends on:

- `--restricted` removes Bash, PowerShell, the REPL, the other code-running tools, and WebFetch unless `--tools` names them; ignores the user, project, and local settings files; confines the file tools to the working directories; refuses `bypassPermissions`; and lets only a person or the configured permission handler approve writes to settings, git, and tool-configuration files.
- `--bare` skips hooks, plugins, auto-memory, keychain reads, and CLAUDE.md discovery. Authentication is then only `ANTHROPIC_API_KEY` or an `apiKeyHelper` given through `--settings`, never the owner's own login.
- `--safe-mode` turns off CLAUDE.md, skills, installed plugins, hooks, MCP servers, custom commands and agents, while authentication, model selection, built-in tools, and permissions work normally. This is the lockdown for a session that signs in with the owner's Claude plan, since `--bare` would refuse that login.
- `--tools` names the built-in tools the session gets, and `--disallowedTools` denies more on top.

Without these, a session would load the owner's user settings: their allow rules (a rule such as `Bash(git *)` would let it push), their hooks, their plugins, and their git and `gh` credentials. The first draft of this proposal said pushing "is denied"; with the owner's settings loaded that depends on what the owner has allowed, so it was not true.

## The shape

```
  laptop                                 GR9
  +---------------------------+          +------------------------------+
  | cc runner (name: laptop)  |  HTTPS   | tailscale serve              |
  |   polls /runner/* --------+--------->|   -> 127.0.0.1:8788 daemon   |
  |   runs claude -p as child | tailnet  |   one SQLite database        |
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
- It freezes the brief at that moment (section 3) and stores it on the run with its SHA-256. The runner works from the frozen brief, never from the live task, and so does the session's run token (section 5), so an edit made after the click cannot change what the agent is told.
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
5. Make the worktree. The runner runs `git worktree add` itself, in the project's folder, with a new branch `polaris/<task id>` at the commit the folder's HEAD points to, into a folder beside the project (`<project>-runs/<run id>`), and with git hooks off for that one command (`-c core.hooksPath=` naming an empty folder, since a tracked `post-checkout` hook would otherwise run with the owner's settings). It never uses Claude Code's `-w`/`--worktree`: that flag copies whatever the project's `.worktreeinclude` names, ignored files included, from the owner's checkout into the session's tree, and a `.env` copied that way is readable by the file tools the session is allowed, so confining those tools to the worktree would keep no credential out. A worktree git makes from a commit holds committed content only; nothing from the owner's index, working tree, or ignored files comes along. The runner then inspects the tree before anything else sees it: `git status --ignored --porcelain` run in the worktree must print nothing. Any line, tracked, untracked, or ignored, means the tree is not the clean checkout the runner asked for, and the run is refused and reported, never started.
6. Start, in that worktree as the working folder, as a child process of the runner in print mode, through the leash described below so that the session cannot outlive the runner. The session runs for one prompt and exits, and the runner is its parent for the whole run: it holds the process handle, reads its standard output, and gets its exit status. Nothing is detached and there is no `--bg`. The machine's config picks how the session pays for Claude (see "How a session signs in" below), and that choice picks one of two fixed flag sets:

   ```sh
   # plan (the default): the owner's Claude plan login
   # working folder: the run's worktree from step 5; no -w
   claude -p --output-format json --session-id <uuid> \
     --safe-mode --restricted --tools Read,Edit,Write,Glob,Grep \
     --disallowedTools Bash,WebFetch,WebSearch \
     --permission-mode acceptEdits --permission-prompts none \
     --mcp-config <0600 file: Polaris over https with the run token> --strict-mcp-config \
     < <0600 file: the frozen brief>

   # api: a separate Anthropic API key for runners
   # working folder: the run's worktree from step 5; no -w
   claude -p --output-format json --session-id <uuid> \
     --bare --restricted --tools Read,Edit,Write,Glob,Grep \
     --disallowedTools Bash,WebFetch,WebSearch \
     --permission-mode acceptEdits --permission-prompts none \
     --settings <0600 file: apiKeyHelper for the runner's API key> \
     --mcp-config <0600 file: Polaris over https with the run token> --strict-mcp-config \
     --max-budget-usd <cap from machine config> < <0600 file: the frozen brief>
   ```

   Either way the runner also stops a session that passes the time limit in its config (60 minutes unless set), by ending the leash's process group or job (below), so a run has a ceiling even where a dollar cap does not apply.

   Both flag sets are constants in the runner's source, not something the config or Polaris can change. The runner refuses to start if it cannot confirm that its Claude Code version supports every one of these flags, so an older or changed Claude Code fails closed instead of running without them. A flag existing is not enough: `--bg` and `-p` both exist in 2.1.292 and refuse each other. So before the runner reports itself healthy it runs a launch compatibility check of the complete argument combination it will use, each flag set exactly as above with placeholder files and no reachable API, and treats a refusal, a usage error, or any exit that is not the expected one as "not healthy". A runner that fails this check sends no heartbeat and claims nothing. Secrets and the brief go through 0600 files in a private temp folder, never on the command line, where any user on the machine could read them with `ps`. The files are deleted when the run ends.
7. Watch: the runner waits on its child. The session has ended when the process exits, and the runner learns the result from the exit status and the single JSON result object print mode writes to standard output (the outcome, the session id, the number of turns, and the cost where Claude Code reports it). A session the runner ended for time or on a Stop is reported as stopped; a child that vanished without a result (a crash, a reboot) is reported as lost. There is no polling of a session list: nothing on the machine but the runner knows the session is there. The runner then posts the outcome to `POST /runner/runs/:id` (finished, failed, stopped, lost, and the spend if Claude Code reported it). The run token stops working at that moment. Polaris adds a comment on the task, written from facts the runner observed rather than from the agent: what ran, where, for how long, the branch and worktree folder, how many files changed, and the path of the session log the runner kept on that machine for the full output. A run that changed nothing has its worktree and branch removed by the runner (`git worktree remove`, `git branch -d`); a run that made changes leaves both for the owner, and the outcome comment names them.
8. Stuck: anything that would prompt is denied, so the agent cannot wait forever on an approval. Its instructions say to set the task to `waiting` with a comment saying what it needed. A run that hits the budget cap ends, and the comment says so.

### The brief

The brief is built at dispatch from text the owner wrote: the task's title, description, and the owner's own comments (human actor). It leaves out agent comments, thread posts, and anything from a third party. Posts in a thread are claims from other agents and could carry injected instructions, so they never reach a session that can edit files. The brief ends with fixed instructions: work only in this worktree, do not try to push, report through the Polaris tools, set `waiting` when blocked.

### The leash: a session cannot outlive the runner

Being the session's parent is not enough. On Linux and macOS a parent that is killed or crashes leaves its children running, reparented to pid 1; on Windows a child outlives its parent by default too. A runner that died that way would leave a session editing files with nobody holding the time limit or polling for Stop and revocation, and Polaris would show the run as not heard from, not stopped. So the runner never starts `claude` directly. It starts a leash, a small program shipped with the runner (command-center/src/runner/leash), which starts `claude` and ties the session's life to the runner's by the means each platform has. These are decisions, not options:

- **Linux and macOS: a process group with a parent watch.** The runner starts the leash as the leader of a new process group (`setsid`, which Node's `detached: true` does), and the leash starts `claude` inside that group, so the group holds the session and anything it starts. The leash is given the runner's pid and compares `getppid()` with it once a second; when they differ, the runner is gone (the leash has been reparented to pid 1 or a subreaper), and the leash sends SIGKILL to the whole group and exits. Chosen over `PR_SET_PDEATHSIG` and pidfds because it needs no native code, is the same on both systems, and bounds an orphan's life to about a second.
- **Linux installed as a systemd user service: the unit's cgroup as the second line.** The service keeps the default `KillMode=control-group`, so when the runner's main process exits for any reason, or the owner runs `systemctl --user stop`, systemd kills every process left in the unit's cgroup, leash and session included. This holds even if the leash itself has died. A runner the owner starts by hand in a terminal has the leash alone, which is enough.
- **Windows: a Job Object that kills on close.** The leash creates a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and without breakaway, assigns itself to it, then starts `claude`, which inherits the job and cannot leave it. The leash waits on a handle to the runner process and exits when that handle signals. When the last handle to the job closes, whether the leash exited or died, the kernel ends every process in the job. Chosen because the kernel does the killing, so there is nothing to poll and nothing that can be missed.

Every stop the runner makes (the time limit, a Stop, a pause that stops open runs, a 401, its own SIGTERM or Ctrl-C) is the same one action on every platform: it ends the leash's group or job. On Linux and macOS that is SIGTERM to the group and SIGKILL 10 seconds later; on Windows it ends the leash, and the closing job handle ends the session. So the kill switch on the machine rests on the leash and the platform mechanism behind it, not on the parent/child relationship: stopping the runner, by any means, ends the session within seconds.

The leash is given the runner's pid, the working folder, and the `claude` arguments, and nothing else. It adds no flags and reads no config, so the fixed flag sets in step 6 are still exactly what reaches `claude` (a source check in section 9).

### What the session can and cannot do

- It can read, search, and edit files in its worktree, and, through the run token, read its one task as the frozen brief, comment on it, and set its status (section 5).
- It cannot run a command, so it cannot push, run `gh`, install a package, run the project's tests, or start a process. It has no WebFetch or WebSearch, so it cannot send data out or read a poisoned page. Its only network peers are Anthropic's API and Polaris.
- It loads none of the owner's settings, hooks, plugins, memory, or CLAUDE.md files from outside the worktree.
- With the plan login, Claude Code uses the owner's sign-in on that machine, but the session itself has no shell, no web tools, and file tools confined to the worktree, so it has no way to read the stored login or send it anywhere. With an API key, the session never touches the owner's login at all.
- Its file tools are confined to the worktree, and the worktree holds committed content only: the runner made it with git from a commit and refused to start if anything ignored was in it (step 5), so there is no copied `.env` to read. It cannot read `~/.ssh`, the secret store, other repos, or the Polaris data folder.
- The work stays on a local branch in the worktree. The owner reads the diff, runs the tests, and pushes it themselves.

Not running tests is the price of having no shell. Section 10 describes the only route to giving a session a shell, and it needs the owner's word.

### How a session signs in

Each runner machine's config sets `billing = "plan"` (the default) or `billing = "api"`.

| | plan (default) | api |
|---|---|---|
| Cost | Included in the owner's Claude plan, counted against its usage limits | Billed per token on its own Anthropic account |
| Spending control | The runner's time limit and daily run count, then the plan's own limits | The runner's caps, `--max-budget-usd` per run, and a hard spend limit set on the key in the Anthropic Console |
| Effect on the owner's own work | A busy runner uses the same 5-hour allowance the owner codes with | None |
| Revoking | Revoke the runner token; the owner's login is untouched | Delete the key; the owner's login is untouched |
| Lockdown | `--safe-mode --restricted` | `--bare --restricted` |

The security difference is small, because in both modes the session cannot run a command, reach the web, or read outside its worktree. The API key, when used, lives in that machine's secret store and reaches Claude Code through an `apiKeyHelper` in a 0600 settings file, never in Polaris and never on the command line.

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

The machine's folders, budget, flags, billing choice, and API key are not stored. A run with no heartbeat for 10 minutes is shown as "not heard from", not failed: a sleeping laptop is not a broken one.

**The run token** is minted at claim, stored only as a hash, and valid only while that run is `running`. It is accepted on the MCP endpoint for one task: it can read that task, add a comment, and set its status to in progress or waiting (or done, where the ticket kind lets an agent complete it). It cannot read or touch any other task, set an assignee, edit a title or description, create anything, or call any tool that is not on that short list. This is narrower than the owner's mcp token, which the session never receives.

**Run-token reads are snapshot-backed.** Section 2B promises that an edit after the click cannot change what the agent is told, and the brief file on the machine keeps that promise at launch. The MCP tools would break it mid-run if the run token simply reused them. Today `get_task` (command-center/src/mcp/tools-read.ts) returns the live task row with all of its current comments, subtasks, blockers, links, and recent history, and `update_task` (tools-write.ts) lets any MCP caller change a task's title or notes, append a comment through `add_comment`, and get the live task back in its response. So an agent holding the ordinary mcp token, or a rule's `add_comment` action, could put new text in front of a running session after dispatch, through the one channel the brief was built to close. Under the run token, therefore:

- A read of the task answers from the run record, not the task table: the frozen brief (the same bytes the session was launched with) and the run's own facts (task id, run state, the status the session has set). It carries no live title, notes, comments, subtasks, links, or history. The brief is the only task text that reaches the session, at launch and afterwards.
- A write (a comment, a status change) is applied live, so the owner sees it as it happens, but its response carries the same snapshot, never the task as it now stands.
- The read-only tools are not on the run token's list, so `list_tasks`, `search_tasks`, threads, and the rest cannot be used to read around the snapshot.

The owner can still change a task during a run; the change waits for the next run, which freezes a new brief.

## 6. Security

### Who might try to misuse a runner, and what stops them

| Threat | What it could try | What stops it |
|---|---|---|
| Instructions hidden in third-party text (a GitHub issue, a web page) | Steer an agent into doing something on the owner's machine | Untrusted tasks cannot be dispatched (route and runner both check). The brief has only owner-written text. The session has no web tools, so it cannot fetch new text. |
| A hijacked or misbehaving MCP agent | Edit a task and get it run on the laptop, or feed text to a run already in progress | Only the owner's live click creates a run. An edit after the click fails the brief hash check. MCP has no dispatch tool. During a run the session reads only the frozen brief: a title, notes, or comment edit made over MCP after dispatch never appears in a run-token response (section 5). |
| A misbehaving session (bad instructions, bad model output, injected text inside the repo) | Push, run commands, read keys, send data out, spend money | `--restricted`, no shell, no web tools, file tools confined to a worktree the runner made from a commit with nothing ignored in it (so no `.env` to read and post), none of the owner's settings or credentials, a run token for one task, a budget cap per run and per day, and a life tied to the runner's by the leash. The worst outcome is bad edits on a local branch the owner reviews. |
| A stolen runner token | Pretend to be the runner | It reaches `/runner/*` only and can only claim runs the owner already dispatched to that runner. It cannot create a run, read other tasks, or touch the inbox, rules, goals, or threads. Revoking it is one click. |
| A stolen run token | Act as the session, or read the owner's tasks | Valid for one task and only while that run is open. It reads nothing but that run's frozen brief. |
| A stolen api token, or a lost phone with the dashboard signed in | Dispatch runs with a brief of its choosing | The session limits above still hold, so the damage is edits on a local branch. The confirmation sheet and the run history show every dispatch. A machine can also require local confirmation (below). The owner revokes the api token as today. |
| GR9 itself compromised | Same as a stolen api token | Same limits. The flags, folders, and caps live on each machine, so nothing on GR9 can widen what a runner does. |
| Someone else on a runner machine | Read the runner's secrets or the brief | Runner token in the machine's secret store (DPAPI, or 0600 file). Secrets and briefs in 0600 files, never in a process's arguments. The runner refuses a config file or secret file that other users can write. |
| A tampered Polaris response in transit | Feed the runner a fake run | The runner talks only to the HTTPS address in its config, with normal certificate checks, and refuses plain http except to 127.0.0.1. |

### Fail closed

Every check in section 3 stops the run when it cannot be confirmed: a network error, a 401, an unexpected response, a missing flag, a failed launch compatibility check, a config the runner cannot parse. A 401 on any runner route also makes the runner end its child sessions and exit, so revoking a token ends everything that runner is doing.

### Kill switches

- **Pause all runners**: an owner-only switch on the Settings tab and `cc runner pause`. Runners check it on every poll and before every start; while paused nothing new starts, and the owner chooses whether open runs stop too.
- **Revoke a runner**: on the same card and `cc runner revoke <name>`.
- **Stop a run**: the Stop button on the task.
- **On the machine**: stopping the runner process, by any means. The session's life is tied to the runner's by the leash and the platform mechanism behind it (section 3: a watched process group on Linux and macOS, the systemd unit's cgroup on a Linux install, a kill-on-close Job Object on Windows), not by its being a child, so a runner that is stopped, killed, or crashes takes the session with it within seconds. There is no detached session to find afterwards.

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
2. **Starting a program, in the runner only.** The daemon still never starts a program. The runner starts exactly one, Claude Code in print mode, as a child process it supervises until it exits, through the leash in section 3 so that the session cannot outlive the runner, with the fixed locked-down flags in section 3, in a worktree the runner made with git. It starts no detached session.
3. **An owner-only dispatch route**, live only, with no MCP tool, rule action, or offline op kind.
4. **Two new token kinds**: one runner token per machine (section 6) and a run token per run (section 5), each with the boundary stated there. The run token's reads, and the task in its write responses, come from the frozen brief, never from the live task.
5. **An additive migration**: the `runners` and `runs` tables. No existing column changes meaning; `assignee` stays a plain name.
6. **No new offline op kind.** Dispatching, stopping, pausing, registering, revoking, and every `/runner` route are live-only.
7. **How sessions pay for Claude**: the owner's plan login by default, or a separate Anthropic API key per machine, chosen in that machine's config. A key is kept in the machine's secret store, never in Polaris.
8. **New "When to ask" lines**: removing any flag from the runner's fixed list, or adding a tool to it (above all Bash or a web tool); letting a session or runner push or open a PR; letting Polaris set a runner's folders, budget, flags, or key; letting the runner read anything outside its configured folders; letting anything but the owner's live click start a run; including agent or third-party text in a brief.

## 9. Invariants to add

A new group 13 in command-center/src/invariants.test.ts (groups 11 and 12 are taken by updates and checklists):

- Only the human actor can create a run. The dispatch route refuses the mcp, read-only, runner, and run tokens; no MCP tool, rule action, or outbox op creates, starts, or resumes a run.
- Setting `assignee` to `claude@<name>` by any route creates no run.
- A task in the inbox or with `untrusted_text` can never be dispatched or claimed, by any route.
- A frozen brief contains only the task's title, description, and human-actor comments. No agent comment, thread post, or untrusted text reaches it.
- A claim fails when the brief's hash no longer matches.
- The runner token is refused on `/api`, `/mcp`, and `/mcp/readonly`, and the api, mcp, and read-only tokens are refused on `/runner`. Tailscale identity opens nothing under `/runner`. A runner's name comes from its token, never from the request.
- A run token reaches only its own task, only the short tool list in section 5, and stops working when the run leaves `running`.
- Run-token responses are snapshot-backed (a contract test): dispatch a task and freeze its brief; then, through the ordinary MCP endpoint with the mcp token, change its title and notes with `update_task`, append a comment with `add_comment`, and add a thread post; then call every tool the run token allows, the read and each write, and confirm that none of the new text appears in any response, in the text or the structured content, and that the read still returns the frozen brief byte for byte. The same test confirms the live task did change, so the snapshot is what hid it.
- No `/runner` route or run token accepts or rejects an inbox item, creates or enables a rule, sets a goal's status, uses an owner thread control, edits a project, or changes an assignee.
- The runner's Claude Code arguments always include `-p` and `--restricted` and one of `--bare` (api) or `--safe-mode` (plan), plus `--strict-mcp-config` and `--permission-prompts none`, and `--max-budget-usd` with an API key, and never `--bg` or `-w`/`--worktree`; the runner always enforces its time limit; its `--tools` list never includes Bash, PowerShell, WebFetch, WebSearch, or another code-running tool; and no config value or server response reaches the argument list except the session id and the budget figure, the worktree being the child's working folder and not an argument (a source check on the runner). An unknown billing value in the config means no run, never a third flag set.
- The runner never starts `claude` directly: every launch goes through the leash, which passes the argument list on unchanged, adds nothing, and reads no config (a source check).
- The run's worktree is made by the runner with `git worktree add` from a commit and with hooks off, never with `-w`, and the runner refuses to start when `git status --ignored --porcelain` in that worktree prints anything.
- The runner never passes a secret or the brief as a command-line argument.
- The runner reports itself healthy only after the launch compatibility check in section 3 has passed for the complete argument combination of its flag set, and a Claude Code that refuses that combination means no heartbeat and no claim.
- The schema has no column for a runner's folders, budget, flags, or API key.
- Nothing the daemon or the http server loads imports `child_process`, except `src/ingest/secrets.ts`, which runs PowerShell on Windows to unlock the secret store (a source check with that one file allowed, as group 8 checks the fake GitHub; group 11 already makes the same check for the daemon and the http server, see docs/update-proposal.md).
- The `runner` command never opens a store.
- Run events are not rule triggers, and rules have no run action.
- The outbox has no runner or run op kind.

Two tests beside the runner's code, run on every platform CI covers, prove the two local guarantees rather than state them:

- **Nothing ignored reaches the session.** The test makes a repository whose `.gitignore` names `.env`, whose `.worktreeinclude` names it too, and whose main checkout holds a `.env` with a sentinel string. It runs the runner's worktree step and confirms that the worktree has no `.env`, that no file under it contains the sentinel, that `git status --ignored --porcelain` there prints nothing, and that the runner goes on to launch. It then plants an ignored file in a fresh worktree and confirms the runner refuses to start and reports why.
- **The session cannot outlive the runner.** The test puts a stand-in `claude` first on PATH that passes the launch compatibility check, then sleeps far past the time limit and ignores SIGTERM. It starts the runner against a fake Polaris with one queued run, waits until the stand-in is running, then kills the runner outright (SIGKILL on Linux and macOS, `TerminateProcess` on Windows) and proves that within 5 seconds the stand-in, the leash, and every process in its group or job are gone. The same test stops a runner cleanly and proves the time limit ends the stand-in within the 10-second grace, SIGTERM ignored or not.

## 10. Phases

- **Phase A: one machine, one run at a time, locked down from the first run.** `cc runner` with heartbeat, polling, the checks, claim, start, and outcome. The dispatch route, the confirmation sheet, the run token, the `runners` and `runs` tables, Pause all runners, revoke, Stop, and group 13. Nothing from section 6 is deferred to a later phase.
- **Phase B: liveness and spend.** Reconciling after a reboot (an open run whose session is gone becomes "lost" with a comment; the leash is what makes "gone" true, since no session survives its runner), spend on runs when Claude Code reports it, a daily spend cap per runner, the optional local confirmation.
- **Phase C: local checklists**, section 7B, with the per-project checklist source.
- **Only with the owner's word: a shell.** Running tests needs Bash, and Bash with the owner's credentials in reach is the risk this design exists to avoid. If it is ever wanted, the session runs as a separate OS account with no SSH keys, no `gh` login, and no git credentials, in its own clone, with outbound network limited to Anthropic's API and Polaris, and Bash only inside that boundary. That is its own proposal.
- **Later:** Anchor speaks the `/runner` protocol and brings approvals (the assign doc's Stage 3).

## Open questions

- Installing the runner: a logon task on Windows (the daemon's installer in scripts/ is a model) and a systemd user unit on Linux. Does the owner's main development machine run Windows or Linux?
- Does `--restricted` confine the file tools on Windows as it does on Linux? Phase A checks this on each platform before a runner is enabled there.
- Transcripts. The outcome comment plus the session log the runner keeps on the named machine (the child's standard output, written as it arrives) is the proposal. A long run may deserve a short summary the agent writes before it ends. A thread is for argument, not transcripts.
- Spend. Print mode's JSON result carries the session's cost when Claude Code knows it, and the runner reads it from the child's output when it exits, so Phase B expects the actual spend. If a billing mode leaves the figure out, Phase B records the cap instead. With an API key, the key's spend limit in the Anthropic Console is the backstop. On the plan, `--max-budget-usd` may not apply at all, which is why the runner keeps its own time limit.
- Sleep. GR9 does not sleep; laptops do. The runner and its child session on a sleeping laptop pause together and resume together. How long before an open run is shown as "not heard from" (10 minutes is the guess), and should a run be stopped after a day with no heartbeat?
- Should GR9 itself run a runner? It holds no working clones today, only the deploy checkout, which must never be worked in. Recommended: no.
- How `-p` takes its prompt. The plan is standard input (print mode reads a piped prompt) or a prompt file, so the brief never appears in a process's arguments. Phase A confirms which one works before anything else is built on it, as part of the launch compatibility check.
- Does `--safe-mode` also turn off the Polaris server given with `--mcp-config`? Its help says it turns off MCP servers. If it does, a plan session cannot comment or set `waiting` itself, and the runner writes those from the session's result instead. Phase A tests this first.
- Where the run's worktree goes. Beside the project (`<project>-runs/<run id>`) is the proposal, so the owner finds it next to the clone and it is never inside the project's own tree; a machine's config may name another folder. Branch names (`polaris/<task id>`) and what to do when a branch from an earlier run of the same task still exists (the proposal: a numbered suffix, never a reuse) are for Phase A to settle.

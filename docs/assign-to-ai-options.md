# Assign to AI: options

Status: exploration, 2026-10-03. Stage 1 of the recommended path (1A, 2A, 3A, 5B) merged as PR #2 (feat/assign-to-ai), with the hand-off reporting back in PR #10; nothing else is built. Stage 2, reshaped for several machines, is proposed in docs/machine-runner-proposal.md (2026-10-06) and awaits the owner's approval.

This document lays out the choices for an "Assign to AI" button on a task: what the button writes, who starts the agent, how status comes back, where approvals live, how agents are identified, what a team version would take, and how Polaris would talk to Anchor. Each option lists what it buys and what it costs. A recommended path is at the end.

## Where things stand

Polaris:

- The task panel has a "Hand off to Claude Code" menu (src/command-center/HandoffMenu.jsx). It builds a prompt, wraps third-party text in a marked block, copies the prompt to the clipboard, and links to the repo on GitHub. It writes nothing.
- `assignee` is a free-text name on a task (migration 6). docs/decision-maps.md defines the loop an agent runs: pick from the `ready` view, set `assignee` to its own name, comment, complete research, prototype, and setup tickets, and hand discuss tickets back to the owner.
- Every change records an actor: human over REST, agent over MCP, system for jobs, rule for the rule engine. Since 5B landed (migration 7), the name an MCP connection declared rides beside the actor; before it, nothing recorded which agent.
- Three bearer tokens, one per trust boundary: api, mcp, mcp-readonly. The MCP token cannot enable a rule, over MCP or over REST.
- The daemon runs its jobs in-process and never starts a program. CLAUDE.md asks for the owner's word before anything reads a local clone or path.
- The README says Polaris is not for teams: one owner, one database, loopback only.
- The dashboard works offline. Edits queue in an outbox and merge per field. An inbox decision is a live click and never queues.

Deckhand (github.com/owenpkent/deckhand): an observation-only surface for Claude Code sessions. Claude Code hooks call a shim that posts the hook JSON to a loopback daemon with a per-install token. One state machine per session: idle, thinking, needs input, complete, error, unknown, ended. It never starts a session. Hosted mode through the Agent SDK is Phase 4 and unbuilt. Its rules: every failure path resolves to ask, never to allow; loopback only; it never silently edits the user's Claude settings. Windows only today.

Anchor (github.com/owenpkent/anchor, private): a Python daemon that starts and owns Claude Agent SDK sessions, one client per turn with resume, in the agent's workspace, with settings sources off and MCP servers declared per agent in anchor.toml. A channel is three in-process async methods: post, request_approval, close_approval. Approvals are futures. The first answer wins. Fifteen minutes without an answer means the tool does not run, and the agent is told what it skipped. Audit is hash-chained JSONL that records who answered. No inbound port. Status: prototype scaffold, unit tested, not yet run against a live model. Its M0 list of SDK behaviours to verify is open. Multi-user is out of scope, with three hooks left for a team tier: the audit "by" field, a single place where policy scope is built, and agents as plain TOML tables.

Claude Code 2.1.284, as installed here: `claude --bg -p` starts a background session and prints its id. `claude agents --json` lists sessions. `attach`, `logs`, `stop`, and `rm` take the id. `--session-id` fixes the id ahead of time. `--permission-prompt-tool none` denies anything that would prompt. `-w` runs in a fresh worktree. `--max-budget-usd` caps spend. (Checked later on 2.1.292, docs/machine-runner-proposal.md: `--bg` and `-p` conflict, and the flag is `--permission-prompts none`, not `--permission-prompt-tool none`.)

## 1. What the button writes

### 1A. A claim through the existing task patch

The click sets `assignee` to the agent's name with the task PATCH route and nothing else. The button becomes a chip showing the agent, with "Take back" to clear it.

- Buys: no new route, event kind, or migration. Works offline, because an assignee edit is already an outbox op. The chip is the Assignee field with a different face.
- Costs: the handoff is only a field change in history. The brief is not stored; the agent builds it from the task over MCP.

### 1B. A handoff route

A new route sets the assignee, stores the brief as a system comment, and emits a new event kind.

- Buys: one event to subscribe to, a visible brief in the thread, room for options such as model, budget, or worktree.
- Costs: either a new offline op kind, which the closed list forbids without asking, or a live-only click. More to test. The brief duplicates the task.

### 1C. Stay copy-only

Keep the menu as it is and add "Assign to AI" as another copy action.

- Buys: no risk.
- Costs: it is not assignment. The task does not know it was handed off.

## 2. Who starts the agent

### 2A. Nobody: the agent pulls

The owner runs Claude Code wherever they like, with the Polaris MCP server attached. The agent's instructions say to search for tasks assigned to its name and work them.

- Buys: inside every current rule. No process management in Polaris. Works with any agent that speaks MCP.
- Costs: nothing happens until a session is running. A pulled task has no session id, so no attach or logs from the task.

### 2B. A `cc dispatch` command

The owner runs `cc dispatch <task>`. The command mints a session id, stores it on the task, and runs Claude Code in the background with the brief, the Polaris MCP config and nothing else, a fresh worktree, accept-edits mode, prompts denied, and a dollar cap.

- Buys: one command. The session id links the task to `claude agents`, `attach`, and `logs`. The worktree contains edits. A denied prompt means the agent reports back instead of hanging. The daemon is untouched.
- Costs: the command needs a working folder per project, which is a local path and needs the owner's word first. Permission handling is coarse: accept edits, deny everything else, no approvals. Claude Code only.

### 2C. The daemon spawns

- Buys: a click does everything.
- Costs: the daemon gains authority to run programs on the owner's machine, the reverse of its posture. It reads local paths. It is hard to state as an invariant. Not recommended.

### 2D. Anchor runs it

Anchor's Polaris channel sees the claim and runs a turn in the agent's workspace.

- Buys: policy, approvals, budgets, audit, and workspace confinement already exist and are tested. Polaris never touches a local path. Any SDK-driven agent, not only the Claude Code CLI. The task becomes the conversation thread, so a later comment by the owner continues the same session, and the task panel is the transcript Deckhand had no place for.
- Costs: Anchor is before M0. Two daemons in two languages. The channel needs a message schema agreed between the repos. Approvals need a surface (section 4).

## 3. How status comes back

### 3A. The agent writes it

Comments and status changes over MCP: in progress on claim, waiting when it needs a decision, done when the ticket kind allows.

- Buys: works today. The transport-fixed actor stays honest.
- Costs: no liveness. An agent that crashed looks like one that is thinking.

### 3B. A hook shim posts to Polaris

Deckhand's pattern. Claude Code hooks call a shim that posts to a loopback route with a token. Polaris keeps a state machine per session and shows a light on the task.

- Buys: live state for the owner's own sessions, not only Anchor's. Fail-silent when Polaris is down, so Claude Code is never slowed.
- Costs: a hook entry in the owner's Claude settings, installed by the owner and never by Polaris. A new route and token. Matching a session to a task needs the session id from 2B or from Anchor.

### 3C. Poll `claude agents --json`

- Buys: no hooks. Catches crashes.
- Costs: the daemon runs a program and reads the owner's session list. Coarse status.

### 3D. Anchor posts

Anchor's channel post lands as a comment. Turn start, end, and error map to a state.

- Buys: free with 2D.
- Costs: only for agents Anchor runs.

## 4. Approvals

### 4A. Not in Polaris

Approvals stay in the terminal, in Slack, or in Anchor's console. Polaris shows "waiting on you" at most.

- Buys: nothing new.
- Costs: the owner watches another surface. With 2B there are no approvals at all, only denials.

### 4B. An approvals table and a card on the task

Anchor, or a shim, opens a pending approval against a task. The panel shows an amber card with the tool summary and Approve and Deny buttons, 44px targets, Esc closes. The answer is a live click and never queues. Timeout stays deny on Anchor's side. A fourth token for the runtime may open approvals and may not decide them.

- Buys: the owner answers where the work is. First answer wins, so Deckhand or Slack can answer the same request. Anchor's audit gets a real name.
- Costs: a migration, routes, invariants, a shots state. The card must be disabled offline, and a pending approval must never replay from the outbox.

### 4C. Deckhand as the approval surface

- Buys: the glanceable board was designed for it.
- Costs: Deckhand's Phase 2 is unbuilt and its ADR unwritten. Windows only.

## 5. Agent identity

### 5A. Actor only

- Buys: nothing to do.
- Costs: history says "agent" for every agent.

### 5B. A name on events and comments

An optional actor name carried on the MCP connection, a header over HTTP or a flag on stdio, stored in a new column by an append-only migration.

- Buys: small. History reads "agent scribe". The actor enum and invariant 6 are unchanged.
- Costs: self-declared, not authenticated. Fine for one owner.

### 5C. Principals and per-agent tokens

A principals table (human or agent, name, enabled). `assignee` becomes a reference. One token per agent. Events record the principal.

- Buys: authenticated identity, and the foundation for a team. Anchor's audit "by" becomes a Polaris principal.
- Costs: a larger migration, including a change to what `assignee` means, which needs the owner's word. Token issuance and revocation in the dashboard and CLI.

## 6. Team

### 6A. One owner

- Buys: every invariant holds as written.
- Costs: no second person, and no second agent identity.

### 6B. A team of agents under one owner

Several agents, each a principal with its own token and workspace, pulling from the `ready` view, with claims visible in the dashboard. Every approval lands with the owner.

- Buys: the teammates initiative the schema comment already points at. No network change. "Propose, do not act" is unchanged, because one human still decides.
- Costs: needs 5C and a queue view per agent. Two agents claiming one task: the first write wins and the loser sees the assignee on its next read.

### 6C. Humans on a shared server

One Polaris reachable on a private network such as a tailnet, one token per person. Each task has an accountable owner. Inbox items are proposed to a person, and accept, reject, and goal status belong to that person.

- Buys: a real team product. The offline merge already handles two editors. Anchor's team-tier hooks line up.
- Costs: binding off loopback needs the owner's word. TLS or a tailnet. Token issuance and revocation. A per-person inbox and views. Who may assign to whom. Notifications. The README's stance changes, and several invariants are reworded from "the owner" to "the task's owner".

### 6D. Federated: one Polaris each, GitHub as the shared ledger

- Buys: no server change. GitHub is already the only external source and the untrusted-text rules already cover it.
- Costs: coordination only through issues. Claims are invisible across machines unless written to GitHub, which Polaris never does.

## 7. Transport between Polaris and Anchor

### 7A. Anchor polls Polaris

Anchor's channel polls the events feed and the tasks assigned to its agents with a runtime token, posts comments, opens approvals, and polls for the decision.

- Buys: Anchor keeps no inbound port. Polaris stays on loopback. Both postures unchanged.
- Costs: a few seconds of latency. A fourth token and its boundary rules.

### 7B. Polaris calls Anchor

- Buys: instant.
- Costs: Anchor needs a listener, against its own design.

### 7C. A shared file or database queue

- Buys: no network.
- Costs: two processes writing one database, against the rule that all persistence goes through the store. Lock files across two languages.

### 7D. MCP only, no channel

The Anchor agent uses the Polaris MCP server and self-reports. Approvals stay in Slack or the console.

- Buys: no Anchor change beyond anchor.toml.
- Costs: nothing starts the turn without a scheduled job polling the queue. No approvals in Polaris.

## Recommended path

1. Stage 1: 1A, 2A, 3A, 5B. The button is a claim. The agent pulls over MCP and writes its own status. History names the agent. Nothing in "When to ask" is touched.
2. Stage 2: 2B, with 3B optional. A `cc dispatch` command, after the owner has given a working folder per project. The task carries the session id.
3. Stage 3: 2D, 7A, 4B, 5C, after Anchor's M0 passes. Anchor runs the agent, approvals land on the task, agents are principals with tokens.
4. Stage 4: 6B. Several agents under one owner.
5. Later: 6C, only when a second human is real.

## What each stage touches in "When to ask"

- Stage 1: nothing.
- Stage 2: a local path per project.
- Stage 3: a migration adding tables, a fourth token, and approvals as a new live-only control with no offline op kind.
- Stage 4: `assignee` becomes a reference, which changes the meaning of an existing column.
- 6C: a non-loopback bind, and the rules about who decides.

## Invariants to add when the stages land

- An approval is never created, decided, or closed by a rule, and never queued offline.
- The runtime token cannot decide an approval, enable a rule, accept or reject an inbox item, or set a goal's status.
- A timeout never becomes an approval.
- A principal's token writes only as that principal.
- Polaris never starts a program, and never reads an agent's workspace.

## Open questions

- Anchor M0: can the approval callback block for fifteen minutes without the CLI timing out?
- Where the transcript goes. Comments on the task is the proposal, but a long turn produces a lot of text. Turn summaries plus a pointer to `claude logs <id>` may be enough. A task's thread (docs/agent-threads-proposal.md) is now the place for an argument with other agents, but it is typed posts the owner judges, not a transcript.
- The teammates initiative document in the private constellation repo (initiatives/teammates-and-goals.md) may already settle identity and assignment. It was not read for this exploration.
- One message schema for the three channel methods plus session start and end, shared by the Polaris and Deckhand channels. The approvals table could be its persistent form.

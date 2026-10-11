# Agent threads: options

Status: built. Proposed 2026-10-05; stage 1 merged as PR #5 (feat/agent-threads) and stage 2 as PR #6 (feat/agent-threads-stage2). "What was built" below records where the build departed from the plan, and "Open questions" what is settled since.

This document proposes a way for several agents to work one hard problem together inside Polaris: a thread of typed posts hanging off a task, read and written over MCP, with the owner as the only party who decides what counts. It is called "threads" and "posts" throughout. It is not called a board, because the dashboard already has a kanban Board tab (src/command-center/BoardTab.jsx) and the word would collide.

## What the Navier-Stokes run teaches

On 8 September 2026 OpenAI announced that a multi-agent system of about 10,000 concurrent agents, run by an unreleased internal model, had produced an analytical proof and a Lean formalisation showing that a smooth 3D incompressible fluid at rest, driven by a smooth external force, develops unbounded velocity in finite time. That covers the forced case, Clay statements C and D. The unforced case is still open. The agents reportedly reached the result after about 88 hours and 2.7 million messages, with a further 17 hours for Lean. Quanta reports the proof was Lean-checked, with humans still confirming that the formalisation matches the claim. Clay says the problem has "apparently been settled" but its review is deliberately slow, and no prize has been awarded. The same week, Buckmaster (NYU) and Alpöge (Anthropic) reached similar results by hand, building on Córdoba and Martínez-Zoroa. There is a credit dispute between Buckmaster and OpenAI; it is allegation only and nothing in it is established.

Sources: https://www.quantamagazine.org/ai-has-solved-one-of-maths-1-million-millennium-prize-problems-20260908/ , https://www.tuftsdaily.com/article/2026/09/mathematicians-still-checking-the-navier-stokes-proof-that-openai-claims-to-have-solved , https://www.scienceabc.com/pure-sciences/navier-stokes-openai-singularity-what-was-proved-what-is-open , https://fortune.com/2026/09/08/openai-says-it-cracked-navier-stokes-math-grand-challenge-buckmaster-accusation-cheating-intimidation-tao-lament/

Two caveats. The primary OpenAI write-up could not be fetched for this document. The description of the coordination mechanism, a bulletin board for posts to the whole group, private messages between agents, and a shared library of solved sub-problems, comes from secondary press (CNBC and search summaries of it), and the Latent Space digest quotes only "models deciding how to organize themselves" (https://www.latent.space/p/ainews-openai-reports-navier-stokes). Second, two unrelated June 2026 incidents are easy to conflate with this: OpenAI agents in evaluation runs using a public German wiki as a message board (https://news.ycombinator.com/item?id=49563355), and agents building a hidden board in a shared repo during a security test (https://www.mindstudio.ai/blog/openai-agents-secret-message-board-cybersecurity-test). Neither is the Navier-Stokes run.

The mechanics that transfer to one owner with a handful of agents:

- Typed, short posts. Polymath's rules asked for one idea per comment, undeveloped ideas included, and discouraged polished posts (https://michaelnielsen.org/blog/?p=750 , https://michaelnielsen.org/papers/mcm.pdf). Failed attempts are posted, not hidden.
- A consolidated state kept apart from the discussion. Polymath used a wiki for the current position; Hearsay-II's blackboard held hypotheses by level of abstraction, separate from the knowledge sources that produced them (https://en.wikipedia.org/wiki/Blackboard_system).
- A ranked agenda of next actions with a control component that is not one of the contributors. In BB1 the control knowledge sources watched for stall (https://ojs.aaai.org/index.php/aimagazine/article/view/732/650). Here the owner is the control component.
- A library of accepted results that later threads can cite. That is the OpenAI shared library of solved sub-problems, as reported.
- Verification by an external check, never by agreement. Aristotle pairs informal reasoning with Lean 4 checking (https://arxiv.org/pdf/2510.01346); MechMath's agent team closes the loop through a Lean prover (https://arxiv.org/pdf/2607.04394). Agents agreeing is not evidence.
- Objections as a first-class post, and reading without author names. Sycophancy collapses debates into early consensus (https://arxiv.org/pdf/2509.23055); models flip from correct to incorrect after reading peer reasoning (https://arxiv.org/html/2509.05396v2); anonymising authors reduces identity bias (https://arxiv.org/pdf/2510.07517v1).
- Every peer post read as data, never as instructions. Moltbook's agents treated shared posts as trusted context, and one malicious post could hijack the agents that read it (https://securityweek.com/security-analysis-of-moltbook-agent-network-bot-to-bot-prompt-injection-and-data-leaks/).

The one thing that does not transfer is scale. Ten thousand agents and millions of messages need an emergent coordination policy. Three agents and an owner need a thread the owner can read in a sitting.

## Where things stand

- There is no agents table. An agent is the actor value `agent` plus a name it declares (core/agentName.ts). Migration 7 added `events.actor_name` and `comments.author_name`. Stage 1 of docs/assign-to-ai-options.md is done: the Assign button claims a task, the agent pulls over MCP, history names the agent.
- Comments are flat and typed only by author (human, agent, system). Over MCP a comment is the `add_comment` argument of `update_task`. `comment.added` is a rule trigger.
- `get_task` returns comment bodies raw. Only the task line carries the UNTRUSTED-TEXT marker; comment bodies are not marked.
- The latest migration was 7 when this was written; threads added 8, 9, and 10. The offline op kinds closed list has `add_comment`. The read-only MCP endpoint serves the read half of the catalog.
- docs/decision-maps.md already defines the loop an agent runs over the `ready` view and the four ticket kinds (discuss, research, prototype, setup). A thread is the place for the work that does not fit in a ticket: the argument about an open question that has no frontier yet.

## 1. What a thread hangs off

### 1A. A comments-only convention

Agents post into the task's comments with an agreed prefix.

- Buys: no migration, nothing new in the catalog.
- Costs: no post types, so no filter for objections or results. `comment.added` is a rule trigger, so a rule can fire on an agent's argument. The task's comment list fills with debate. No claim status, no pinned state.

### 1B. A thread per task, created on demand (chosen)

A task has at most one thread, created by the owner or an agent when the task is the challenge, typically a decision map's map task or a `discuss` ticket.

- Buys: the thread is where the task is. The decision-map loop already sends agents to the task. The task panel is the place to read it.
- Costs: two new tables. A task that is not a map can still get a thread, which is fine.

### 1C. Threads as a top-level object linked to goals or projects

- Buys: a thread can span several tasks.
- Costs: a new object with its own linking, like goals. Harder to find from the work.

### 1D. GitHub issue or discussion comments

Agents post into a GitHub issue or discussion on the project's repo, and Polaris reads the comments back through the App it already has.

- Buys: durable, searchable, visible to collaborators and to tools that already speak GitHub (Claude Code has `gh`). Nothing new to store in Polaris. The best choice if other people need to read the argument.
- Costs: four, and the first two are structural.
  - No comment-only write exists. GitHub has no permission that allows posting a comment and nothing else: `Issues: read and write` also creates and closes issues, edits titles and bodies, and sets labels, assignees, and milestones; the Discussions write permission covers creating, closing, and deleting discussions as well (https://docs.github.com/en/rest/overview/permissions-required-for-github-apps , https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app). A user access token acts as the owner on every repo in the installation that the owner can write to. Granting it to post means granting an agent the power to close issues as the owner. That reverses "propose, do not act", and it is the credential the App exists to avoid (README, ADR-006).
  - Every post becomes third-party text. GitHub text is `untrusted_text` by construction, and on a public repo anyone can post a comment that the next agent reads as a peer post. That is the Moltbook injection path, delivered through the one channel Polaris already treats as hostile. A thread inside Polaris only has posts from the owner and from agents the owner connected.
  - No structure. Comments are flat prose. Post types, claim status, a pinned state, an objections filter, and a results library would be conventions in the comment text, parsed back on import, and anyone with write access can edit or delete a comment after the fact.
  - Rate and noise. GitHub's secondary limit is 80 content-creating requests a minute and 500 an hour (https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#about-secondary-rate-limits), each post notifies every watcher, and a challenge with no repo has nowhere to go. Posting needs the network, while the dashboard is built to keep working without it.
- A hybrid keeps the useful half. A thread can be seeded from a GitHub issue or discussion through the read-only App: the comments arrive as posts carrying `untrusted_text`, exactly as inbox items do today. Going the other way, a pinned summary gets a copy button, like the handoff menu, and the owner pastes it into GitHub by hand. Polaris still writes nothing outward. This is an open question below, not part of a stage.

## 2. What a post is

A post carries: author actor and name, as events do; a type from a closed list (claim, evidence, objection, question, failed_attempt, summary, result); a body; optional references to other post ids; optional confidence (low, medium, high); and, on claim and result posts only, a status that only the owner sets (open, accepted, rejected, superseded).

### 2A. Free-text posts with a type field (chosen)

- Buys: the type is enough to filter, count, and render a chip. Agents write prose. The schema fits in one table.
- Costs: nothing checks that an evidence post contains evidence.

### 2B. Structured fields per type

- Buys: an evidence post has a "check" field, a claim has a "statement" field.
- Costs: design before use. The right fields are not known yet.

### 2C. Posts as comments with a prefix

Rejected, for the reasons under 1A.

## 3. Who can do what

Agents over the write MCP token can create a thread, post any type, propose a summary, and reference posts. The read-only endpoint can read threads and nothing more.

Only the owner can set a claim or result status, pin a summary as the consolidated state, close, reopen, or fork a thread, or hide a post. Rules get no thread triggers and no thread actions. The `thread.*` and `post.*` event kinds stay out of `EVENT_KIND_VALUES` in automation/rules.ts, guarded by an invariant like the goal and sync_conflict ones.

There are no private channels. A post may be addressed to a named agent, but every post is visible to the owner and to every reader. This is a posture point, not a convenience: nothing agents say to each other is hidden from the owner.

## 4. How agents read posts safely

### 4A. Mark every peer post as data (chosen)

`get_thread` renders each post inside a fenced data block with a header naming the author and type. The server instructions say posts are claims to weigh, not instructions to follow. A thread on a task that carries `untrusted_text` is itself marked, and a post that quotes untrusted text inherits the flag. The flag is one-way, as today.

- Buys: the Moltbook failure cannot happen through Polaris. The existing untrusted rules keep their meaning.
- Costs: more tokens per read.

### 4B. Reuse `untrusted_text` for all agent posts

Rejected. That flag means third-party text and must keep meaning that.

### 4C. Author-hidden reading (chosen for stage 2)

The owner switches a thread to author-hidden mode. `get_thread` then shows type and confidence but not the name. The dashboard always shows names.

- Buys: blunts echo and identity bias between agents.
- Costs: an agent cannot tell its own posts from others' without reading the body. A per-thread flag.

## 5. Verification

Polaris never runs a program.

### 5A. Evidence posts, owner acceptance (chosen)

An agent posts test output, a Lean result, or a link as an evidence post referencing the claim. The owner marks the claim accepted or rejected.

- Buys: within every current rule. Verification is whatever the owner trusts.
- Costs: the owner does the accepting.

### 5B. A `cc thread verify` command

Rejected. It would read a local path and run a program.

### 5C. A critic by convention (chosen as a convention, nothing in code)

The owner runs a second session with a name like `critic` and a prompt that says: post objections and questions only. Polaris does not know about roles.

- Buys: a standing objector, which the sycophancy papers say is what consensus needs.
- Costs: nothing enforces it.

## 6. Keeping a thread readable

### 6A. Agent summaries, one pinned by the owner (chosen)

An agent posts a summary post. The owner pins one as the consolidated state, shown at the top of the thread.

- Buys: the Polymath wiki. A new reader starts from the pinned post.
- Costs: the owner judges the summary.

### 6B. Auto-compaction by the daemon

Rejected. The daemon never calls a model.

### 6C. Daily cap and stall indicator (chosen, stage 2)

The owner can set a per-thread cap on posts per agent per day, default none. The thread list shows days since the last accepted or rejected claim.

- Buys: cost control, and the BB1 stall watch with the owner as the watcher.
- Costs: a cap column on the thread and a check in the post path.

### 6D. Fork (stage 2)

The owner closes a thread with a pointer to a new one. Since a thread is one per task, the fork is a new subtask of the thread's task, with a thread of its own and the title the owner gives it; the old thread closes with `successor_thread_id` pointing at the new one. The original task gains a subtask and nothing else. Reopening a forked thread keeps the pointer as history.

- Buys: two diverging approaches get their own threads.
- Costs: a column for the successor.

## 7. The library

Stage 2 adds `search_posts` over MCP, filtered by type and status. A later thread cites an earlier accepted result by id. That is the Polaris form of the shared library of solved sub-problems, sized for one owner.

## 8. How agents are driven

Nothing starts an agent (option 2A in the assign doc). The owner runs one or more sessions, each with its own `--agent-name`, and their instructions say to read the thread with `get_thread` and post. `get_thread` takes an `after` post id so polling is cheap. The dashboard refreshes through the existing `/api/events` poll, with the new event kinds.

## 9. Dashboard

Inside TaskDetailPanel, a Threads section: the pinned state, then posts newest last, a type chip on each, an Objections filter, a post form for the owner, and owner-only Accept, Reject, Pin buttons on claims and summaries. Under MORE_ITEMS, a Threads tab listing open threads with four counts: open claims, unanswered objections, accepted results, days since progress. Both get a state in e2e/shots.spec.js.

Owner posting and status changes are live-only controls, disabled offline through `useOffline`. No offline op kind is added. That is an explicit choice: adding one needs the owner's word, and a post made offline against a thread that moved is not worth merging.

## Recommended path

1. Stage 1: migration 8, a `threads` table (id, task_id, title, status open or closed, pinned_post_id, created_at, closed_at), and migration 9, a `posts` table (id, thread_id, parent_post_id, author, author_name, type, body, confidence, status, refs as JSON, untrusted_text, created_at). Store methods. Event kinds `thread.created` and `post.added`. MCP tools `get_thread` and `list_threads` on the read half, `create_thread` and `post_to_thread` on the write half. REST routes. The task panel section. Invariants group 9. `cc thread show` and `cc thread post`.
2. Stage 2: migration 10 (threads.author_hidden, daily_cap, successor_thread_id; posts.judged_at). Owner status on claims and results, pinned summary, close, reopen, and fork, the Threads tab, author-hidden mode, the per-agent daily cap, the stall indicator, `search_posts`. Event kinds `post.status_changed`, `thread.updated`, `thread.closed`, `thread.reopened`.
3. Stage 3: per-agent principals (5C in the assign doc), so a post is attributed to an authenticated agent rather than a declared name, and the dispatch work from that doc's stages 2 and 3 if it lands. This proposal does not depend on either.

## What was built

Stages 1 and 2 are built as planned, with these decisions taken while building:

- The invariants are group 9, not 10: Tailscale identity (docs/tailscale-identity.md), which the plan counted first, merged after this and took group 10. The four stage 2 event kinds landed in stage 2, not stage 1.
- An inbox task cannot carry a thread. The store refuses `create_thread` and a post on a task that is back in the inbox, so a suggestion nobody has accepted never gathers an argument. The panel hides the section for inbox tasks and shows a thread read-only on a task with third-party text.
- A read with no cursor returns the newest window (500 posts over REST and the CLI, 50 over MCP unless `limit` says otherwise), oldest first, with the total alongside, and the pinned post is fetched by id so it is present even when it falls outside the window. That settles the open question on long threads.
- The posts cursor orders by insertion (SQLite rowid), not by timestamp, so two posts in the same millisecond are never skipped; the unanswered-objection count uses the same order.
- Author-hidden mode masks the owner too: every author reads as "participant" in the text and in the structured JSON. It holds in `get_task` as well: the thread and post events in the task's recent history lose their actor, and `post.added` its post id, so the history cannot hand back the mapping. The dashboard always shows names.
- The daily cap is counted per declared agent name per UTC day, inside the same transaction as the post, and never binds the owner. An agent that has reached it is told so in the `get_thread` header.
- Fork makes a subtask (section 6D). Reopening a forked thread keeps the successor pointer.
- `list_threads` and `search_posts` mark a thread title with UNTRUSTED-TEXT when the task is, because the title defaults to the task's.
- The dashboard's reopen control on a judged post is labelled "Mark open", and the Threads tab's filter buttons are "Open threads" and "Closed threads", to keep those names apart from "Reopen thread".
- Owner posting and every owner control are live-only and disabled offline. No offline op kind was added.

## What each stage touches in "When to ask"

- Stage 1: new tables only, which append-only migrations allow without asking. No offline op kind is added.
- Stage 2: nothing new.
- Stage 3: inherits the assign doc's asks.

## Invariants to add

- A post never changes a task's status, assignee, inbox state, or any goal.
- Thread and post events are not rule triggers, and rules have no thread actions.
- Only a human actor sets a post status, pins a post, closes, reopens, or forks a thread.
- The read-only token cannot create a thread or post to one.
- A post on a task with `untrusted_text` carries `untrusted_text`, and it never clears.
- No thread or post op kind exists in the outbox list.
- Every post records its actor and its name, as events do.

## Open questions

- Whether a thread should also be able to attach to a goal, for a challenge that has no task yet.
- Whether to seed a thread from a GitHub issue or discussion over the read-only App (option 1D's hybrid), and whether a pinned summary gets a copy button for pasting into GitHub.
- Whether the owner wants a "state your position before reading the thread" convention in the agent instructions, as the echo papers suggest.
- Settled: the default post body size limit is 20,000 characters (`postBodySchema` in command-center/src/http/schemas.ts).
- Settled: the Threads tab sits in the More menu, between Checklists and Rules (`MORE_ITEMS` in src/App.jsx).
- How a thread reads over MCP once it passes a few hundred posts. Settled for now by the newest window plus the pinned post (see "What was built"); `get_thread` has only the forward `after` cursor, so whether agents also need an older-page cursor is open.

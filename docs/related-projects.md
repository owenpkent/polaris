# Related open source projects

Researched on 2026-11-17. This is a reading list, not a feature comparison: for each project it names the one or two design decisions worth studying, links the page or file, and says where Polaris stands today.

How to read an entry:

- **Have it** means Polaris already does this; the link is a second opinion on the same design.
- **Gap** means Polaris does not do this and could.
- **Owner's call** means the idea touches a rule under "When to ask" in CLAUDE.md, so it is listed for a decision, not as a recommendation.

Every repository below was confirmed to exist and to be active in 2026 unless the entry says otherwise. "Not read in full" means only the README or a summary was read, so check the source before borrowing. Nothing here has been built.

## Shortlist

The eight most useful things found, best first.

| # | Idea | From | Polaris today |
|---|---|---|---|
| 1 | Test every small pattern and input up to a bound, next to the random fuzzing | RE2 | Gap. The two matcher bugs fixed in #191 took nights of random fuzzing to surface; a bounded sweep finds that kind in seconds |
| 2 | A hybrid logical clock for "newer edit wins" | Actual Budget | Gap. The outbox merge orders edits by the device's own clock, clamped to now, so a phone whose clock runs behind loses to an older edit |
| 3 | Written failure cases of merging per field | Super Productivity | Have it. Their two design notes are a checklist to read our merge against |
| 4 | Check the Tailscale identity with a lookup, not the header alone | golink | Gap. Polaris checks loopback peer, the header, and the origin of a write, and does no lookup |
| 5 | Model-based tests: a plain object as the model, the real Store beside it | fast-check | Gap. No test uses `fc.commands` yet; the outbox merge is the natural first target |
| 6 | A dated freshness record, so a blocked release check is noticed | TUF | Owner's call. A signed tag proves who signed, not that it is the newest |
| 7 | Show third-party text by who wrote it, and call the filter "not a boundary" | GitHub MCP server | Owner's call. Polaris flags all third-party text alike |
| 8 | Skip fuzz crashes already reported, and prune the corpus on a schedule | ClusterFuzzLite | Gap. The corpus is cached between nights; nothing prunes it or recognises a known crash |

## Task trackers and offline sync

**[Super Productivity](https://github.com/super-productivity/super-productivity)** (MIT). A local-first task app whose sync is built on an operation log.

- [Per-field resolution](https://github.com/super-productivity/super-productivity/blob/master/docs/sync-and-op-log/lww-field-level-resolution.md): records the bug where merging a whole task erased a concurrent edit to a field nobody touched, and the fix of sending only the winning fields.
- [Conflict journal and review](https://github.com/super-productivity/super-productivity/blob/master/docs/sync-and-op-log/conflict-journal-and-review.md): why they retired a review page for losing edits.
- Polaris: **Have it** (core/outbox.ts merges per field and keeps the loser as `task.sync_conflict`). Worth reading for the failure cases, and for their reasons against a review page before one is ever proposed here.

**[Actual Budget](https://github.com/actualbudget/actual)** (MIT). A local-first finance app: every change is a message for one cell, stamped by a hybrid clock, and the newest stamp wins.

- [timestamp.ts](https://github.com/actualbudget/actual/blob/master/packages/crdt/src/crdt/timestamp.ts): the clock itself, with a node id and a limit on drift.
- [The sync folder](https://github.com/actualbudget/actual/tree/master/packages/loot-core/src/server/sync): applying, deduplicating, and holding messages.
- Polaris: **Gap**, item 2 of the shortlist.

**[TaskChampion](https://github.com/GothenburgBitFactory/taskchampion)** (MIT). The sync core of Taskwarrior.

- [Sync model](https://github.com/GothenburgBitFactory/taskchampion/blob/main/docs/src/sync-model.md): three operations only, and written rules for replaying one against a task that changed or is gone (a create on an existing task and a delete on a missing one do nothing).
- Polaris: **Have it** in part (an op id makes a replayed create or comment apply once). Their written no-op rules are a good model for documenting ours.

**[Vikunja](https://github.com/go-vikunja/vikunja)** (AGPL-3.0). A self-hosted task manager.

- [tasks.go](https://github.com/go-vikunja/vikunja/blob/main/pkg/models/tasks.go), `TaskRepeatMode` and `addRepeatIntervalToTime`: three repeat modes including "from the day it was completed", and an interval step made constant-time after a security advisory (a huge repeat count on an old due date).
- [quickAddMagic](https://github.com/go-vikunja/vikunja/tree/main/frontend/src/modules/quickAddMagic): typed quick-add split into small parsers (date, repeat, priority), each with its own tests.
- Polaris: recurrence has a fuzz target already. The quick-add parser layout is a **Gap** only if typed quick-add is ever wanted, which for a pointer-first owner is a low priority.

**[Tasks.org](https://github.com/tasks/tasks)** (GPL-3.0). An Android task app. Not read in full.

- [The repeats folder](https://github.com/tasks/tasks/tree/main/app/src/main/java/org/tasks/repeats): a mature phone picker for repeat rules.
- Polaris: a reference for the look of a repeat picker on a phone.

**[Replicache and Zero](https://github.com/rocicorp/mono)** (Apache-2.0). Sync engines built on named mutators replayed on the server.

- [mutation-recovery.ts](https://github.com/rocicorp/mono/blob/main/packages/replicache/src/mutation-recovery.ts): recovering queued changes after a crash.
- Polaris: **Have it** in shape (the closed list of outbox op kinds is the same idea).

Checked and left out: Huly and Plane (team trackers, nothing specific found), ElectricSQL and PowerSync (active, not read), cr-sqlite (quiet since August 2026). Nothing was found on phone row density or on importing from GitHub without acting for the user.

## Trackers and safety designs for AI agents

**[GitHub MCP server](https://github.com/github/github-mcp-server)** (MIT). GitHub's own server for agents.

- [Server configuration](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md): lockdown mode shows text from a public repo only when its author can push to it; the page calls this "a best-effort content filter, not a security boundary". Read-only mode wins over every other setting and also exists as a `/readonly` path.
- Polaris: the read-only endpoint is **Have it**. Author trust is **Owner's call**, item 7 of the shortlist: it would add information to the `untrusted_text` flag and must never clear it.

**[beads](https://github.com/gastownhall/beads)** (MIT). An issue tracker made for coding agents. Not read in full.

- `bd ready` lists work with nothing blocking it; `bd update --claim` takes a task in one step so two agents cannot both take it; old closed work is summarised to save space ([dolt.md](https://github.com/gastownhall/beads/blob/main/docs/architecture/dolt.md)).
- Polaris: tasks already have an assignee and a blocked filter. An atomic claim is a small **Gap**. Summarising old threads is **Owner's call** (a pinned summary is the owner's alone).

**[MCP specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)**.

- Tool annotations such as `readOnlyHint` are hints a client must not trust, so the real split has to live in the server. [Elicitation](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation) lets a server ask the human through the agent's client.
- Polaris: **Have it**, and stricter: owner actions have no MCP tool at all. Elicitation would move an owner decision into the agent's client, so it is **Owner's call**, and my advice is to leave it.

**[MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail)** (licence not confirmed). A mailbox for several coding agents. Not read in full.

- File reservations are leases with an expiry, not locks. "Discovery is not authorization": one project messages another only over an approved link.
- Polaris: an expiring claim pairs with the beads idea above.

**[Backlog.md](https://github.com/MrLesk/Backlog.md)** (MIT). Tasks as Markdown files with an MCP server.

- Guidance for agents is served as MCP resources, which keeps tool descriptions short.
- Polaris: a small **Gap** worth trying if tool descriptions grow.

**[Task Master](https://github.com/eyaltoledano/claude-task-master)** (MIT with Commons Clause, so not open source in the usual sense; quiet since April 2026).

- One setting cuts the tool list from 36 tools to 7, about a quarter of the size in the agent's context.
- Polaris: a size tier is a possible third endpoint. **Owner's call**, low priority.

**Spotlighting** ([paper](https://arxiv.org/abs/2403.14720)) and **CaMeL** ([paper](https://arxiv.org/abs/2503.18813), [code](https://github.com/google-research/camel-prompt-injection), Apache-2.0, research only).

- Three ways to mark third-party text: delimiting, datamarking (a marker woven through the text), and encoding. Delimiting fails when the text can close the delimiter.
- Polaris: **Have it** for delimiting, with the known weakness closed (mcp/format.ts picks a fence one backtick longer than any run in the body). Datamarking is the remaining idea, a small **Gap**.

**[The lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)** (essay). An agent that has read untrusted text must not be able to trigger an action that matters. This is the reasoning behind the inbox and disabled rules, in one sentence, and would make a good opening line for invariants.test.ts.

Checked and left out: Vibe Kanban (its README says it is being shut down). Not examined: OpenHands, the Linear and Notion servers. No project was found that states its safety rules as one executable test file, as invariants.test.ts does.

## Backups, updates, and Tailscale identity

**[golink](https://github.com/tailscale/golink)** (BSD-3-Clause). Tailscale's own small app with SQLite and identity headers: the closest reference there is to http/tailscale.ts.

- [golink.go](https://github.com/tailscale/golink/blob/main/golink.go): trusts the login header only from loopback, then confirms it with a WhoIs lookup on the forwarded address, and gives a failed lookup no admin rights. A write needs a custom header a cross-origin page cannot set, or a token.
- Polaris: loopback and origin checks are **Have it**. The lookup is a **Gap**, item 4 of the shortlist.

**[age](https://github.com/FiloSottile/age)** (BSD-3-Clause), with its [format spec](https://github.com/C2SP/C2SP/blob/main/age.md). The benchmark for an encrypted file format.

- The header is authenticated, the work factor is capped on read, and the payload is encrypted in 64 KiB chunks with a final-chunk flag.
- Polaris: authenticated header and capped work factor are **Have it** (daemon/backupCrypto.ts). The file is encrypted in one piece, so it is held in memory whole: fine at today's size, a **Gap** only if the database grows large.

**[The Update Framework](https://theupdateframework.github.io/specification/latest/)** (spec; [python-tuf](https://github.com/theupdateframework/python-tuf), Apache-2.0).

- What it adds to a signed tag: an expiry so an attacker cannot hide new releases (a freeze), versions that never decrease, and key rotation signed by both the old and the new key.
- Polaris: never-decreasing versions and pinned signers are **Have it**. Freshness and a two-key rotation rule are **Owner's call**, item 6 of the shortlist. All of TUF would be too heavy here.

**[RAUC](https://github.com/rauc/rauc)** (LGPL-2.1). An update client for embedded Linux. [Reference](https://rauc.readthedocs.io/en/latest/reference.html), not read in full.

- Counts failed starts before falling back, and has a lowest allowed version that its own docs warn can clash with rolling back a bad release.
- Polaris: health check and rollback are **Have it**. The warning is the useful part if a version floor is ever added.

**[Litestream](https://github.com/benbjohnson/litestream)** (Apache-2.0). SQLite replication.

- [restore](https://litestream.io/reference/restore/): a dry run that prints the plan, an integrity check after restoring, and a refusal to overwrite a file without force.
- Polaris: **Have it** (`cc backup check` runs an integrity check and never opens the store).

**[Syncthing](https://github.com/syncthing/syncthing)** (MPL-2.0).

- [upgrade_supported.go](https://github.com/syncthing/syncthing/blob/main/lib/upgrade/upgrade_supported.go): the signature covers the file's name as well as its bytes, so it cannot be replayed onto another release.
- Polaris: **Have it** for the server (a signature must be named for its tag).

**[Obtainium](https://github.com/ImranR98/Obtainium)** (GPL-3.0). Installs Android apps from GitHub releases. Not read in full.

- Publishes its signing certificate's fingerprint so anyone can compare it.
- Polaris: a small **Gap**: print the APK certificate's fingerprint in docs/releases.md.

Checked and left out: PocketBase (a comparison point only). Not verified: Home Assistant, tsidp, tclip, sqlite3_rsync, Sigstore, minisign, Sparkle, Miniflux, Forgejo.

## Accessibility and testing

**[Pragmatic drag and drop](https://github.com/atlassian/pragmatic-drag-and-drop)** (Apache-2.0, licence not confirmed). Its [accessibility guideline](https://atlassian.design/components/pragmatic-drag-and-drop/accessibility-guidelines/) was read as a summary only.

- Every item gets a button that opens a menu of moves, and each label names the item ("Move task 'clean dishes' to top of backlog").
- Polaris: **Have it** (ReorderHandle.jsx and the task menu). Worth comparing our labels with theirs.

**[React Aria](https://github.com/adobe/react-spectrum)** (Apache-2.0). [Drag and drop](https://react-aria.adobe.com/dnd).

- A list is one Tab stop, arrows choose the slot, Enter drops, Esc cancels, with an announcement at each step.
- Polaris: a second opinion on the keyboard path of reordering.

**[GitHub's write-up on accessible sortable lists](https://github.blog/engineering/user-experience/exploring-the-challenges-in-creating-an-accessible-sortable-list-drag-and-drop/)** (summary only). They chose a move dialog as the alternative to dragging. The two WCAG criteria behind this, 2.5.7 and 2.5.8, are already cited in docs/ui-psychology.md.

**[RE2](https://github.com/google/re2)** (BSD-3-Clause).

- [exhaustive_tester.cc](https://github.com/google/re2/blob/main/re2/testing/exhaustive_tester.cc): generates every pattern and every input within small bounds and checks that all its engines agree.
- Polaris: **Gap**, item 1 of the shortlist. automation/pattern.ts has random differential fuzzing and no bounded sweep.

**[re2js](https://github.com/le0pard/re2js)** (MIT). A JavaScript port of RE2.

- One differential fuzzer per pair of engines, each with a written list of intended differences, and refused syntax tested as an error.
- Polaris: **Have it** in part (one fuzzer against RegExp, refusals tested). The written list of intended differences is the piece to copy.

**[fast-check, model-based testing](https://fast-check.dev/docs/advanced/model-based-testing/)** (MIT).

- Random sequences of commands run against the real system and a simple model, which must agree; a failing sequence can be replayed.
- Polaris: **Gap**, item 5 of the shortlist.

**[ClusterFuzzLite](https://google.github.io/clusterfuzzlite/running-clusterfuzzlite/github-actions/)** (Apache-2.0, quiet since February 2026). It does not run Jazzer.js, so it is a design reference only.

- Separate jobs for nightly fuzzing, pruning the corpus, and coverage; a known crash is not reported twice.
- Polaris: **Gap**, item 8 of the shortlist.

**[Playwright snapshots](https://playwright.dev/docs/test-snapshots)**.

- A stylesheet that hides parts that change, a pixel allowance, and baselines made on one machine type only.
- Polaris: the shots baseline is local and noisy from day to day. A baseline made in CI is a **Gap** worth weighing.

**Is Jazzer.js safe to depend on?** [The repository](https://github.com/CodeIntelligenceTesting/jazzer.js) (Apache-2.0) is maintained: version 4.0.0 came out in April 2026 after a gap of two and a half years, and work continues. It is small and driven by one company. Acceptable while it stays a nightly, development-only tool; no recommended replacement was found.

Checked and left out: Lost Pixel (archived in April 2026), dnd-kit (only matters if dragging is added). Not verified: GOV.UK frontend, Primer's target-size page. Nothing was found on software made for dwell clicking or on-screen keyboards.

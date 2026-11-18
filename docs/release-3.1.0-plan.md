# Release 3.1.0 plan

## 1. What this is

A plan for merging the open, reviewed pull requests and the notes for the release that follows.
Nothing in it has been done. The release pull request moves the notes into CHANGELOG.md and
deletes this file. Written on 2026-11-18.

## 2. Version

Propose 3.1.0. The batch adds features (the Device clock row on Settings, the phone layout changes
of My tasks), and this repository's own history bumps the minor number for features (2.7 through
2.10). The number is the owner's call. 3.0.1 was the working name earlier, and it would be the
choice if the batch is read as fixes only.

## 3. Merge order

Sixteen pull requests are open and reviewed on their head commits: #186 to #201. Their titles and
base branches were checked with `gh` on 2026-11-18 and match the plan. None of them touches
`command-center/src/core/schema.ts`.

Not part of this plan:

- #168: older, a docs change, not reviewed in this batch.
- #175 and #176: Dependabot pull requests that #188 replaces. They should close by themselves once
  #188 is merged. Close them by hand if they do not.

### Rules for the whole batch

- No merge without a review on the head commit, and the owner gives the word for each merge.
- Branch protection does not require branches to be up to date, so a pull request needs updating
  only when it conflicts.
- Two stacks. Stack A: #191, then #193 (base `fix/nightly-fuzz`). Stack B: #195, then #199 (base
  `feat/offline-order-and-server-time`), then #201 (base `feat/settings-clock-line`). The parent
  is always merged first.
- When a parent is squash-merged and its branch deleted, GitHub retargets the child to main. The
  child then usually shows conflicts, because its history still holds the parent's commits. Merge
  main into the child's branch, keeping the child's side for the files the parent touched, and
  check that the resulting tree equals what a rebase would give.
- After that the child's head commit is new. Post its review again on that commit, or the Reviewed
  check stays red. CI's browser tests also run on it for the first time, because they do not run
  on a pull request whose base is not main. For #199 this first full browser run matters: it
  changes the test fixture for every UI test.
- Files that more than one pull request touches, so a later one may need its branch updated after
  an earlier one merges (and then a fresh review on the new head):
  - CLAUDE.md: #189, #190, #195, #199, #201
  - CONTRIBUTING.md: #190, #191, #193, #201
  - command-center/README.md: #186, #187, #191, #195, #199
  - e2e/support.js: #190, #199
  - package.json: #197, #201
  - mobile/package.json: #196, #201

### Steps

1. Merge #188 (hono and @hono/node-server security updates, lockfile only). Then check that #175
   and #176 have closed. Close them by hand if not.
2. Merge #198 (GitHub Actions updates: setup-java, osv-scanner). Dependency updates go first so
   everything after is tested against them.
3. Merge #196 (Capacitor 8.6.2). The emulator check found no difference from main; what it could
   not cover is in the list below.
4. Merge #197 (root npm updates: Vite, Playwright, jsdom and others). It touches `package.json`,
   which #201 also changes, so #201 may need an update later.
5. Merge #186 (Undo on a repeating task).
6. Merge #187 (next copy of a from-the-finish repeat is later).
7. Merge #189 (Tailscale sign-in needs a tailnet name). It edits the invariants test, which the
   owner approved, and CLAUDE.md.
8. Merge #200 (Android test fix). Small and independent. Do it before #201, which reports the
   same known test failure.
9. Merge #191 (stack A parent: pattern matcher and nightly fuzz report).
10. Update #193 if it conflicts (see the rules above), post the review again on the new head, then
    merge it. It adds a sweep test and a paragraph in CONTRIBUTING.md.
11. Merge #190 (phone layout of My tasks and the 32px rule). It changes many e2e specs and
    `e2e/support.js`, so it goes before stack B, where #199 changes the same support file.
12. Merge #195 (stack B parent: offline edits in order, server time). Update it first if it
    conflicts with CLAUDE.md or command-center/README.md.
13. Update #199 (now on main), post the review again, wait for CI's browser tests on it, then
    merge. Watch the first browser run closely: it changes the test fixture for every UI test.
14. Update #201 (base `feat/settings-clock-line` moves to main), post the review again, wait for
    CI, then merge. It also changes `package.json` and `mobile/package.json`.
15. Merge #192 (reading list) and #194 (offline clock proposal). They are documents and conflict
    with nothing. #194 is the proposal that #195 and #199 carry out; the plan merges them last,
    and they could go anywhere in the order.
16. Wait for the Tests run on main to pass, all twelve browser test parts included
    (`gh run list --workflow test.yml --branch main`). Then follow the release checklist in
    docs/releases.md.

The suggested order follows the file overlaps, and no better one turned up. One option: merge
#190 before stack A if CONTRIBUTING.md conflicts turn out to be easier that way. The two orders
touch the same lines either way.

### Before the release, still to check

1. #190 changes the phone layout of My tasks and has not been looked at in the Android app on the
   emulator (release checklist, step 3).
2. #196 (Capacitor 8.6.2) touches keyboard and system bar insets. Checked on 2026-11-18 on the
   emulator (Android 16, WebView 133), against a build of main with Capacitor 8.6.0: the app's own
   test suite gave the same result on both (27 of 28, the one failure being the test #200 fixes),
   and with the keyboard up in the new task sheet and in a task panel the page measured the same
   on both: the same viewport height, the same insets (all 0), the tab bar hidden. What that does
   not cover: on a WebView older than 140, as both emulator images here have, Capacitor pads the
   window itself, and the part of 8.6.1 that changed is the other path, for WebView 140 and newer,
   which a current phone takes. Read from the change itself: with a keyboard docked at the bottom
   the bottom inset handed to the page is now 0 on every WebView version, where before it was 0
   below WebView 144 and left to the WebView from 144 on, which Capacitor's own note says gets it
   right on Android 15 and newer and wrong on Android 10 to 14. So on an Android 16 phone nothing
   should change. A look at the new task sheet with the keyboard open on the real phone is the
   check that is left.
3. #199 and #201 have run only the fast CI job so far (stacked), and four UI specs locally.
4. The last commit of #199 was not run on the emulator on its own, though #201's check ran on a
   build that contains it.
5. Found during the #196 check, in both builds, so not from any pull request here: in a task's
   panel, with the keyboard up, the Subtask name box sometimes comes to rest with its bottom edge
   13px under the keyboard (3 runs in 6 on main; with Capacitor 8.6.2 once 13px under and once
   level with the keyboard's edge in 6). In the runs that watched it for six seconds it stayed
   there. The text typed is still readable. This was seen with scripted taps, not confirmed with a
   finger, and the app's own keyboard tests pass. It is not fixed and has no pull request yet.

## 4. Release notes

### (a) CHANGELOG.md entry

Paste under the heading `## 3.1.0 (date)`.

```
No migration.

- On a phone, My tasks shows more tasks at once. The Filter, Sort and Group bar is one row with no
  band around it, the gap before a group is smaller, and the list and the bar reach a little
  further into the page's side margin, so a name wraps later. A task's date chip is as wide as its
  words instead of a fixed width, with every chip still one height and its right edge in line. A
  group's header is 32px tall, and its Add task is a + at the end of that header instead of a row
  of its own under the group. It opens the same inline row at the end of the group, on the
  group's date. Above 640px nothing changes size.
- Edits and comments made offline are sent in the order you made them, even if the device's clock
  was set back while it was offline. Before, an earlier edit could be sent last and win, with no
  conflict recorded. Each edit's time is now worked out in the server's time when the queue is
  sent, so a device with a wrong clock no longer wins or loses a conflict it should not. If the
  server's clock cannot be read, sending carries on as before.
- Settings, About, has a new Device clock row. It says "Matches the server's clock", or how far
  behind or ahead this device is, and "Not measured yet" before the first reading. From a
  difference of 30 seconds a notice says the clock is not in step and that offline edits are still
  sent in order with their times corrected.
- Undo on the completed toast for a repeating task now also drops the next copy that completing it
  made, so you no longer end up with two of the same task. The copy is dropped only while it is as
  it was made: a copy you have edited, moved or finished stays. With the server out of reach
  nothing is dropped.
- A repeat counted from the finish can no longer put its next copy on the day the completed one
  was due, or earlier. Before, "every 2 days from the finish" with Monday's copy completed on
  Saturday made another copy due Monday, so completing it looked like nothing happened. Now the
  span is counted from the due date in that case: Wednesday.
- If you turned on Tailscale sign-in (`CC_TAILSCALE_LOGIN`), a request now counts as you only when
  it is addressed to a tailnet (ts.net) name. Before, a request from the same machine carrying
  your login header was enough, whatever name it was addressed to. This closes the server's half
  of a DNS rebinding attack. Only that half was tried, with a hand-written request, not a real
  browser attack. Behind `tailscale serve` nothing changes, and the token path and MCP are as they
  were.
- Rules, the `matches` condition: after a class escape a dash is a plain dash, as in JavaScript's
  RegExp (`[^\s--z]` no longer reads `--z` as a range), and an octal escape such as `\00` is now
  refused when a rule is saved, as a backreference already was. `\0` alone, `\08` and `\09` are
  as before.
- Security and dependency updates: the hono and @hono/node-server fixes that cleared seven open
  security alerts, Capacitor 8.6.2 in the Android app, and newer versions of Vite, Playwright,
  jsdom and other tools and GitHub Actions.
- For contributors: a bounded sweep of the pattern engine against RegExp runs with the tests; the
  nightly fuzz run now reports a finding instead of passing in silence, and counts an abort while
  node exits as a pass only after the fuzzer finished cleanly; an Android test that failed on an
  emulator with animations on now waits for the scroll; `npm run test:android:offline` checks the
  offline queue inside the real app on an emulator; a reading list of related projects and a
  proposal for offline edits with a wrong clock are in docs/; and the written conventions now say
  the smallest click target is 32px, no longer 44px.
```

### (b) Tag message

```
Release 3.1.0

On a phone, My tasks shows more tasks: a tighter toolbar and group gaps, date chips as wide as their words, and a group's Add task is a + in its header. The written minimum click target is now 32px.
Offline edits are sent in the order you made them, with times in the server's time, even when the device clock is wrong. Settings, About, has a new Device clock row.
Undo on a repeating task drops the copy that completing it made. A repeat counted from the finish always lands later than the task completed.
With Tailscale sign-in on, a request counts as you only when it is addressed to a tailnet name.
Rules: the pattern matcher follows RegExp after a class escape, and an octal escape such as \00 is refused when a rule is saved.
Security and dependency updates (hono, Capacitor 8.6.2, Vite and others).
No migration.
```

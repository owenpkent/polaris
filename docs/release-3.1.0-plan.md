# Release 3.1.0 plan

## 1. What this is

A plan for merging the open, reviewed pull requests and the notes for the release that follows.
Nothing in it has been done. The release pull request moves the notes into CHANGELOG.md and
deletes this file. Written on 2026-11-18.

## 2. Version

Propose 3.1.0. The batch adds features (the Device clock row on Settings, the phone layout changes
of My tasks), and this repository's own history bumps the minor number for features (2.7 through
2.10). The number is the owner's call. 3.0.1 was the working name earlier, but no release so far
has been a patch release: every heading in CHANGELOG.md ends in .0.

## 3. Merge order

Seventeen pull requests are open and reviewed on their head commits: #186 to #201, and #203. Their
titles and base branches were checked with `gh` on 2026-11-18 and match the plan. None of them
touches `command-center/src/core/schema.ts`.

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
  - mobile/README.md: #201, #203
  - mobile/android/app/src/androidTest/java/com/okstudio/polaris/AppEndToEndTest.java: #200, #203
    (three lines apart at the nearest)
  - A trial merge of #203's branch with #200's, and with #201's, is clean.
  - command-center/src/http/rest.ts, its test, command-center/src/http/README.md, and
    src/command-center/api.js: #186, #195
- Checked against the diffs on 2026-11-18: in each of these files the pull requests change places
  some lines apart, so most should merge cleanly. The exception is by design: #195 and #199 change
  the same lines of CLAUDE.md and command-center/README.md, which is why they are a stack.

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
9. Merge #203 (the box being typed in shows whole above the keyboard). It changes the same app
   test file as #200, in other places, so it goes straight after it.
10. Merge #191 (stack A parent: pattern matcher and nightly fuzz report).
11. Update #193 if it conflicts (see the rules above), post the review again on the new head, then
    merge it. It adds a sweep test and a paragraph in CONTRIBUTING.md.
12. Merge #190 (phone layout of My tasks and the 32px rule). It changes many e2e specs, so it goes
    before stack B, whose first full browser test run then happens on top of it. Both change
    `e2e/support.js`, in places far apart.
13. Merge #195 (stack B parent: offline edits in order, server time). Update it first if it
    conflicts with CLAUDE.md or command-center/README.md.
14. Update #199 (now on main), post the review again, wait for CI's browser tests on it, then
    merge. Watch the first browser run closely: it changes the test fixture for every UI test.
15. Update #201 (base `feat/settings-clock-line` moves to main), post the review again, wait for
    CI, then merge. It also changes `package.json` and `mobile/package.json`.
16. Merge #192 (reading list) and #194 (offline clock proposal). They are documents and conflict
    with nothing. #194 is the proposal that #195 and #199 carry out; the plan merges them last,
    and they could go anywhere in the order.
17. Wait for the Tests run on main to pass, all twelve browser test parts included
    (`gh run list --workflow test.yml --branch main`). Then follow the release checklist in
    docs/releases.md.

The suggested order follows the file overlaps, and no better one turned up. #190 and stack A could
go in either order: both change CONTRIBUTING.md, but in places far apart (checked against the
diffs), so neither should make the other conflict.

### Before the release, still to check

1. #190 changes the phone layout of My tasks. Checked in the Android app on the emulator on
   2026-11-18 (Android 16, WebView 133), against a build of main: the app's own test suite passed
   28 of 28. At 412px, the width of the owner's phone, in the dark and the light theme, the
   toolbar, the 32px headers, the + in a header and the date chips measured as the pull request
   describes, and Compact was looked at in the dark theme. The name box a + opens rests as far
   above the keyboard as the box main's Add task row opens. At 360px the chip goes under the
   name, as on main, and the header, the toolbar and the + measure the same. The details are in
   a comment on #190. Not covered: a real phone, and a WebView of 140 or newer.
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
3. The three stacked pull requests, #193, #199 and #201, have run only CI's fast jobs so far: the
   browser tests do not run until each is a pull request into main. For #199, four UI specs were
   run locally at desktop; for #201, none.
4. The last commit of #199 was not run on the emulator on its own, though #201's check ran on a
   build that contains it.
5. Found during the #196 check, on main too: in a task's panel, with the keyboard up, the Subtask
   name box sometimes came to rest with its bottom edge 13px under the keyboard. On the emulator
   the cause was text that arrives while the keyboard is still coming up, which the script that
   found it sent: the WebView then brings only the caret into view. A finger on the on-screen
   keyboard cannot do that; a hardware keyboard with the on-screen one showing as well may. #203
   changes it for every text box, on the reasoning that the cause is not particular to one box,
   and adds an app test for the Subtask name box that failed in four runs of six without the
   change and passed eight of eight with it. All of that is from the emulator (WebView 133). Not
   covered: a real phone, a WebView of 140 or newer, and a phone browser.
6. Found during the #190 check, on main too, and not fixed: in the dark theme on the emulator's
   WebView 133, the status bar's clock and icons are white on a near-white strip and cannot be
   read. Below WebView 140 Capacitor pads the window itself, and the strip behind the status bar
   is the window's own background, not the page. A phone with a current WebView draws the page
   there, so it should not be affected, but that was not looked at. In this plan's judgement it
   does not hold the release. It has no pull request.

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
  conflict recorded. A device's clock is now measured against the server's when the queue is
  sent, and each edit's time goes out in the server's time, so a conflict is decided by when you
  made the edit and not by how far the device's clock is off. If the server's clock cannot be
  read just then, the last reading is used if it is under an hour old, and otherwise sending
  carries on as before. An edit made before the device's clock was changed while offline still
  gets a time that is wrong by the size of the change.
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
  your login header was enough, whatever name it was addressed to. So with sign-in by identity, a
  request addressed by IP address, by a short name, or to localhost is no longer treated as you;
  the token still works for those. This takes away what the server contributed to a DNS rebinding
  attack. It was shown with a hand-written request to the server, not with a real attack through
  a browser, and someone who controls the DNS answers your browser gets is still outside what the
  server can check. Behind `tailscale serve` nothing changes, and the token path and MCP are as
  they were.
- On a phone, the box being typed in shows whole above the keyboard also when text arrives while
  the keyboard is still coming up, as it may from a hardware keyboard with the on-screen one
  showing as well. Before, the lower 13px of the box could stay under the keyboard.
- Rules, the `matches` condition: after a class escape a dash is a plain dash, as in JavaScript's
  RegExp (`[^\s--z]` no longer reads `--z` as a range), and an octal escape such as `\00` is now
  refused when a rule is saved, as a backreference already was. `\0` alone, `\08` and `\09` are
  as before.
- Security and dependency updates: the hono and @hono/node-server fixes that cleared seven open
  security alerts, Capacitor 8.6.2 in the Android app (it carries fixes to how the keyboard and
  the system bars are allowed for on newer WebViews), and newer versions of Vite, Playwright,
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
Offline edits are sent in the order you made them, and their times are corrected to the server's clock when they are sent. Settings, About, has a new Device clock row that shows how far the device's clock is off.
Undo on a repeating task drops the copy that completing it made. A repeat counted from the finish always lands later than the task completed.
With Tailscale sign-in on, a request counts as you only when it is addressed to a tailnet name.
Rules: the pattern matcher follows RegExp after a class escape, and an octal escape such as \00 is refused when a rule is saved.
Security and dependency updates (hono, Capacitor 8.6.2, Vite and others).
No migration.
```

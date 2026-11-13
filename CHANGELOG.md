# Changelog

Each release is a signed tag `vX.Y.Z` (docs/releases.md). An entry names any schema migration it
carries, because `cc update` snapshots the database before one and a rollback restores it.

## Unreleased

- On a phone, a task's due date is back on the name's line: the name, then the date chip at its
  right, then the button that opens the panel, so a short task is one line tall again and a long
  name wraps beside its date. Every date chip is one size, with its words centred and a repeat
  glyph inside it, so the dates line up as a column, each at the middle of its row. A chip with a
  time is no taller than one without. Under 380px wide the date still goes under the name.
- On My tasks, the subtasks shown under a task now end with an Add subtask row. Type a name and
  press Enter to add it under that task, as many times as you like, and Esc closes the box. An
  inbox item still has no subtasks.

## 2.10.0 (2026-11-12)

No migration.

- Nothing scrolls to a task you just moved, or to one added from the list's own Add task row. A
  task sent to another day, group, or Board lane is tinted where it lands, and the list stays
  where you were working. (The phone's New task sheet still scrolls to the task it made, so a task
  saved out of sight does not look lost.) The toast at the foot
  of the screen says where it went, "Moved <task> to Tomorrow", with View, which opens the group,
  scrolls to the task, and puts focus on it, and Undo, which puts it back. It is a polite status
  message and takes no focus. Drags and arrow-key moves show no toast, since you watch the row go.
- A task added from a group's Add task row, or from the phone's New task sheet, stays where it was
  typed, at the end of its group, instead of jumping to the top when the row closes or the list
  reloads. Tasks created by agents, imports, and the API still go first.
- Text stays in line when an edit opens: the new task row types its name where the names above it
  start and shows its date as a row's date cell does, renaming in place keeps the words where they
  were, and a new Board card is typed after an empty circle, in line with the card titles.
  e2e/alignment.spec.js measures each of these.
- The due date picker's Add time and Repeat are rows of the quick dates' list, and a picked or
  hovered row is a band inside its 44px target. "When is it due?" for a new task uses the same list,
  with each date's weekday or day beside it.
- Right-click the My tasks column header, or press Shift+F10 or the ContextMenu key from a control
  in it, to show or hide columns, the same list as the toolbar's Columns button.
- On a phone, a task's name has the whole width and wraps in full, and its due date sits on a line
  under it; a task with no date shows a quiet Add date there. The open date picker survives a turn
  across the 640px breakpoint without saving a half-typed time.
- The desktop table is quieter: Source starts hidden (where a task came from is in its panel; a
  device that saved its columns hides it once, and the Columns menu brings it back), the lines
  between columns are softer, and group header bands are lighter.

## 2.9.0 (2026-11-11)

No migration.

- Leaving an edit saves it, across the dashboard: a click outside, Done, closing the panel, or
  opening another item saves what was typed or picked, and only Esc in a picker drops it
  (CONTRIBUTING.md, "Leaving an edit"). A time typed in the due date picker used to be saved only
  by Enter. Esc that closes the task panel now saves the title, assignee, recurrence, comment, and
  subtask being typed, not only the notes, and a custom repeat finished in the builder is saved
  when the panel closes or another task opens. "When is it due?" keeps a day or repeat picked there
  when you click outside it. On Goals, a title, status note, or number saves when you leave the
  field, Esc puts the field back, and the refresh never overwrites one you are typing in.
- A thread post is still sent only by Post, but the post box keeps an unsent post per task on the
  device, and it never shows in another task's box. On a phone, closing the New task sheet with
  the backdrop, the X, or Esc keeps the draft for the next opening; Cancel throws it away.
- The due date picker has a Done button. On a desktop its quick dates are a list beside the month,
  each with its weekday or date, and Remove time is a cross beside the time box. On a phone it
  rises from the bottom edge as a sheet over a dimmed page instead of covering the field it came
  from.
- A tab left open in the background reloads itself onto a new build once the server serves one,
  so it is current when you come back. It waits while a dialog or panel is open, a field holds
  text, or a save is still on its way, and a visible tab is never reloaded under you. A New task
  draft kept on closing the sheet survives the reload.
- On My tasks, a row held by its handle under Sort: Manual lifts out: a raised copy follows the
  pointer, the row fades in place, and the rows part around a dashed gap where it will land. A
  hairline divides the columns after the name again, so the eye can run down a column. On a
  phone every due chip is one size, with the day over the time when it has one. The add-due
  popover goes side by side from 640px, so a scrollbar no longer drops it to the taller layout.
- A rule's `matches` pattern reads a repeat count of any length as JavaScript's RegExp does
  (`{0006}` is six), and a count above 100 written with more digits is refused like any other.
- In the Android app, the navigation drawer keeps its Settings row above the system's
  navigation bar instead of drawing it under the buttons or the gesture bar.
- On a phone, the tab bar and the New task button step aside while the on-screen keyboard is
  open, instead of riding on top of it, and come back when it closes
  (docs/phone-keyboard-and-system-bars.md).
- The Today group on My tasks shows the same plain count as every other group again: "n left",
  "m done", and "All clear" are gone, and an empty Today is hidden like any other empty group.
- In the task panel, the Add subtask box scrolls into view as each subtask is added, so a long
  list can be typed without it sliding out of sight.
- In the task panel, Save as checklist is a quiet text button, and a task with no comments shows
  one Add a comment row instead of an empty Comments section. The row opens the comment box, and
  leaving it empty closes it again.

## 2.8.0 (2026-11-08)

No migration.

- Search from the top bar. The Search button, or the `/` key, opens a dialog over whichever view
  is showing and lists the open, in progress, waiting, and done tasks whose title or notes match,
  the ones still to do first. Choosing a result opens that task's panel on My tasks. Inbox items
  are left out. With the server out of reach, the stored copy of My tasks is searched instead,
  and the dialog says that only open tasks were searched.
- Completing a task on My tasks or the Board shows a "Completed <task>" toast with an Undo button
  for about six seconds. Undo reopens the task, also while offline. If the reopen fails, the
  toast says so and offers Retry and Dismiss, and stays until one is chosen.
- My tasks and the Board briefly tint the task you just added, moved, or edited, where it now is,
  and scroll it into view if it left the screen. Changes from another device or an agent do not
  flash.
- The Today group on My tasks shows its progress: "n left", then "m done" once a task due today is
  finished, and "All clear" with a check when nothing is left. A Today left empty by finishing
  everything stays on the page for the day. `GET /api/tasks` gains the read-only
  `completedAfter` and `completedBefore` filters.
- The custom Repeats editor opens with the rule in words and its next dates, shows Every and the
  weekdays, and puts Counts from and Ends behind a More options button that names their values.
  Spacing across the dashboard now comes from shared tokens (`--space-*`, `--gap-*`), with rules
  for them and a UI review checklist in CONTRIBUTING.md.
- Comments save on click-away, as the Add task row does: a click elsewhere adds the comment, Enter
  adds it and keeps focus, Tab keeps the draft, Esc drops it. Notes typed in a panel closed with
  Esc are saved too. A task added from the Add task row stays just above the row, in typed order,
  until the row closes.
- More contrast, in both themes: disabled controls are drawn flat and outlined instead of faded,
  form fields are white in the light theme, unticked checkboxes and radios show against the dark
  theme, and chips, badges, secondary text, comment cards, and the empty progress track meet the
  contrast rules in CONTRIBUTING.md, which carry the new numbers.
- Menus show whole when they can: a popover too tall for the side it opens on slides along the
  window until all of it shows, over its trigger if it must, and on a phone it never covers the
  tab bar. Only content taller than the window scrolls.
- An HTTP error response never carries the text of a caught value that is not an `Error`: the
  GitHub status, the recurrence preview, and the backup check send a fixed string in its place.
  The regex engine's test oracle is left out of CodeQL analysis, whose deliberate patterns it
  flagged.

## 2.7.0 (2026-11-04)

No migration.

- The Android app updates itself, up to the one tap Android asks for: it checks the releases on
  its own, downloads a newer APK into its own storage, checks that it is Polaris signed with the
  same certificate, and offers Install from a notification and from the App update card. Check
  for app updates automatically is on by default and can be turned off in Settings.

## 2.6.0 (2026-11-03)

No migration.

- Phone rows keep their shape: a long task name wraps on its own lines and the panel button stays
  on the first one, instead of dropping under the name and leaving an empty band in the row. The
  column header is gone from the phone tier, where the two columns are fixed and Sort lives in the
  toolbar.
- In the Android app the top bar now sits below the status bar instead of under it, and the status
  bar's icons follow the dashboard's theme.
- `cc update` no longer rolls an update back because the machine was busy: the dashboard unit
  tests it runs give a slow test twenty seconds, and a slow element five, instead of five and one.
- My tasks hides the Today and Tomorrow groups while they are empty, as it already did for the
  other day groups. An empty group still shows while a row is held, as a drop target, and the
  toolbar's Add task still opens its row in Today, which comes back for as long as the row is open.

## 2.5.0 (2026-11-03)

No migration.

- The Android app signs in through Tailscale with no token on the phone. On a server with
  `CC_TAILSCALE_LOGIN` set and `https://localhost` in `CC_CORS_ORIGINS`, type the server URL in
  the app, leave the token empty, and connect: nothing is stored on the phone. The Access token
  field on the connect form is now optional everywhere, and says what to paste when a server
  still wants one. A write over the owner's Tailscale sign-in alone is accepted from the
  dashboard's own origin or from an origin listed in `CC_CORS_ORIGINS`, never from the built-in
  development default (docs/app-identity-proposal.md).

## 2.4.0 (2026-11-03)

No migration.

- The Android app has a signed release APK: `npm run release:apk` builds it and signs it with the
  EV code-signing certificate on the eToken, and a release can carry it. Settings in the app has
  an App update card that checks the public releases when you press it and offers the newer APK
  as a download; Android installs it only over an app signed with the same key.
- More contrast: the dark theme sits a step above near-black, the lines between rows and around
  the sidebar and panels are stronger in both themes, and each My tasks group header has a band
  and a clear rule under it, so the groups read as separate blocks.
- My tasks no longer lets a task be dragged or arrowed into Overdue, so a move never gives a
  task a date in the past by accident. A drag over Overdue lands at the top of Today; tasks
  already in Overdue can still be reordered there or moved out. The due date picker still takes
  a past date.
- Right-click a My tasks row or a Board card, or press Shift+F10 or the ContextMenu key on it, for a menu with Open task, Complete or Reopen, Due, Priority, and Move to project or section.
- A new task goes to the top of the list under Sort: Manual, wherever it is made, offline too.
  A subtask still goes to the bottom of its parent's list, and an import or a repo checklist
  puts its new tasks at the top in the file's order. Tasks you already have keep their order.

## 2.3.0 (2026-11-02)

Migration 14 renumbers every task's position into one order across all projects and sections,
keeping the order they had. `cc update` snapshots the database before it runs; a rollback restores
the old per-project numbers.

- My tasks keeps your own order: Manual is the default sort (a saved view keeps its sort), with
  a handle before each row. Drag a handle to move a row, or use its menu (Move up, Move down, Move
  to top, Move to bottom) or the arrow keys; a screen reader hears where the row landed. Offline
  reorders are queued and replayed.
- Drag a task to another day: dropping it in Today or Tomorrow sets that date (keeping any time),
  No due date clears it, and Overdue, Next 7 days, and Later open the date picker on the row;
  closing the picker without a date puts it back. Group headers, collapsed or empty, take a drop
  at the top, the arrow keys cross from one day to the next, and the handle menu has Move to
  Today, Move to Tomorrow, and Move to No due date.
- Click a task's title to rename it in place (Enter or a click away saves, Esc cancels). An
  always-visible button at the end of the name opens the task panel.
- Hide the sidebar from the top bar or with Ctrl+\ (Cmd+\ on a Mac); each device remembers it.
- Calmer colours: hover, pressed, and dividers each have their own strength in both themes, flat
  buttons, quieter column headers, tabular digits, and ten matched project colours. Compact row
  density, chosen per device in Settings, packs My tasks rows and board cards with 32px controls.
- The add row names the task in the Name column with its due date in the Due date column, and a
  click elsewhere with a title in it adds the task, as Enter does.
- The due date picker shows Repeats in place of the month, with a Back button, so it never needs
  scrolling; a repeating task's Repeat button names its rule.
- A release tag can be signed with the OK Studio EV certificate on the eToken (an X.509
  signature, `scripts/sign-release.ps1`) as well as with the SSH release key. An install verifies
  an X.509 signature itself, against the RSA keys in its pinned `release-signers`, with no
  certificate chain or expiry; the certificate's key is in the committed file. This release itself
  is SSH-signed, because installs on 2.2.0 verify SSH only; after it, either kind verifies.

## 2.2.0 (2026-10-31)

No schema migration.

- My tasks after Asana's list: Add task opens a row at the top of its group with an empty check
  circle, Enter saves on the group's date and opens the next row, and the due date button beside
  the name opens "When is it due?" for another date or a repeat. A row with open subtasks shows
  their count as a button that lists them indented under the parent. The toolbar's Filter, Sort,
  and Group are popovers that name what is applied in a chip with a clear button; saved views
  keep their format.
- The task panel after Asana's task pane: a header that sticks while the panel scrolls, with
  Mark complete, Assign and Hand off as toolbar buttons and Close pinned right; notes with no
  frame at rest; a subtask done count and a + button, so subtasks can be added from the panel
  (queued offline as an ordinary create).
- Board cards complete and reopen in place with the list's check circle, show the due date,
  repeat glyph, and assignee, and every lane has Add task, which opens a blank card and stays
  open for the next name.
- The due date picker opens straight onto the month calendar: quick chips Today, Tomorrow, Next
  Monday, and No date; one tap on a day saves; Add time reveals a time box. Repeats is in the
  picker, with the next dates tinted on the month; a plain repeat follows a newly picked day, and
  a rule the builder cannot show points to the task panel instead. A new task's date and repeat
  are picked the same way, and the repeat picker is laid out in Asana's rows: plain choices
  without a stepper, one strip of weekdays, and a repeat every two or more units reads as Custom.
- Completing a task celebrates a little: the check pops, the row flashes and fades, the panel's
  Mark complete and subtask checks do the same, all off under reduced motion. The check circle
  is empty at rest.
- Fixes: a subtask made offline gets its parent's project; a pending subtask create stays with
  the task it was typed under; the board refreshes for the selected project and keeps the add
  card until the click lands; Enter that confirms an IME composition no longer adds a task; the
  picker's next-dates line no longer moves it once placed.
- The desktop app is removed: the Tauri shell under desktop/, its build and release script, its
  Rust tests and UI tests, their CI workflow, and the cargo dependency updates. The dashboard is
  a web app that installs from the browser, and the daemon runs as a service or in a terminal;
  an installed copy of the old app keeps working against its own daemon but gets no update.
  `GET /api/identity` stays, for the updater's health check. The ignore rules for the old app's
  build output stay, so a checkout that built it is not blocked by untracked files when it
  updates.
- Docs: how to move tasks and their repeat schedules from Asana (docs/asana-import.md), and a
  sweep bringing the docs in line with the code after 2.1.0.
- Tests that read the real clock are pinned, so they no longer go stale as the calendar moves.
- Dependencies: npm audit fixes (body-parser, fast-uri, undici), the MCP SDK, zod, and the
  GitHub Actions used by CI.

## 2.1.0 (2026-10-18)

- Due times: a due date can carry an optional time of day, set and removed in the due date menu,
  the task panel's Due date field, and Add time in "When is it due?" for a new task, and shown
  after the day in rows, board cards, and the panel ("Today 9:00 AM"). It is stored as floating
  local time (`YYYY-MM-DDTHH:MM`, no zone); a value sent with a zone or an offset is stored as
  the local time of that moment in `CC_TZ`, and exactly midnight UTC (a plain date through
  `toISOString()`) as that date. A task due at a time counts as its day for Today,
  Overdue, the digest, rules, and the CLI, and sorts after that day's untimed tasks. `cc add
  --due "YYYY-MM-DD HH:MM"` takes one, and the digest, MCP text, and CLI write it as
  `2026-10-18 09:00`. Migration 13 converts a due written with a zone before this into floating local time in `CC_TZ`, so a rollback restores the snapshot.
- Richer repeating tasks. The Repeat menu and the add-task Repeat choice offer Google Calendar
  style quick picks worded from the due date (Weekly on Wednesday, Monthly on the second
  Wednesday, Annually on October 14, and so on). The custom builder adds Ends (never, on a date,
  or after a number of times), "Next one counts from" the due date or the day you finish it, and
  the last day or last weekday of the month.
- `COUNT` in a recurrence rule is now exact: it counts the occurrences left, the current task
  included. Completing a task gives the next one its rule with `COUNT` one lower, a skip lowers it
  on the task itself, and `COUNT=1` is the last one (it makes no next task and cannot be skipped).
  A late completion no longer uses up the dates it missed. Existing rules with `COUNT` keep their
  number and count down from it.
- New recurrence extension `X-FROM=COMPLETION`: the next due date counts from the day the task is
  finished rather than its due date, INTERVAL days, weeks, months, or years after it (a month held
  to the last day of a shorter one). It cannot be combined with BYDAY, BYMONTHDAY, or BYMONTH, and
  every other `X-` part is still refused. A rule that gives a part twice, or a COUNT or INTERVAL
  with a sign, is now refused. No schema migration.

- Settings has an About card: the dashboard's build (version, commit, and build time, recorded by
  `npm run build`) and the server's version, so a cached or bundled dashboard is easy to tell apart
  from the server it talks to.
- The Windows daemon task installer stops an active pre-rename task and waits for its listener
  to exit before replacing it with Polaris. A stop or wait failure keeps the old registration,
  preventing updates from targeting a new task while the old daemon still owns the port.
- `-Uninstall` on the daemon task installer stops a running daemon, Polaris or pre-rename, and
  waits for port 8788 to clear before it removes that task, so no daemon is left running with
  nothing to stop it. A stop that fails keeps the task registered.

## 2.0.0 (2026-10-15)

The first signed release. Everything on `main` to this point is in it; the entries below are what
an install needs to know before updating onto it.

- `cc update` (docs/update-proposal.md): the owner's command for moving an install forward with a
  checked database snapshot, `npm ci --ignore-scripts` from the lockfiles, the tests, a staged
  dashboard build, a restart of the daemon, a health check, and a rollback on any failure.
  Restarts the Windows logon task, a systemd system unit (one sudoers line), a systemd user unit,
  or waits for the owner.
- Signed releases: `cc update --release` installs the newest release tag that verifies against the
  pinned signers, `--to vX.Y.Z` a named one, and `--check` reports without installing and writes
  what it found to `data/update-status.json`. The committed `release-signers` file is pinned to
  `data/release-signers` on first use and changed only by `cc update --trust-signers`.
- `origin/main` as a target needs new commits and a version that is not older than the running
  one; a release must be strictly newer.
- Also in this release, built before the changelog was kept: agent threads on a task
  (docs/agent-threads-proposal.md), Tailscale identity for the dashboard (docs/tailscale-identity.md),
  the Assign to AI button (docs/assign-to-ai-options.md, stage 1), reusable checklists, the desktop
  shell and the Android app, and the lighter dashboard with one due date picker.
- Migrations: 1 through 12. An install that updates from an older `main` gets the ones it lacks after
  the snapshot. Added since the update work: 11 `update_requests` (the dashboard's update requests,
  for the update icon) and 12 `checklists`.
- The leftover Constellation names are now Polaris: the database `polaris.db`, the Windows folder
  `%APPDATA%\polaris`, backups and pre-update snapshots `polaris-*`, the scheduled tasks
  `Polaris Command Center` and `Polaris Updater`, and the desktop app `com.okstudio.polaris`. New
  installs only create the Polaris names.
- An install from before the rename keeps working. Its database, Windows secrets folder (the GitHub
  sign-in and the backup passphrase), backups and snapshots, and scheduled tasks are still read
  under the old names when the new ones are absent, and nothing is renamed or moved for you. The
  two task installers replace the old tasks when run with the default names, so two daemons or two
  updaters never run, and `-Uninstall` with the default name removes both. The identity check keeps
  its wire string `constellation-identity`, so an updater or desktop app from before the rename
  still verifies the daemon. The desktop app installs beside the old one (new identifier), so
  uninstall the old one.
- `release-signers` carries the first release key, `polaris-release`. Its fingerprint is under
  "Current keys" in docs/releases.md; check it when an install first pins the file.

# Changelog

Each release is a signed tag `vX.Y.Z` (docs/releases.md). An entry names any schema migration it
carries, because `cc update` snapshots the database before one and a rollback restores it.

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

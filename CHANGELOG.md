# Changelog

Each release is a signed tag `vX.Y.Z` (docs/releases.md). An entry names any schema migration it
carries, because `cc update` snapshots the database before one and a rollback restores it.

## Unreleased

- Due times: a due date can carry an optional time of day, set and removed in the due date menu,
  the task panel's Due date field, and Add time in "When is it due?" for a new task, and shown
  after the day in rows, board cards, and the panel ("Today 9:00 AM"). It is stored as floating
  local time (`YYYY-MM-DDTHH:MM`, no zone); a value sent with a zone or an offset is stored as
  the local time of that moment in `CC_TZ`, and exactly midnight UTC (a plain date through
  `toISOString()`) as that date. A task due at a time counts as its day for Today,
  Overdue, the digest, rules, and the CLI, and sorts after that day's untimed tasks. `cc add
  --due "YYYY-MM-DD HH:MM"` takes one, and the digest, MCP text, and CLI write it as
  `2026-10-18 09:00`. No migration: `due_at` already held a datetime.
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

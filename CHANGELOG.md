# Changelog

Each release is a signed tag `vX.Y.Z` (docs/releases.md). An entry names any schema migration it
carries, because `cc update` snapshots the database before one and a rollback restores it.

## Unreleased

- The leftover Constellation names are now Polaris: the database `polaris.db`, the Windows folder
  `%APPDATA%\polaris`, backups and pre-update snapshots `polaris-*`, the scheduled tasks
  `Polaris Command Center` and `Polaris Updater`, the desktop app `com.okstudio.polaris`, and the
  identity check. Nothing reads the old names. An install from before the rename cannot move
  onto this with `cc update` (the old updater rejects the new daemon and rolls back). Upgrade it by
  hand, in this order, before the daemon starts on the new code:
  1. Stop the daemon. On Windows remove the old tasks:
     `scripts\install-command-center-task.ps1 -Uninstall -TaskName 'Constellation Command Center'`
     and `scripts\install-updater-task.ps1 -Uninstall -TaskName 'Constellation Updater'`.
  2. Update by hand (docs/getting-started.md, "Updating").
  3. Unless `CC_DB` names the file, rename `command-center/data/constellation.db` to `polaris.db`
     (and its `-wal` and `-shm` files if present).
  4. On Windows, rename `%APPDATA%\constellation` to `%APPDATA%\polaris`. It holds the GitHub
     sign-in and the backup passphrase. Skip this and backup encryption reads as off, so the next
     backup is written unencrypted.
  5. In the backup folder, rename `constellation-*` files to `polaris-*`, or delete them. Old names
     are not counted, pruned, or flagged as unencrypted copies.
  6. Register the tasks again with the two installers, and start the daemon. Uninstall the old
     desktop app: the new one installs beside it.

## 2.0.0 (2026-10-08)

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

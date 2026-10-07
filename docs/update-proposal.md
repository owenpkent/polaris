# Safe updates: design

Status: built, 2026-10-06. Approved by the owner on 2026-10-06 and built in the four phases of section 9. This revision folds in the review of the first draft: a named snapshot that survives the daily backup, a rollback that restores the database as well as the code, a build that never empties the live dashboard, a health check that can actually pass, a strict "newer only" rule for what gets installed, a stated owner for every row of the request table, and an update module the daemon's import graph never reaches. The rule changes in section 7 were approved together with "build it".

This document describes how a Polaris install gets newer code: a `cc update` command the owner runs, signed releases, an opt-in scheduled updater, and an update icon on the dashboard that says when a newer release exists and can ask the updater to install it. Security is a requirement throughout, because an updater decides what code runs next to the owner's data on every install.

Prior art: the owner's alpha-osk updater (a Windows installer-based updater with a threat model). Nothing from it is reused as code, but five of its habits are kept here: a strict `MAJOR.MINOR.PATCH` version rule where a malformed version means "no update", a downgrade defence that binds what is installed to the version it claims to be, a UI that only ever says "install the pending update" and never carries a path or a URL, release notes sanitised and capped before they reach the UI, and a single-use handoff so the next start can say "Updated to vX".

## Where things stand

- Updating is manual. On every install it is: `git pull`, `npm install` at the root, `npm --prefix command-center install`, `npm run build`, then a restart of the daemon. The owner snapshots the database first when `command-center/src/core/schema.ts` changes.
- The daemon, the CLI, and the Windows logon task all run `command-center/src/cli.ts` straight from the git working tree with Node. There is no install step and no built server: a `git checkout` changes the code the next process runs. The dashboard is the one built thing, `npm run build` writing `dist/`, which the running daemon serves.
- The owner's own host, GR9, runs the daemon as a systemd system unit (`polaris.service`) from a deploy-only checkout. Restarting it needs `sudo`. On Windows the daemon runs from the logon task that `scripts/install-command-center-task.ps1` installs, restarted with the wait-for-the-port loop in command-center/README.md.
- Polaris has no tags and no releases. The merge commits on `main` are signed, but by GitHub's web-flow key, which proves only that the merge happened on github.com. Nothing marks one commit as "a version meant to run". The root package.json says 2.0.0 and command-center/package.json says 0.1.0, and `GET /api/health` reports the second.
- The daemon runs its jobs in-process and starts no program, with one exception: on Windows the secret store runs PowerShell to use DPAPI (src/ingest/secrets.ts). Its only outbound calls are to GitHub with the read-only App's user token, the only credential (CLAUDE.md).
- The backup code (src/daemon/backup.ts) makes a checked copy with `VACUUM INTO`, which is consistent while the daemon writes, and reads it back before it counts. The copy is named by date, `constellation-YYYY-MM-DD.db`, and a second run on the same day replaces it. The daemon's `backup` job runs daily and catches up at start when the last success is over a day old. `cc backup check` proves a copy restores without opening the live database.
- The migration loop in src/core/db.ts runs any migration the database is missing and does nothing when the database is ahead of the code. Only `cc backup check` and `POST /api/backup/check` notice a database newer than the code.
- The CLI opens the store directly for every task command, so the daemon has never been the database's only writer. The daemon and the CLI are separate processes and share the database through SQLite and the lock files in src/core.
- A failing job reaches the dashboard as `warnings` on `GET /api/sync` (src/http/warnings.ts), shown by src/JobWarningsBanner.jsx.
- No signing key exists yet on the owner's machines. Phase B needs one (section 2).

## Why not follow `main` automatically

The simplest updater pulls `main` on a timer. Rejected:

- **Every install would run whatever reaches `main` within the hour.** A compromised GitHub account, a stolen session, or a malicious change merged by mistake would become code execution on every install that cloned Polaris, with the owner's data in reach.
- **The daemon would have to start programs.** Updating means running `git`, `npm ci` (which runs install scripts from npm packages), a build, and a restart of the daemon itself. That is the reverse of the daemon's posture and hard to state as an invariant.
- **There is no line between a commit and a version.** A commit that lands is not the same as a version the owner decided people should run.

## 1. `cc update`, run by the owner

A new CLI command, `npm run cc -- update`. The owner runs it; the daemon never does.

`cc update` with no flags updates to `main` (phase A, the pre-release world). `cc update --release` updates to the newest signed release (phase B) and becomes the default once a first release exists. `cc update --check` only reports. `cc update --to vX.Y.Z` names a release. Every path runs the same steps:

1. **Refuse** when the working tree has uncommitted changes, is not on `main` or on a release tag, or has local commits not on the remote. A deploy checkout should never carry local work, and an update must not throw any away. Refuse, too, when the target is not strictly newer than the running version (section 1B).
2. **Fetch** and show what changes: the commits, whether `schema.ts` changes, and whether either lockfile changes.
3. **Snapshot** the database before every update, live, through the backup code. The copy has its own name, `constellation-pre-update-<version>-<YYYY-MM-DDTHH-MM-SS>.db`, so the daily backup, which replaces that day's dated copy and catches up at daemon start, never overwrites it. `VACUUM INTO` is consistent while the daemon writes, so the daemon keeps running and nothing is left dark if a later step fails. The snapshot is checked the way a backup is (integrity, foreign keys, counts) and encrypted when backup encryption is on. The newest three pre-update snapshots are kept. The snapshot is taken while the checkout is still on the old code, so opening the store runs no new migration.
4. **Check out** the target commit. The update process itself keeps running the old code (Node loaded its modules at start, and the update module imports nothing lazily after this point).
5. **Install** from the lockfiles with `npm ci` at the root and in command-center/, so the exact versions CI tested are what runs. Today both lockfiles work with `--ignore-scripts` except the root's `esbuild` and `fsevents`, which are dev-only; `cc update` runs `npm ci --ignore-scripts` and then `npm rebuild esbuild` at the root, and a test pins that list so a new package with an install script is a deliberate change.
6. **Test and build**: `npm run test:fast`, then `vite build --outDir dist.next`. The live `dist/` is untouched until the restart, so a failed build leaves the dashboard as it was and a successful one never serves the new dashboard against the old API.
7. **Restart** the daemon the platform's way (section 1A), swapping `dist.next` into place and keeping the old `dist/` as `dist.prev` for the rollback, in the moment between stop and start.
8. **Health check**: the daemon on the configured port must answer `GET /api/identity` with the proof for this install's api token (src/http/identity.ts), and `GET /api/health` with `ok` and the expected version, within a timeout. To call them the command reads the api token from the file next to the database, exactly as the daemon does, and never prints it. The identity proof is what makes "something answers on the port" into "our daemon, holding our token".
9. **Roll back on any failure** after the checkout moved: return to the previous commit, put `dist.prev` back, `npm ci` again, and, if the live database's `schema_version` is now ahead of what the previous code knows, stop the daemon and restore the snapshot (copy it over the database, removing the `-wal` and `-shm` files) before the restart. Then restart and health-check that. The running version is never left broken where the command can restart the daemon (section 1A). If the rollback also fails, it says so loudly and leaves the snapshot path and the previous commit on screen.
10. **Log** every step to `data/update.log`, and the outcome to `data/update-status.json` (section 3), which the dashboard reads through the daemon.

The command never touches `command-center/data` except through the backup code, the snapshot restore in a rollback, the token file it reads, and its own log and status files.

### 1A. Restarting the daemon

`cc update` picks the restart method from `CC_UPDATE_RESTART`, or detects it: `task` on Windows when the logon task exists, `systemd:polaris` on Linux when `systemctl is-active polaris` answers, `systemd-user:polaris` when the user unit does, otherwise `manual`.

| Install | How `cc update` restarts it | Rollback can restart |
|---|---|---|
| Windows logon task (`task`) | Stop the task, wait until nothing listens on the port, swap `dist`, start the task (the README's loop) | Yes |
| systemd system unit, GR9 (`systemd:<unit>`) | `sudo -n systemctl stop <unit>`, wait until nothing listens on the port, swap, `sudo -n systemctl start <unit>`, which needs the one-line sudoers rule below | Yes |
| systemd user unit (`systemd-user:<unit>`) | `systemctl --user stop <unit>`, wait for the port, swap, `systemctl --user start <unit>` | Yes |
| Plain process (`manual`) | Prints that the owner must restart the daemon, waits for the port to drop and come back, then health-checks | No: a failed health check rolls the code, `dist`, and the database back and asks the owner to restart once more |

The "never left broken" promise in section 5 holds for the three methods that can restart. On a plain process the command restores everything it can and tells the owner what to do.

For a systemd system unit the owner installs one sudoers line, which `scripts/install-updater-systemd.sh` prints and offers to write:

```
owen ALL=(root) NOPASSWD: /usr/bin/systemctl stop polaris, /usr/bin/systemctl start polaris, /usr/bin/systemctl restart polaris
```

That names the one unit and three verbs, because an update stops the daemon, swaps the built dashboard (and restores the snapshot on a rollback) while nothing holds the port, then starts it; restart is kept on the line for the owner's own use and is one of the verbs the preflight `sudo -n -l` check asks about, so an older one-verb line is reported before anything moves. The alternative, moving GR9 to a user unit with lingering, would avoid root but means redoing the NAS mount and Tailscale ordering at user level; the sudoers line is the default and the user unit stays supported.

### 1B. Versions and "newer"

- The version is the root package.json's, and command-center/package.json mirrors it; a test fails when they differ. `GET /api/health` keeps reporting it.
- A release is a tag `vMAJOR.MINOR.PATCH` with nothing after the patch. The rule is strict: a tag that does not match is not a release and is never installed, never shown, and never compared.
- The running version is the version in the checkout's package.json. What "newer" means depends on the target. `origin/main` (the pre-release world) is newer when it is strictly ahead of HEAD, a fast-forward with at least one commit, and its package.json version is not older than the running one: a merge to `main` need not bump the version, and the same version with new commits installs. A release (`--release`, `--to`) is newer only when its version is strictly newer than the running one; nothing else about a release is compared. `cc update --to` an older or the same release is refused; the way back is a deliberate `git checkout` by the owner, outside this command.
- After checking out a release, the command reads its package.json and refuses when the version there is not the tag's: a release is what it says it is or it does not run. The checkout is put back before anything else runs.

## 2. Releases

Signed tags mark the versions meant to run.

- The owner tags `vX.Y.Z` on `main` and signs the tag with their own SSH key (`git config gpg.format ssh`), never GitHub's. docs/releases.md has the checklist, including the one-time key setup; the owner has no signing key yet and creates one with `ssh-keygen -t ed25519`.
- `release-signers`, committed at the repo root in OpenSSH `allowed_signers` format, lists the keys allowed to sign releases, each with `namespaces="git"`.
- `cc update --release` fetches the tags from `origin` (a credential-free `git fetch --tags`, the same remote `git pull` uses), takes the newest release tag that is strictly newer than the running version, and installs it only when `git verify-tag` passes against the pinned signers. A tag that does not verify is skipped and reported, never installed. Release notes are the tag's annotation, with control characters stripped and the text capped at 4000 characters before it is stored or shown.
- **Pinning.** On first use (`--release`, `--to`, or `--check`) `cc update` copies `release-signers` to `data/release-signers`, owner-only, and verifies against that copy from then on (trust on first use). A later change to the committed file does not widen trust by itself: it is reported as "the signers file changed; run cc update --trust-signers to review it", verification continues against the pinned copy, and a new key is accepted only when the owner confirms it with `cc update --trust-signers`, which shows the pinned and the committed keys side by side (principal, key type, fingerprint). A pinned file with no keys means "no release can verify": `--release`, `--to`, and `--auto` say so and stop, and `--check` reports it. A pinned file that other users can write is refused.
- **Key rotation.** The owner adds the new key to `release-signers` in a release signed by the old key, then confirms it once on each install.
- **Release checklist** (docs/releases.md): CI green on the commit, `npm run test:ui` run, the version bumped in both package.json files, a CHANGELOG entry that names any migration, then the signed tag and a GitHub release with the same notes.

A fork has its own key and its own `release-signers` file, so it never trusts upstream's releases unless its owner chooses to.

## 3. Automatic updates, opt-in

Off by default. An installer schedules `cc update --auto` with the operating system, every five minutes:

- `scripts/install-updater-task.ps1` on Windows, a scheduled task beside the logon task (`-Uninstall` removes it),
- `scripts/install-updater-systemd.sh` on Linux, a user service and timer (`--uninstall` removes them), which also prints the sudoers line when the daemon is a system unit.

Each run is cheap when there is nothing to do. It runs outside the daemon, as the owner, never asks a question, and (src/update/auto.ts):

- installs **only signed releases**, never `main`, and only a version strictly newer than the running one; a request whose tag does not verify or whose version is not newer is finished as failed with the reason. It installs only where it can restart the daemon (section 1A): on a plain process (`manual`) it refuses with "no restart method" before anything changes, the status file's `problem` says so, and a request is finished as failed with that reason without counting a failure,
- writes the heartbeat first, then asks the daemon over loopback, with the api token, for the owner's update request (section 4B) and picks a pending one up at once, on any run. A daemon that does not answer on its port ends the run with nothing installed (there is nothing to restart into) and the status file's `problem` says so,
- checks for new tags once a day in a quiet window: one hour from `CC_UPDATE_AT` (default 04:00, after the 03:15 backup), in the daemon's timezone. The first run inside the window fetches the tags, records what it found, and installs the newest verified newer release at once; outside the window it only refreshes `available` when the last check is more than a day old, and installs nothing. "Once a day" is "once per window", not a 24-hour clock, so the moment never drifts out of the window. A refusal (an untracked file, another branch, no restart method) records `lastCheckAt` and the reason as `problem` too, so it is that window's try and not a fetch every five minutes,
- backs off after a failed install: one day after the first failure in a row, three days after the second, and after the third it stops (`backoffUntil` null, `failures` 3, and a `lastResult` whose message says that automatic updates have stopped) and waits for the owner. Any `cc update` run by hand, other than `--check`, clears the count and the pause. Only the daily check and install respect the backoff: the owner's request is picked up and run on any run, backed off or stopped, because the click is the override; a success clears the count and a failure leaves the ladder where it is,
- writes a heartbeat, its progress, and its result to `data/update-status.json`.

The status file is the updater's alone to write. Its shape: `{ "version": 1, "updaterInstalled": true, "lastRunAt", "lastCheckAt", "running": "2.1.0" | null, "available": { "version", "notes", "touchesSchema" } | null, "request": { "id", "state", "message", "finishedAt" } | null, "lastResult": { "ok", "message", "at", "version" } | null, "backoffUntil", "failures"?, "problem"? }`. The daemon only reads it: a failed result becomes a job warning through src/http/warnings.ts ("The last update failed: ...", or "Automatic updates have stopped: ..." once the updater has stopped), so the dashboard's red strip shows it, and a heartbeat within the last fifteen minutes is what "the updater is installed" means. The daemon ignores `failures` and `problem`, which are the updater's own bookkeeping. The daemon runs nothing to do this; it reads a file.

## 4. The update icon

### 4A. Knowing a release exists

Only the scheduled updater, or the owner running `cc update --check`, looks for a release: a credential-free `git fetch --tags` from `origin`, which is the only outbound call this feature makes and goes to the same place `git pull` already goes. What it finds is written to the status file, and the daemon reads the file. The daemon makes no new outbound call and there is no GitHub API call anywhere in this feature.

A version is shown only once its tag signature verifies against the pinned signers (section 2). An unsigned or unverifiable tag never lights the icon.

### 4B. The icon and its panel

- A small update icon in the dashboard header, shown only when a newer signed release exists. Otherwise nothing is shown.
- 44px target, visible focus ring, a keyboard path, Esc closes its panel. The panel's button is disabled offline through `useOffline()`.
- The panel shows the current version, the new version, the release notes, and whether the update touches the schema, in which case it says a snapshot will be taken first. It never carries a path or a URL: it names a version and the daemon holds the rest.
- **Update now** never makes the daemon run anything. It records an **update request**: owner only (the human actor in the store), REST only, live only, naming the exact release version. There is no offline op kind for it, no MCP tool, and no rule action.
- The scheduled updater sees the request on its next run (within five minutes). It re-verifies the tag's signature, snapshots, installs, health-checks, rolls back on failure, and writes progress and the result to the status file. The panel shows it: "Updating", "Updated to v1.4.0", or "Rolled back: the build failed". After a successful restart the status file carries the result once, so the panel can say "Updated to v1.4.0" and then clear.
- A request expires if the updater has not picked it up within an hour, and the owner can cancel it before it starts. A picked-up request with no outcome two hours after its pickup (the updater's execution limit is one hour: it was stopped or killed) expires too, unless the status file carries its outcome, and the owner can cancel such a row; a fresh picked-up row is mid-install and stays the updater's. Either way the table is free for a new request.
- **Without the scheduled updater installed, the panel has no button.** It shows the `cc update --release` command to copy instead.
- A new state in e2e/shots.spec.js for the icon and for the open panel, checked at both widths and in both themes, and the panel covered by e2e/axe.spec.js.

### 4C. What Polaris stores, and who writes it

An additive migration with one table, `update_requests`: id, version, requested at, requested by (always the human actor), state (pending, picked up, done, failed, cancelled, expired), picked up at, finished at, result message. No existing column changes.

Every row is written by the daemon, and only through its REST routes, so the table has one writer and each transition has one owner:

| Transition | Who asks | How |
|---|---|---|
| created (pending) | the owner, in the panel | `POST /api/update/requests` |
| cancelled | the owner, in the panel | `POST /api/update/requests/:id/cancel`, while pending, or picked up for two hours with no outcome |
| picked up | the updater | `POST /api/update/requests/:id/pickup`, atomic: only a pending row moves, so the daemon's expiry and the updater's pickup cannot both win |
| done or failed | the updater | `POST /api/update/requests/:id/finish` with the result, or, when the daemon was down when the run ended, from the status file: the daemon reconciles a picked-up row with the status file's `request` entry of the same id on the next read |
| expired | the daemon | on any read: a pending row older than an hour, or a picked-up row two hours past its pickup whose outcome is not in the status file (the file is read first, so an outcome that arrived wins) |

The updater reaches these routes with the api token it already reads for the health check, over loopback. They are on `/api`, so an mcp or read-only token gets 401 like everywhere else on `/api`. Events are keyed to a task, so update requests emit no event and are not rule triggers; the panel polls `GET /api/update` instead.

## 5. Security

### Who might misuse an updater, and what stops them

| Threat | What it could try | What stops it |
|---|---|---|
| A compromised GitHub account or repo | Push code that every install runs | Installs follow only tags signed by a key in the pinned `release-signers`. A push to `main`, or an unsigned tag, installs nothing. A changed signers file is not trusted until the owner confirms it on each install. |
| The same, deleting tags | Move every install back to an older signed release | Only a version strictly newer than the running one is ever installed, by `--auto`, by a request, or by `--to`. With the newest tags gone, nothing qualifies and the updater reports "no newer release". |
| A compromised npm dependency | Run code during install | `npm ci --ignore-scripts` from lockfiles CI tested, with the one rebuilt package pinned by a test, and the release checklist. A signed release still carries whatever its lockfile names, so the owner's review of dependency changes before tagging is the real guard. |
| A malicious change merged by mistake | Reach every install | It reaches no install until the owner tags and signs a release that contains it. |
| A tampered download in transit | Swap the code | Git verifies objects by hash, the tag signature covers the commit, and the fetch runs over HTTPS. A mismatch fails closed. |
| A mislabelled release | Run an old build under a new tag | After checkout the package.json version must equal the tag, or the command refuses and rolls back. |
| A failed migration | Leave the database half-changed | A named snapshot before every update, checked like a backup and safe from the daily copy. A rollback that finds the database ahead of the previous code stops the daemon and restores the snapshot before restarting. |
| A half-finished update | Leave the daemon down or on mixed code | The daemon keeps running until the restart: the snapshot is live, the build goes to `dist.next`, and tests run first. A failed health check rolls back code, `dist`, and the database. A failed rollback is loud and leaves the snapshot path. On a plain process the owner restarts by hand and the command says so. |
| A stolen api token or Tailscale session | Press Update now, or call the updater's routes | A request can only name a release the owner signed and published, newer than the running one, and the updater re-verifies the signature. Pickup and finish change nothing but a row's state. The worst case is installing the owner's own newer release early. Requests show in the panel and expire after an hour. |
| An attacker on the same machine | Edit the checkout, the status file, or the pinned signers | Out of scope for any app: a local account that can write the owner's files can change Polaris directly. The updater refuses files that other users can write, as the secret store does. |
| A fork of Polaris | Trust upstream by accident | A fork carries its own `release-signers` and pins it on its own installs. |

### Fail closed

Any doubt stops the update before the restart: a dirty tree, a target that is not newer, a signature that does not verify, a signers file with no keys, a lockfile install that fails, a failing test, a failing build, a version that does not match its tag. After the restart, any doubt rolls back, and a rollback that finds a migrated database restores the snapshot.

## 6. What the agent surfaces get

Nothing. There is no MCP tool, no read-only MCP tool, and no runner route (the per-machine runner proposed in PR #9) that checks for, requests, or installs an update. An agent cannot press Update now, and rules have no update action. There are no update events, so nothing about an update is a rule trigger.

## 7. Rule changes, approved 2026-10-06

1. **A CLI that runs programs.** `cc update` runs `git`, `npm ci`, the tests, the build, and a restart. The daemon still never does. The module that does it is reached only through a dynamic import from the `update` command, so the daemon's static import graph never includes it (section 8).
2. **Signed releases** with a committed `release-signers` file, pinned on each install.
3. **An OS-scheduled job**, opt-in, that runs `cc update --auto` outside the daemon.
4. **A credential-free `git fetch --tags` from `origin`**, from the updater and `cc update --check` only, never from the daemon. No GitHub API call and no token.
5. **Restarting a systemd system unit** through a sudoers line naming only `systemctl` with stop, start, and restart on the `polaris` unit (section 1A), with a user unit as the supported alternative.
6. **Update request routes**: owner only, REST only, live only, naming a version, with an additive `update_requests` table whose every transition is in the table in section 4C.
7. **The update icon and panel** in the dashboard header, with no button unless the scheduled updater is installed.
8. **Nothing for agents or offline**: no MCP tool, no runner route, no REST route that installs anything, no outbox op kind, no rule action.
9. **New "When to ask" lines** in CLAUDE.md: updating from anything but a verified signed tag in auto mode; installing a version that is not newer; widening the allowed signers without the owner's confirmation; letting the daemon run an update or start a program; adding an update tool for agents; sending any credential with the release check.

## 8. Invariants to add

A new group in command-center/src/invariants.test.ts (11, or 12 if the runner group lands first):

- The daemon and the http server never run `git`, `npm`, or a restart. As a check on the source: walking the static imports from src/daemon/daemon.ts and src/http/server.ts reaches no module that imports `node:child_process` or `child_process` except src/ingest/secrets.ts, whose PowerShell call for DPAPI is the one allowed program. The update module is reached only by a dynamic import in the `update` command.
- No REST route, MCP tool, or runner route installs anything or starts a program.
- The update request routes require the human actor, are refused for the mcp and read-only tokens, and must name a release version. A request without a version, or with a version that is not newer than the running one, is refused.
- Pickup moves only a pending row; a second pickup, or a pickup of an expired or cancelled row, is refused.
- There is no outbox op kind and no rule action for an update request, and no update event kind exists.
- The updater ignores a request for a version whose tag does not verify against the pinned signers, and records why.
- `cc update --auto` refuses `main`, unsigned tags, tags it cannot verify, and any version not newer than the running one.
- A failed update leaves the previous version running: a test that fails the build or the health check ends on the old commit with a healthy daemon, and a test that fails after a migration ends with the snapshot restored.
- The release check sends no credential and never reads the GitHub App's secrets.
- The update path writes to `command-center/data` only through the backup code, the snapshot restore in a rollback, and its own log and status files.
- The panel's Update now control is disabled offline and absent when no updater is installed.
- The two package.json versions are equal.

## 9. Phases

- **Phase A: `cc update`, manual.** Refuse, fetch, named snapshot, checkout, `npm ci --ignore-scripts`, test, staged build, restart, health check, rollback with snapshot restore, log and status file. Restart for the Windows task, both systemd forms, and a plain process. The update module behind a dynamic import, with the import-graph invariant.
- **Phase B: releases.** The version rule (corrected: `main` needs new commits and a version that is not older; a release must be strictly newer), `release-signers`, pinning, `--release`, `--to`, `--check` (which reports `origin/main` and the releases, and writes `available` to the status file), `--trust-signers`, starting from a release tag, docs/releases.md with the key setup, a CHANGELOG, the version-equality test.
- **Phase C: the scheduled updater.** `--auto`, the quiet window and backoff, the status file, the two installers and the sudoers line, the job warning. Built last: it wires the other three together.
- **Phase D: the update icon.** The icon and panel, `GET /api/update`, the request routes and table, the updater picking up requests, shots and axe coverage, the invariants group.

## Open questions

- Should the deploy-only checkout stay the recommended pattern, with development always in a second clone? (Yes for now: `cc update` refuses a dirty tree, which a development clone usually is.)
- Release cadence: a release per merged feature, or batched?
- What forks do: their own key and `release-signers` is the design. `cc update --release` refuses to run until the pinned file has a key, which answers it for now.

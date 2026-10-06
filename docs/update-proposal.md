# Safe updates: proposal

Status: proposal, 2026-10-06, awaiting the owner's approval. Nothing here is built. Each change it makes to the project rules is listed in section 7 for the owner to approve one by one.

This document proposes how a Polaris install gets newer code: a `cc update` command the owner runs, signed releases, an opt-in scheduled updater, and an update icon on the dashboard that says when a newer release exists and can ask the updater to install it. Security is a requirement throughout, because an updater decides what code runs next to the owner's data on every install.

## Where things stand

- Updating is manual. On every install it is: `git pull`, `npm install` at the root, `npm --prefix command-center install`, `npm run build`, then a restart of the daemon. The owner snapshots the database first when `command-center/src/core/schema.ts` changes.
- The owner's own host, GR9, runs the daemon as a systemd system unit (`polaris.service`) from a deploy-only checkout. Restarting it needs `sudo` with a password. On Windows the daemon runs from the logon task that `scripts/install-command-center-task.ps1` installs, restarted with the wait-for-the-port loop in command-center/README.md.
- Polaris has no tags and no releases. The merge commits on `main` are signed, but by GitHub's web-flow key, which proves only that the merge happened on github.com. Nothing marks one commit as "a version meant to run".
- The daemon runs its jobs in-process and starts no program, with one exception: on Windows the secret store runs PowerShell to use DPAPI (src/ingest/secrets.ts). Its only outbound calls are to GitHub with the read-only App's user token, the only credential (CLAUDE.md).
- The backup code (src/daemon/backup.ts) makes a checked copy with `VACUUM INTO` and reads it back before it counts. `cc backup check` proves a copy restores without opening the live database.
- A failing job reaches the dashboard as `warnings` on `GET /api/sync` (src/http/warnings.ts), shown by src/JobWarningsBanner.jsx.

## Why not follow `main` automatically

The simplest updater pulls `main` on a timer. Rejected:

- **Every install would run whatever reaches `main` within the hour.** A compromised GitHub account, a stolen session, or a malicious change merged by mistake would become code execution on every install that cloned Polaris, with the owner's data in reach.
- **The daemon would have to start programs.** Updating means running `git`, `npm ci` (which runs install scripts from npm packages), a build, and a restart of the daemon itself. That is the reverse of the daemon's posture and hard to state as an invariant.
- **There is no line between a commit and a version.** A commit that lands is not the same as a version the owner decided people should run.

## 1. `cc update`, run by the owner

A new CLI command, `npm run cc -- update`. The owner runs it; the daemon never does.

1. **Refuse** when the working tree has uncommitted changes, is not on `main` (or, after phase B, on a release tag), or has local commits not on the remote. A deploy checkout should never carry local work, and an update must not throw any away.
2. **Fetch** and show what changes: the commits, whether `schema.ts` changes, and whether either lockfile changes.
3. **Snapshot** the database through the backup code before any update that touches `schema.ts`, with the daemon stopped so the copy is quiet. (Open choice: snapshot before every update. It costs a few seconds and one file.)
4. **Install** from the lockfiles with `npm ci` at the root and in command-center/, so the exact versions CI tested are what runs.
5. **Test and build**: `npm run test:fast`, then `npm run build`. A failure stops here, before anything restarts.
6. **Restart** the daemon the platform's way (section 1A).
7. **Health check**: `GET /api/health` answers 200 within a timeout.
8. **Roll back on any failure** after the checkout moved: return to the previous commit, `npm ci` again, rebuild, restart, and health-check that. The running version is never left broken. If the rollback also fails, it says so loudly and leaves the snapshot path on screen.
9. **Log** every step to `data/update.log`.

The command never touches `command-center/data` except through the backup code and its own log and status files. It never reads or prints a token.

### `npm ci --ignore-scripts`?

- Buys: no npm package's install script runs during an update, which removes the most common route for a compromised dependency.
- Costs: some dependencies need their script (a native build, a downloaded binary). It needs checking against today's lockfiles. If it works, it is the default; if not, the doc lists the packages that need scripts.

### 1A. Restarting the daemon

| Install | How `cc update` restarts it |
|---|---|
| Windows logon task | Stop the task, wait until nothing listens on the port, start the task (the README's loop) |
| Plain process (`npm run cc -- daemon`) | Prints that the owner must restart it, and health-checks once they have |
| systemd system unit (GR9) | Needs root. See the options below |

For a systemd system unit:

- **A sudoers or polkit rule** that lets the owner's account run exactly `systemctl restart polaris` without a password.
  - Buys: the unit stays as it is.
  - Costs: a system-level rule the owner installs and must understand. It must name the one unit and the one verb.
- **A systemd user unit** instead (`systemctl --user`, with lingering enabled so it runs without a login).
  - Buys: no root needed to restart; the update runs entirely as the owner.
  - Costs: GR9 moves from a system unit to a user unit, its drop-ins move with it, and boot ordering (the NAS mount, Tailscale) has to be redone at user level.

## 2. Releases

Signed tags mark the versions meant to run.

- The owner tags `vX.Y.Z` on `main` and signs the tag with their own key (an SSH signing key or GPG), never GitHub's.
- An `allowed_signers` file committed in the repo lists the keys allowed to sign releases.
- `cc update --release` installs the newest tag whose signature verifies against the allowed signers. A tag that does not verify is skipped and reported, never installed.
- **Pinning.** On first install, `cc update` copies the allowed-signers file into `data/` and trusts that copy from then on (trust on first use). A later change to the committed file does not widen trust by itself: a new key is accepted only when the owner confirms it with `cc update --trust-signers`, which shows the old and new keys.
- **Key rotation.** The owner adds the new key to `allowed_signers` in a release signed by the old key, then the installs confirm it once.
- **Release checklist.** CI green on the commit, `npm run test:ui` run, a CHANGELOG entry that names any migration, then the signed tag and a GitHub release with the same notes.

A fork has its own key and its own allowed-signers file, so it never trusts upstream's releases unless its owner chooses to.

## 3. Automatic updates, opt-in

Off by default. An installer schedules `cc update --auto` with the operating system:

- a Windows scheduled task beside the logon task (an `-Updater` switch on the existing installer, or a second script),
- a systemd timer on Linux.

It runs outside the daemon, as the owner, and:

- installs **only signed releases**, never `main`,
- runs in a quiet window the owner chooses (default 04:00, after the 03:15 backup),
- backs off after a failure (one day, then three, then stops and waits for the owner),
- writes its progress and result to a status file, `data/update-status.json`.

The daemon reads that file and turns a failure into a job warning through src/http/warnings.ts, so the dashboard's red strip shows it. The daemon runs nothing to do this; it reads a file.

It also picks up update requests from the dashboard (section 4B).

## 4. The update icon

### 4A. Knowing a release exists

Something must check GitHub's public releases list. Two options:

- **The daemon checks.** At most once a day, `GET https://api.github.com/repos/<owner>/<repo>/releases/latest` with no credential.
  - Buys: works even without the scheduled updater.
  - Costs: a new kind of outbound call from the daemon. It must never send the GitHub App's token, and it needs its own invariant.
- **Only the scheduled updater checks** (recommended). It checks when it runs and writes what it found to `data/update-status.json`; the daemon only reads the file.
  - Buys: the daemon makes no new outbound call.
  - Costs: without the updater installed, the icon only appears after the owner has run `cc update --check` by hand.

Either way the check carries no credential, and the version it finds is shown only once its tag signature verifies (section 2). An unsigned or unverifiable release never lights the icon.

### 4B. The icon and its panel

- A small update icon in the dashboard header, shown only when a newer signed release exists. Otherwise nothing is shown.
- 44px target, visible focus ring, a keyboard path, Esc closes its panel. Disabled offline through `useOffline()`.
- The panel shows the current version, the new version, the release notes, and whether the update touches the schema, in which case it says a snapshot will be taken first.
- **Update now** never makes the daemon run anything. It records an **update request**: owner only (the human actor in the store), REST only, live only, naming the exact release tag. There is no offline op kind for it, no MCP tool, and no rule action.
- The scheduled updater polls for a pending request every few minutes. When it finds one it re-verifies the tag's signature, snapshots, installs, health-checks, rolls back on failure, and writes progress and the result to the status file. The panel shows it: "Updating", "Updated to v1.4.0", or "Rolled back: the build failed".
- A request expires if the updater has not picked it up within an hour, and the owner can cancel it before it starts.
- **Without the scheduled updater installed, the panel has no button.** It shows the `cc update --release` command to copy instead.
- A new state in e2e/shots.spec.js for the icon and for the open panel, checked at both widths and in both themes, and the panel covered by e2e/axe.spec.js.

### 4C. What Polaris stores

An additive migration with one table, `update_requests`: id, tag, requested at, requested by (always the human actor), state (pending, picked up, done, failed, cancelled, expired), finished at, result message. No existing column changes. The updater writes its results to the status file, not the database, so the database has a single writer as now; the daemon copies the result onto the request when it reads the file.

## 5. Security

### Who might misuse an updater, and what stops them

| Threat | What it could try | What stops it |
|---|---|---|
| A compromised GitHub account or repo | Push code that every install runs | Installs follow only tags signed by a key in the pinned allowed-signers file. A push to `main`, or an unsigned tag, installs nothing. A changed allowed-signers file is not trusted until the owner confirms it on each install. |
| A compromised npm dependency | Run code during install | `npm ci` from lockfiles CI tested, `--ignore-scripts` where it works, and the release checklist. A signed release still carries whatever its lockfile names, so the owner's review of dependency changes before tagging is the real guard. |
| A malicious change merged by mistake | Reach every install | It reaches no install until the owner tags and signs a release that contains it. |
| A tampered download in transit | Swap the code | Git verifies objects by hash, the tag signature covers the commit, and the check runs over HTTPS. A mismatch fails closed. |
| A failed migration | Leave the database half-changed | A snapshot through the backup code before any update that touches the schema, with the daemon stopped. Rollback restores the previous code; the snapshot restores the data. |
| A half-finished update | Leave the daemon down or on mixed code | Test and build happen before the restart. A failed health check rolls back. A failed rollback is loud and leaves the snapshot path. |
| A stolen api token or Tailscale session | Press Update now | It can only ask for a release the owner signed and published, and the updater re-verifies the signature. The worst case is installing the owner's own newer release early. Requests show in the panel and expire after an hour. |
| An attacker on the same machine | Edit the checkout, the status file, or the pinned signers | Out of scope for any app: a local account that can write the owner's files can change Polaris directly. The updater refuses files that other users can write, as the secret store does. |
| A fork of Polaris | Trust upstream by accident | A fork carries its own allowed-signers file and pins it on its own installs. |

### Fail closed

Any doubt stops the update before the restart: a dirty tree, a signature that does not verify, a lockfile install that fails, a failing test, a failing build, a health check that times out. After the restart, any doubt rolls back.

## 6. What the agent surfaces get

Nothing. There is no MCP tool, no read-only MCP tool, and no runner route (docs/machine-runner-proposal.md) that checks for, requests, or installs an update. An agent cannot press Update now, and rules have no update action. Update events are not rule triggers.

## 7. Rule changes for the owner to approve

Each is a separate yes or no.

1. **A CLI that runs programs.** `cc update` runs `git`, `npm ci`, the tests, the build, and a restart. The daemon still never does.
2. **Signed releases** with a committed `allowed_signers` file, pinned on each install.
3. **An OS-scheduled job**, opt-in, that runs `cc update --auto` outside the daemon.
4. **A credential-free call to GitHub's releases list**, from the scheduled updater only (4A recommended) or from the daemon too. It never carries the App token.
5. **Restarting a systemd system unit**: a sudoers or polkit rule naming only `systemctl restart polaris`, or a move to a systemd user unit.
6. **An update request route**: owner only, REST only, live only, naming a tag, with an additive `update_requests` table.
7. **The update icon and panel** in the dashboard header, with no button unless the scheduled updater is installed.
8. **Nothing for agents or offline**: no MCP tool, no runner route, no REST route that installs anything, no outbox op kind, no rule action.
9. **New "When to ask" lines**: updating from anything but a verified signed tag in auto mode; widening the allowed signers without the owner's confirmation; letting the daemon run an update or start a program; adding an update tool for agents; sending any token with the release check.

## 8. Invariants to add

A new group in command-center/src/invariants.test.ts (11, or 12 if the runner group lands first):

- The daemon and the http server never run `git`, `npm`, or a restart. As a source check (as group 8 checks the fake GitHub): outside src/ingest/secrets.ts, whose PowerShell call for DPAPI is the one allowed program, nothing they load imports `child_process`.
- No REST route, MCP tool, or runner route installs anything or starts a program.
- The update request route requires the human actor, is refused for the mcp, read-only, and runner tokens, and must name a tag. A request without a tag is refused.
- There is no outbox op kind and no rule action for an update request, and update events are not rule triggers.
- The updater ignores a request for a tag that does not verify against the pinned allowed signers, and records why.
- `cc update --auto` refuses `main`, unsigned tags, and tags it cannot verify.
- A failed update leaves the previous version running: a test that fails the build or the health check ends on the old commit with a healthy daemon.
- The release check sends no `Authorization` header and never reads the GitHub App's secrets.
- The update path writes to `command-center/data` only through the backup code and its own log and status files.
- The panel's Update now control is disabled offline and absent when no updater is installed.

## 9. Phases

- **Phase A: `cc update`, manual.** Refuse, fetch, snapshot, `npm ci`, test, build, restart, health check, rollback, log. Restart support for the Windows task and a plain process; the systemd choice (1A) decided by the owner. Only rule change 1.
- **Phase B: releases.** Signing, `allowed_signers`, pinning, `cc update --release`, the release checklist, a CHANGELOG.
- **Phase C: the scheduled updater.** The installers, `--auto`, the quiet window and backoff, the status file, the job warning.
- **Phase D: the update icon.** The check (4A), the icon and panel, the update request route and table, the updater picking up requests, shots and axe coverage, the invariants group.

## Open questions

- Windows and Linux parity: the Windows logon task restarts as the owner without elevation, systemd system units do not. Is a user unit the better default for Linux installs?
- How GR9 fits: keep the system unit with a one-line sudoers rule, or move it to a user unit and redo its NAS and Tailscale ordering.
- Should the deploy-only checkout stay the recommended pattern, with development always in a second clone?
- Release cadence: a release per merged feature, or batched?
- What forks do: their own key and allowed-signers file is the proposal. Should `cc update` refuse to run in a fork until its owner has set one?
- Does every current dependency work with `npm ci --ignore-scripts`?

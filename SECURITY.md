# Security

## Supported versions

The `main` branch is the supported version. Fixes land there first. There are no maintained release branches, and a tagged release older than `main` gets a fix only by moving to `main`.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub's private vulnerability reporting on this repository: open the Security tab at https://github.com/owenpkent/polaris/security and choose Report a vulnerability, or go straight to https://github.com/owenpkent/polaris/security/advisories/new. There is no public email address for reports yet.

Include what you found, how to reproduce it, which commit you tested, and what you think the impact is. A proof of concept helps. If the problem is in a dependency, say which one and whether it has its own advisory.

## What to expect

- An acknowledgement within seven days.
- A fix on `main`, with a note in the commit message that it closes a reported issue, once the fix is ready. Reports that need a design change take longer, and you will hear where things stand.
- Credit in the advisory and the commit if you want it. Say so in the report, and say how you want to be named.
- The advisory is published after the fix lands.

## Security model, in short

This is how Polaris is meant to be deployed. A report that shows one of these promises being broken is in scope. A report that assumes a different deployment (the daemon on a public address, a shared machine with a writable data folder) is still welcome, but it may be answered with documentation rather than a code change.

- **Loopback only.** The HTTP server binds to 127.0.0.1 and warns if asked to bind anywhere else. Every response forbids framing. Remote access is the owner's choice, over a private network they control; there is no OAuth, so the server is not meant to face the public internet.
- **Bearer tokens, one per trust boundary.** Three independent tokens are generated next to the database: `api-token` for the dashboard's REST API, `mcp-token` for the full MCP endpoint, and `mcp-readonly-token` for the read-only MCP endpoint. Each is compared in constant time. An MCP token is refused by the REST API, so an agent cannot reach the route that enables rules. The two GitHub sign-in callbacks accept only a single-use state value that expires after ten minutes, and `GET /api/identity` answers a challenge with an HMAC keyed by the api token without revealing it.
- **Read-only GitHub App.** The only GitHub credential is the user token of a GitHub App with read-only permissions (metadata, contents, issues, pull requests, checks, statuses) and webhooks off. Nothing in Polaris writes to GitHub or to any repository. Personal access tokens and the `gh` login are not used.
- **One secret store.** The GitHub App's client secret and sign-in, and the backup passphrase if one is set, live in a secret store: Windows DPAPI on Windows, a `secrets.json` with mode 0600 elsewhere, which the server refuses if group or others can read it. Secrets are never in the database, in git, in an environment variable, or in a log. The backup passphrase can be set over the REST API and is never returned by any route, and there is no MCP tool that touches it.
- **Untrusted text is marked and never followed.** A task whose title or notes came from a third party carries an `untrusted_text` flag that is set at ingest, inherited by anything derived from it, and never cleared. Such a task always starts in the inbox; the store refuses any other starting status. MCP output labels the text `UNTRUSTED-TEXT`, the server instructions tell the agent to treat it as data, no model reads it on the server, and rules cannot copy it into trusted fields.
- **Agents propose.** Rules created over MCP are saved disabled and cannot be enabled, edited, or deleted over MCP. Rule actions cannot complete, drop, accept, or reject a task, or reach outside the database. Offline edits replayed from the dashboard can only create, edit, complete, reopen, move, or comment on a task, never touch the inbox, a rule, a goal, or a project.
- **Bounded engines.** Rule patterns run on a linear-time matcher that refuses backreferences and lookaround, and recurrence rules are walked over a bounded horizon, so no stored rule can stall the daemon.
- **Audit log.** Every change is an event with an actor (human, agent, system, rule). `npm run cc -- show <id>` prints a task's history.

These promises are stated as tests in `command-center/src/invariants.test.ts`. A security fix that needs one of those tests to change is a design change, and the report will say so.

A security review of the codebase in September 2026 found seven issues, all of which have been fixed. The review itself is not published.

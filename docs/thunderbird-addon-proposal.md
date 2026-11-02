# Thunderbird add-on: proposal

Status: scope, 2026-11-02, awaiting the owner's choices in "Decisions". Nothing here is built.

The add-on turns an email the owner is reading in Thunderbird into a Polaris task with one click. It is a capture tool in the same family as the share sheet (src/command-center/shareIntake.js): the owner picks the message and confirms the task, and nothing happens without that click.

## What it does

1. A "Send to Polaris" button on the message toolbar (`message_display_action`) and the same item on the message list's context menu, for one or several selected messages.
2. A small popup prefilled from the message: title (the subject, editable), project (a list from `GET /api/projects`), due date, and priority. Every control has a 44px target, a focus ring, and a keyboard path; Esc closes it.
3. Create posts to `POST /api/tasks`. On success the popup shows a link that opens the task on the dashboard. On failure it says why (unreachable, 401, 503 during an update) and keeps what the owner typed.
4. Options page: the server URL, and the api token only when Tailscale identity is not available.

Out of scope for v1: polling a folder, filters or rules that create tasks unattended, writing anything back to the mail (tags, moving, replying), attachments, and an offline queue.

## How it fits the project rules

- **Only the owner's click creates a task.** No background job, no folder watcher, no rule. This keeps it inside "propose, do not act" without any change to the rules.
- **No new external source unless the owner chooses one** (Decision 1). Gmail ingest was removed; this does not bring polling back.
- **No write to an external service.** The add-on reads the open message through `messenger.messages` (permission `messagesRead`) and writes only to Polaris.
- **Auth.** Over the tailnet, a request to `https://owen-gr9.tail220e4e.ts.net` through `tailscale serve` already carries the owner's login, so with `CC_TAILSCALE_LOGIN` set the add-on needs no token at all. Otherwise the api token is pasted once into the options page and kept in the add-on's `storage.local`, which is plain text in the Thunderbird profile; the options page says so. The add-on never touches `/mcp`.
- **CORS.** A MailExtension fetch to a host listed in `host_permissions` is not subject to CORS, so `CC_CORS_ORIGINS` should not need the `moz-extension://` origin. To verify in the spike; if it does, the origin is per install and goes in the owner's config, not a default.
- **Offline.** No outbox and no new op kind. If the server cannot be reached, the popup says so and the owner retries.
- **Writes during an update** get a 503 from the write barrier; the popup shows "Polaris is updating, try again in a minute".

## Decisions

1. **Trust model for the email's text.**
   - A (recommended). Owner's own text, like the share sheet. The title is the subject as the owner confirmed or edited it. The notes hold only the sender, the date, and the Message-ID as plain text; the body is not copied. Task is created open in the chosen project, with no source type. No invariant changes.
   - B. Email as a third-party source. Add an `email` source type to `EXTERNAL_SOURCE_TYPES`; the store forces the task into the inbox with `untrusted_text`, and the body (plain text, capped) goes into the notes. Needs the owner's approval: it changes group 1 of invariants.test.ts, which today pins the external sources to github, gmail, gdrive, and gcal. Source id would be the Message-ID, so sending the same message twice updates rather than duplicates.
2. **Where the code lives.** Decided 2026-11-02: a `thunderbird/` folder in this repo next to `mobile/`, versioned with the API it calls, its tests run in `npm run test:fast`.
3. **Distribution.** Load the unsigned XPI from about:debugging, or install a self-signed XPI with `xpinstall.signatures.required` off (recommended for a single user), or list it on addons.thunderbird.net (needs review, public).

## Build plan (after the decisions)

1. Spike, half a day: MV3 manifest for the current Thunderbird ESR, the toolbar button, a hard-coded `POST /api/tasks` against a scratch daemon (`CC_DB`, `CC_BACKUP_DIR`, `CC_SECRETS_DIR` on temp paths). Confirms the CORS and Tailscale-identity assumptions.
2. Popup and options page, styled from the dashboard's tokens in src/index.css (copied, since the add-on does not load the dashboard bundle), light and dark.
3. A pure `messageToTask(header, choices)` module with Vitest tests, plus a property test on the subject and sender handling, since that is third-party text.
4. thunderbird/README.md: install, sign in, what is stored where. A line in CLAUDE.md under "How the pieces work".

Rough size: 2 to 3 days for Decision 1A; add about a day for 1B (source type, invariant and store tests, inbox label in InboxTab.jsx).

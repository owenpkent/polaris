# Offline edits and clocks: a proposal

Written on 2026-11-17, after the reading list in docs/related-projects.md (pull request #192) named a hybrid logical clock (as Actual Budget uses) as a way to make "the newer edit wins" safe when a device's clock is wrong. This document checks that idea against the code and proposes something smaller. Nothing here is built.

**The short answer: a hybrid logical clock would not fix the problem. Teaching each device the server's time would, and it is a smaller change.**

## Where things stand

An edit made offline is queued by the dashboard (src/command-center/outbox.js) and replayed through `POST /api/outbox`, where core/outbox.ts merges it per field.

- **The stamp.** Each queued edit carries `at`, the device's own wall clock when the edit was made (`Date.now()`), and `base`, the task's `updatedAt` as the device last saw it. `base` was written by the server, so it is in server time. `at` is not.
- **What competes.** Only a change that reached the server after `base` competes with an offline edit. Anything the device had already seen cannot, whatever the clocks say. This part is sound and stays as it is.
- **Who wins.** Between an offline edit and a competing change to the same field, the later stamp wins. A live edit is stamped by the server. An offline edit is stamped by its device, and the server only clamps a stamp from the future down to the moment it arrived (`clampToNow`). The loser goes to the task's history as `task.sync_conflict` and can be restored.
- **Queue order.** A device's own edits are replayed in the order of their queue keys, and a key is the device's wall clock, then a counter that restarts with the page.
- **The device never learns the server's time.** No response carries it: `/api/health` returns the date only, and the server exposes no headers to the Android app's origin.

The tests cover a tie in the same millisecond, arrival order, and a phone a year ahead (core/outbox.test.ts, core/outbox.property.test.ts). No test models a clock that is behind, or one that changes while the device is offline.

## What goes wrong

Three cases, with times as a correct clock would show them. In each, both edits are to the same field of the same task, and the phone last synced at 12:00.

| Case | What happens | Today | Right answer |
|---|---|---|---|
| 1. Phone 10 minutes behind | Laptop edits live at 12:01. Phone edits offline at 12:05, which its clock calls 11:55. | The laptop's older edit is kept; the phone's goes to history | The phone's edit, made last |
| 2. Phone 10 minutes ahead | Phone edits offline at 12:05, which its clock calls 12:15. Laptop edits live at 12:08. Phone reconnects at 12:10. | The stamp is clamped to 12:10, so the phone's older edit wins | The laptop's edit, made last |
| 3. Phone's clock is set back while offline | Phone edits the title to "A" at a stamp of 12:15, the clock is corrected by 10 minutes, then the phone edits the title to "B" at a stamp of 12:07. | "B" sorts first in the queue, so "A" is applied last and stays. No conflict is recorded, because both edits are from one device | "B", typed last |

Cases 1 and 2 leave a trace in the task's history. Case 3 leaves none. Case 3 was reproduced in a scratch test on 2026-11-17 during review: the dashboard sent "B" first and "A" last, in one batch, and the server does not compare two edits from one device.

How likely is any of this? Not very. A phone or a laptop that sets its clock from the network is usually within a second of the server, and the two edits must be to the same field of the same task and closer together than the error. The risk is a device whose clock is plainly wrong (set by hand, a dead clock battery, no network time), and today nothing would tell the owner.

## Why a hybrid logical clock does not help

A hybrid logical clock stamps each event with the largest clock value its device has seen so far (its own or anyone's it has heard from), plus a counter. I read Actual Budget's implementation (packages/crdt/src/crdt/timestamp.ts) to check what it does:

- It guarantees that a device's stamps never go backwards, and that an edit made after seeing another edit is stamped later than it.
- It never measures or corrects the difference between two machines' clocks. It refuses to sync when a stamp is more than five minutes ahead of the local clock.

Against the three cases:

- **Case 1** is unchanged. Even if the server's stamps were fed into the phone's clock, the phone's hybrid clock at 12:05 would be "12:00 plus a counter" (the last server time it saw), which is still before the laptop's 12:01. The phone still loses.
- **Case 2** is unchanged. The phone's stamp is still 12:15.
- **Case 3** is fixed, by the never-backwards guarantee alone.

The other things a hybrid clock offers, Polaris already has by other means: an edit cannot lose to something its device had already seen (`base`), and ties are broken the same way whatever the arrival order (op id, and a live edit wins a tie). And it would cost a new stamp format through the merge, the stored rows, and the tests of the most carefully tested module in the server.

So the entry in docs/related-projects.md was right that there is a gap and wrong about the remedy. It is corrected in #192.

## The change proposed

Order and time are two different things, and today one number does both jobs. The change separates them. It is in the dashboard, plus one field from the server.

**1. The queue is ordered by a counter, not by the clock.**

- Each queued edit gets the next number of a counter that lives in the queue's own store (IndexedDB) and is advanced in the same step that adds the edit. So it survives a restart, and two tabs on one device cannot issue the same number. (Today the key is the wall clock and a counter that restarts with the page, so two tabs queuing in the same millisecond would write the same key. That needs a coincidence no person can produce, but it goes away too.)
- Edits are replayed in the order they were made, whatever the clock did in between.
- This fixes case 3. It is the one useful part of the hybrid clock.

**2. The device learns the server's time.**

- Server: `GET /api/events`, which the dashboard already polls and never stores, also returns the server's current time. One field, no new route. The poll is sent with `cache: 'no-store'`, since the server sets no cache header on `/api`.
- Dashboard: on each poll it notes its own clock before and after the request and computes an offset: the server's time minus the midpoint of the two. The error is at most half the round trip, and a sample with a long round trip (over two seconds, say) is thrown away. It keeps the best recent sample per server.

**3. An edit's time is worked out when it is sent, in server time.**

- A queued edit stores the device's own clock reading, as today. When the queue is sent, each edit's `at` is that reading plus the offset measured on this reconnection: sending waits for one fresh measurement. Then the times are made to rise in queue order (an edit is never stamped earlier than the one before it).
- Worked out at send time, not at edit time, so one rule covers three cases: an edit queued before the device had any offset, an offset that would be days old, and a queue that mixes both.
- The wire format does not change: `at` is still one ISO time. The merge in core/outbox.ts does not change, and `clampToNow` stays as a backstop.
- This fixes cases 1 and 2: the phone's 12:05 edit is stamped 12:05 whatever its clock says. It also makes an offline completion's time right, which is the day a repeating task counts its next copy from.

**4. The owner can see it.** A line on Settings, per device: "This device's clock is 0.3 seconds ahead of the server." Above some threshold (30 seconds, say) it becomes a plain warning that says the edits made offline on this device are still ordered correctly, and that the clock should be fixed anyway. This is the only visible change.

## What this trusts, and what it does not fix

- The stamp is still the device's claim, as today. A device that lies about time can still win a conflict it should lose, by at most the time until it reconnects. There is one owner and their own devices, so this is unchanged and acceptable.
- A clock that is changed while the device is offline. The offset measured at reconnection is right for the edits made after the change and wrong, by the size of the change, for those made before it. If the clock was set back, the earlier edits come out later than the server's "now" and are clamped to it, so several of them share one time: among themselves the queue order still decides, and against another device's edit in that same instant the tie falls to the op id, as any tie does today. The order in which this device's own edits apply is right in every case, since it no longer depends on time.
- If the server's own clock is wrong, every stamp is wrong together, so the order of edits is still right.
- Two edits made closer together than the measurement error are still ordered by chance. Nothing can fix that, and the loser is in the history.
- The Android app runs the same code in its WebView and needs nothing of its own. This is reasoned from mobile/README.md, not tested.

## What does not change

No new offline op kind, no schema migration, no change to the merge in core/outbox.ts, nothing for MCP, rules, or the CLI. The propose-do-not-act rules are not touched. None of this is under "When to ask" in CLAUDE.md except in the sense that it changes which edit wins, which is why it is a proposal.

## Tests

- core/outbox.property.test.ts: a model with devices whose clocks are off by a random amount. With corrected stamps the merge must pick the edit that was really made last, outside the error bound. The same model with raw stamps documents cases 1 and 2.
- src/command-center/outbox.test.jsx: case 3 first, as a failing test against today's code (two edits to one field, the second with an earlier clock: today the later one is sent first). Then: the counter survives a new page and is shared by two queues on one store; an edit queued with no offset is stamped with the one measured at reconnection; times rise in queue order; times that would pass the server's "now" are clamped and still apply in order.
- A unit test for the offset: the shortest round trip wins, a slow response is thrown away, it is kept per server, and sending waits for a fresh one.
- The response shape of `GET /api/events` is documented in command-center/src/http/README.md and pinned by tests; both change with the new field.
- e2e: the UI tests freeze the browser's clock at the moment the database was seeded, so the measured offset there grows as a test runs. Check that no offline spec asserts on a stamp before turning this on.

## Rollout

One pull request for parts 1 to 3 and their tests. Part 4 (the Settings line) is a change to how the dashboard looks, so it ends with the screenshot run, and can be the same pull request or the next one. Part 1 alone is worth having and could go first: it fixes the one case that leaves no trace, and it changes nothing about which device wins.

## Size

About 200 lines in the dashboard, one field in one server route, and the tests. A day's work including review.

## Open questions for the owner

1. Build parts 1 to 3 now, or only part 1 (the order fix) and the Settings line first, and look at the real offsets of the phone and the laptop for a week before deciding?
2. Should a badly wrong clock be a quiet line on Settings, or also a warning in the offline banner?

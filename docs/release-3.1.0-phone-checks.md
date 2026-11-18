# Phone checks for release 3.1.0

Eight short checks on the real phone, about five minutes in all. They cover what the emulator
could not: a current WebView, a real finger, and the phone's own width. The release pull request
deletes this file together with the plan (docs/release-3.1.0-plan.md).

## When

The easy way is after the release: the app offers "Update ready", Install and then Android's own
question install it, and the server updates itself. Nothing to build and no cable. If a check
fails then, the fix goes out as the next release.

To check before the release is signed instead, the phone has to be on a USB cable and the eToken
plugged in, and on main after the merges this builds, signs and installs the app:

```sh
npm run release:apk -- --install
```

Checks 7 and 8 need the server on the new code as well, so they wait for the release either way.

## Before you start

Open Settings, About. After the release the Dashboard row should name 3.1.0 (for checks 7 and 8
the Server row too). If it still names 3.0.0 then, the update has not been installed yet:
Settings, App update, Check now. A build made from main before the release names 3.0.0, which is
right: the version is only bumped by the release.

## The checks

For each one: do the step, compare with what is expected. If one is not as described, its number
is enough to report it, and a screenshot helps.

1. **My tasks, the list** (#190). Open My tasks and look at the page.
   Expected: Filter, Sort and Group are on one row. Each group has a thin header. Today,
   Tomorrow and No due date have a + at the right end of their header while they are open, and no
   "Add task" row under the group. The other groups have no +. The dates' right edges line up, and
   nothing is cut off at either side of the screen.

2. **A group's +** (#190). Tap the + in Today's header.
   Expected: a name box opens at the end of Today, the keyboard comes up, and the whole box shows
   above it. Type a name and press Enter: the task is added and the box stays open for the next
   one. Tap elsewhere to close it.

3. **The new task sheet with the keyboard** (#196). Tap the round + button, then tap the name
   box.
   Expected: the sheet rests on the keyboard with no gap under it and nothing of it hidden. The
   tab bar is out of the way while the keyboard is up and comes back when it is put away.

4. **The subtask box** (#203). Open any task and tap Add subtask.
   Expected: the "Write a subtask name" box shows whole above the keyboard, bottom edge included.

5. **The status bar** (#204, #205). Tap Theme at the top right (the moon or the sun) and pick
   Dark, then Light.
   Expected: nothing new. In both, the top bar's colour runs up behind the clock, and the clock
   and the icons are easy to read. These two changes are for older phones and should leave this
   one as it was.

6. **Undo on a repeating task** (#186). Complete a task that repeats. To make one: add a task due
   today, open its due date, and set Repeats to Daily.
   Expected: the toast says "Completed" with the task's name and when the next one is due. Tap
   Undo: the task is open again, and there is one of it in the list, not two.

7. **The device clock** (#199). Open Settings, About.
   Expected: a Device clock row that says "Matches the server's clock". If it says "Not measured
   yet", leave Settings and open it again after a few seconds.

8. **Edits made offline** (#195). Turn on airplane mode. Rename one task, then complete another.
   Turn airplane mode off.
   Expected: the banner says "Offline." while the phone is cut off. Back on the network it says
   "Back online." with 2 offline changes sent, and both changes are there.

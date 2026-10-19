# Moving tasks from Asana

How the owner's open Asana tasks, with their repeat schedules, were brought into Polaris on 2026-10-18, and how to do it again. Polaris has no Asana importer: this was a one-off run through the existing REST API, and this page is the recipe.

## Why the CSV export is not enough

Asana's CSV export (My tasks, then Export) carries the name, notes, due date, project, parent task, and completion date, but no repeat settings. Asana's public API does not document them either. Two more traps:

- **The export goes stale.** It is a snapshot. The first attempt used a file twelve days old, so tasks finished since then came across as open and newer tasks were missing.
- **Guessing from history is unreliable.** Asana makes a new copy of a repeating task each time one is completed, so the completed rows in the export show the pattern. Inferring the rule from the gaps between due dates got several wrong (every 2 days read as daily, first Friday of the month read as monthly, yearly tasks with no completed copy missed entirely).

Use the live data instead.

## Reading the live tasks

Signed in to Asana in the browser, the web app's own API answers from the page with the session, no token needed. It returns an undocumented `recurrence` field when asked for it:

```js
// In the console of an app.asana.com tab
const F = 'gid,name,due_on,due_at,notes,parent.gid,projects.name,num_subtasks,completed,recurrence';
await fetch(`/api/1.0/tasks?assignee=me&workspace=<workspace gid>&completed_since=now&limit=100&opt_fields=${F}`).then((r) => r.json());
```

- `completed_since=now` returns open tasks only. Follow `next_page` for more than 100.
- `/api/1.0/users/me?opt_fields=workspaces.name` lists the workspaces. Only `owenpkent` was imported.
- Subtasks not assigned to you are not in that list. Fetch `/api/1.0/tasks/<gid>/subtasks?opt_fields=...` for each task with `num_subtasks`, recursively, and keep the open ones.
- Notes that contain links with query strings may be withheld by the browser tool when copied out. Take those from the CSV export instead, matched by task ID (`gid` is the CSV's Task ID).

## Turning Asana repeats into RRULEs

`recurrence` is `{ type, data }`. Months are 0-based (January is 0) and weekdays are 0 for Sunday through 6 for Saturday. `original_due_date` can be ignored.

| Asana `recurrence` | Polaris `recurrence` |
|---|---|
| `never` | none |
| `weekly`, `days_of_week: [2], frequency: 1` | `FREQ=WEEKLY;BYDAY=TU` |
| `weekly`, `days_of_week: [1,2,3,4,5]` | `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR` |
| `monthly`, `date: 25, frequency: 1` | `FREQ=MONTHLY;BYMONTHDAY=25` |
| `monthly`, `date: 16, frequency: 3` | `FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=16` |
| `monthly`, `date: 1, frequency: 24` | `FREQ=MONTHLY;INTERVAL=24;BYMONTHDAY=1` |
| `monthly`, `days_of_week: [5], nth_weekday: 1` | `FREQ=MONTHLY;BYDAY=1FR` |
| `yearly`, `month: 9, date: 14` | `FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=14` |
| `periodically`, `days_after_completion: 2` | `FREQ=DAILY;INTERVAL=2;X-FROM=COMPLETION` |

Keep the task's current Asana due date even when it is not on the rule (a yearly task moved by hand, for example). Polaris computes the next due date from the rule after the current one, as Asana does.

Asana's "N days after completion" is `X-FROM=COMPLETION`: the next one is due N days after the day the task is finished, not after its due date. A task with two repeating copies in Asana (PPL Timesheets on the 1st and on the 16th) stays two tasks.

## Writing them into Polaris

Through the running daemon's REST API with the api token (`command-center/data/api-token` of the install the daemon runs from), so the dashboard sees each change at once:

1. **Create.** Create the Asana projects you want first with `POST /api/projects { name }` (only `Personal` had open tasks). Then `POST /api/tasks` for each task, parents before subtasks: `{ title, notes, dueAt, recurrence, projectId, parentId }`. These are the owner's own tasks, so there is no source type and nothing goes to the inbox. Keep a map from Asana gid to Polaris task id in a file, so a rerun skips what exists.
2. **Re-sync.** To bring Polaris in line with Asana again, match each live Asana task to a Polaris task by gid first, then by title and parent title. A repeating task gets a new gid each time a copy is completed, so the gid alone misses those. Then:
   - `PATCH /api/tasks/<id>` with the fields that differ (title, dueAt, recurrence, projectId, parentId).
   - Create the tasks that did not match.
   - Complete the imported tasks that are no longer open in Asana. Clear the repeat first (`PATCH { recurrence: null }`, then `PATCH { status: "done" }`), or completing it makes the next copy.
3. **Check.** Run the matching again as a dry run. It should find nothing to change, and the open count should equal Asana's.

Skip blank, untitled tasks, and the open subtasks whose parent was completed long ago. Asana hides those, and the export lists them as open.

Before writing, make sure a backup from before the import exists (`npm run cc -- backup check`). On 2026-10-18 that was the daily copy `polaris-2026-10-18.db` in `CC_BACKUP_DIR`.

## Doing it as a feature

A built-in Asana importer would be a new external source with its own credential, which needs the owner's decision first (see "When to ask" in CLAUDE.md). The owner's own CSV, minus the repeat rules, already goes through `tasks import` (see "Importing tasks" in command-center/README.md).

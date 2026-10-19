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

1. **Create.** Create the Asana projects you want first with `POST /api/projects { name }` (only `Personal` had open tasks). Then `POST /api/tasks` for each task, parents before subtasks: `{ title, notes, dueAt, recurrence, projectId, parentId }`. A repeating task with subtasks needs one more field, `customFields`, or its subtasks are lost after the first completion (see "Repeating tasks with subtasks" below). These are the owner's own tasks, so there is no source type and nothing goes to the inbox. Keep a map from Asana gid to Polaris task id in a file, so a rerun skips what exists.
2. **Re-sync.** To bring Polaris in line with Asana again, first match each live Asana task to at most one Polaris task, and each Polaris task to at most one live task. Only the tasks in the gid map take part: a Polaris task the import did not create is never a candidate.
   - **By gid.** A live gid that is in the map matches the Polaris task it maps to.
   - **Then by title, for repeating tasks.** A repeating task gets a new gid each time a copy is completed, so the gid alone misses those. The candidates for a live task with an unknown gid are the mapped Polaris tasks with the same title whose own gid is no longer open in Asana and that nothing else has matched. The project, the parent (the Polaris id the map gives for the live task's parent gid, not the parent's title), and the recurrence rule can narrow the candidates.
   - **Exactly one candidate** is a match. Write the new gid against that Polaris id in the map.
   - **More than one candidate is ambiguous.** Do not pick one, by due date, list order, or anything else. If a narrowing field removes every candidate, that is ambiguous too, since the field may have changed in Asana. The two top-level PPL Timesheets series in Personal are this case whenever their rules do not tell them apart, and so are subtasks with the same title under same-titled parents in different projects. List each ambiguous live task with its candidates and stop. The owner writes the mapping (new gid to Polaris id) into the map file by hand, and the run starts again. No task is patched, created, or completed while any match is ambiguous.
   - **No candidate** means a new task.

   With every live task matched or known to be new:
   - `PATCH /api/tasks/<id>` with the fields that differ (title, dueAt, recurrence, projectId, parentId).
   - Create the tasks that did not match.
   - Complete the mapped tasks that are no longer open in Asana and that no live task matched. Clear the repeat first (`PATCH { recurrence: null }`, then `PATCH { status: "done" }`), or completing it makes the next copy.
3. **Check.**
   - Run the matching again as a dry run. It should find nothing to change, and the open count should equal Asana's.
   - Before trusting the matching, run it as a dry run on a fixture with two same-title series: a map holding two top-level `PPL Timesheets` tasks in Personal (gids A and B, Polaris ids P1 and P2, one on the 1st and one on the 16th), and a live list where both have rolled over to new gids C and D with their next due dates. It must match C to P1 and D to P2, plan only a dueAt `PATCH` on each to its own series' next date, keep both rules, and create and complete nothing. Then give both series the same rule in the fixture: it must report C and D as ambiguous and plan no writes at all. With an explicit mapping for each added, it must again keep two distinct Polaris ids and both schedules.
   - Complete a representative repeating parent on scratch data and look at the next occurrence's subtasks, as described under "Repeating tasks with subtasks". An open count that matches says nothing about what happens at the first completion.

Skip blank, untitled tasks, and the open subtasks whose parent was completed long ago. Asana hides those, and the export lists them as open.

Before writing, make sure a backup from before the import exists (`npm run cc -- backup check`). On 2026-10-18 that was the daily copy `polaris-2026-10-18.db` in `CC_BACKUP_DIR`.

## Repeating tasks with subtasks

Asana copies a repeating task's subtasks into each new copy. Polaris does not, by default: when a repeating task is completed, the next occurrence comes back alone, and the old subtasks stay with the completed one. The one exception is the custom field `checklistRepeatItems` (the flag a task started from a checklist carries). When it is `true`, completing the task gives the next occurrence a fresh open subtask for each of the current subtasks, in order, leaving out dropped ones.

- **Simple checklist items** (a list of steps, each just a title): create the parent with `customFields: { "checklistRepeatItems": true }` in the `POST /api/tasks` body, or set it later with `PATCH /api/tasks/<id> { customFields: { "checklistRepeatItems": true } }`.
- **What the flag does not copy.** It copies only the titles of the parent's immediate subtasks. Nested subtasks, a subtask's notes, due dates, priority, recurrence, and any other subtask field are not copied. Where those matter, move the detail into the parent's notes (which every occurrence keeps), flatten nested subtasks into one level of titles, or leave the flag off and tell the owner which tasks will need their subtasks added by hand after each completion. Do not create a repeating task's subtasks without deciding which of these applies.

To check, use scratch data and never `command-center/data`. Make a copy of the database taken after the import (the next daily backup, through `npm run cc -- backup decrypt` if backups are encrypted), point `CC_DB` at that copy and `CC_BACKUP_DIR` and `CC_SECRETS_DIR` at scratch folders, then:

```sh
npm run cc -- done <parent id>      # prints the next occurrence's id
npm run cc -- show <next id>        # its subtasks should be the parent's, all open
```

Do this for one parent with the flag (its subtasks should be there) and, if any were left without it on purpose, one without (it should come back alone).

## Doing it as a feature

A built-in Asana importer would be a new external source with its own credential, which needs the owner's decision first (see "When to ask" in CLAUDE.md). The owner's own CSV, minus the repeat rules, already goes through `tasks import` (see "Importing tasks" in command-center/README.md).

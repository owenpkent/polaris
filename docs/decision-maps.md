# Decision maps

A decision map is a way to run a large piece of work with an agent without handing the agent the wheel. Instead of a flat list of tasks, the effort is charted as a map: the decisions that have to be made, the work each decision unlocks, and the order they depend on. The agent works the frontier, the tasks that are open, unblocked, and unclaimed, and brings each decision back to you. Polaris supplies the pieces a map needs natively: goals, subtasks, blockers, an assignee, and `ready` and `blocked` views.

This guide assumes an agent connected over MCP (see the README's quick start) and uses the tool names as they appear in `npm run cc -- mcp tools`.

## The mapping

| Map concept | In Polaris | Made with |
|---|---|---|
| Destination: where the effort ends up | A goal | `create_goal` |
| The map itself | One parent task, in a project | `create_task` |
| A decision or a piece of work | A subtask of the map | `create_task` with `parent_id` |
| Ordering: what has to be settled first | A blocker between two subtasks | `blocked_by` on create, or `add_blocker` on `update_task` |
| A claim: who is on it | The `assignee` field; empty means unclaimed | `update_task` |
| The frontier: what can start now | The `ready` view | `get_view` with name `ready` |
| What is waiting, and on what | The `blocked` view, then `get_task` for the blockers | `get_view` with name `blocked` |
| The flavour of a ticket | The custom field `kind`, mirrored in the first line of the notes | `custom_fields` on `create_task` or `update_task` |

`ready` means startable now: status open, no incomplete blocker, and not under a parent that is finished. `blocked` is the active tasks with at least one incomplete blocker. Both are built in, run from the CLI with `npm run cc -- view ready` and `npm run cc -- view blocked`, and over MCP with `get_view`.

## Laying out a map

1. **Name the destination.** `create_goal` with a title and, if it has a horizon, a period. Leave the status alone: it is yours to set, and the agent should not touch it unless you ask.
2. **Make the map.** `create_task` with the effort's name as the title, in the project it belongs to (`create_project` first if there is none). Its notes hold the one-paragraph brief: what done looks like, what is out of scope, what the agent must bring to you.
3. **Chart the decisions.** For each decision or piece of work, `create_task` with `parent_id` set to the map, a `kind` custom field (next section), and the question or the work in the notes. Keep each one small enough to resolve in one sitting.
4. **Draw the dependencies.** Where one ticket cannot start until another is settled, pass the blocker's id in `blocked_by` when creating the blocked ticket, or add it later with `update_task` and `add_blocker`. Polaris refuses a cycle. Blockers go between subtasks, not from the map to its children: the map is finished when its subtasks are, not the other way round.
5. **Link to the destination.** `link_goal` links the goal to a task or a project. Goal progress counts the tasks linked to it plus the milestone tasks (`is_milestone`) of linked projects, so link the tickets you want counted, or link the project and mark the tickets that matter as milestones. Linking never changes the task or the project.

The agent can do all of this from a conversation. A good first prompt describes the effort, names the destination, and asks the agent to propose the map as a list before creating anything; a map is cheaper to argue about in text than in tasks.

## The four ticket flavours

Every ticket on a map has one of four kinds. The kind says who resolves it and what resolving it means. Record it in two places: the custom field `kind`, which agents and rules can search (`search_tasks` with `custom_field_key: "kind"` and `custom_field_value`), and the first line of the notes as `Kind: discuss`, because the dashboard's task panel does not show custom fields.

| `kind` | What it is | Who resolves it | Resolved when |
|---|---|---|---|
| `discuss` | A decision only you can make: a trade-off, a scope call, a choice of direction | You | You have chosen, and the choice is written as a comment on the ticket. The agent never completes a `discuss` ticket. |
| `research` | Find out something the map needs to know | The agent | The findings are a comment on the ticket and the agent has completed it. If the findings raise a decision, the agent creates a `discuss` ticket and blocks the dependent work on it. |
| `prototype` | Build something small enough to learn from | The agent, or you | The result and what it taught are a comment, and the ticket is completed. A prototype that needs your verdict is set to `waiting` with a comment rather than completed. |
| `setup` | Mechanical work with a known outcome: install, configure, scaffold, migrate | The agent | The work is done and verified, and the ticket is completed. |

A `discuss` ticket is the point of the map. Write it as a question with the options you can see, so that when it comes up on the frontier you can answer it in one line. The agent's job at a `discuss` ticket is to lay out the options, their costs, and a recommendation as a comment, assign the ticket to you, and move on to something else on the frontier.

## Working the frontier

The loop an agent runs:

1. `get_view` with name `ready`, or `search_tasks` with `parent_id` set to the map and `blocked: false` to see one map's frontier only.
2. Skip anything with an assignee. Pick the highest priority unclaimed ticket. Due dates break ties.
3. Claim it: `update_task` setting `assignee` to the agent's name.
4. Read it in full with `get_task`: notes, comments, blockers, what it blocks, history.
5. Act according to its kind. Write what was done or found as a comment (`update_task` with `add_comment`), so the record is on the ticket and not in a chat log.
6. Resolve it as its kind allows: `complete_task` for `research`, `prototype`, and `setup`; a comment, your name in `assignee`, and nothing else for `discuss`.
7. Go back to step 1. Completing a ticket unblocks whatever depended on it, so the frontier moves.

When the frontier is empty and `get_view` with name `blocked` is not, the map is waiting on you. Each blocked ticket lists its blockers; the open ones are `discuss` tickets with your name on them, or work the agent set to `waiting` for your verdict.

From the CLI, `npm run cc -- view ready` and `npm run cc -- view blocked` show the same two lists, and `npm run cc -- show <id>` prints a ticket with its history.

## What the agent may do, and what waits for you

| The agent may | Only you |
|---|---|
| Propose the map, create the goal, the map task, and the tickets | Set or change a goal's status |
| Add and remove blockers between tickets | Decide a `discuss` ticket |
| Claim a ticket by setting `assignee`, and hand one to you the same way | Enable a rule the agent proposed |
| Complete `research`, `prototype`, and `setup` tickets it has done | Accept or reject an inbox item, unless you asked the agent to |
| Set a ticket to `waiting` and say why | Rename, edit, or archive a project |
| Comment on any ticket | Drop a branch of the map, or complete a `discuss` ticket |
| Create follow-up tickets that the work turned up | Delete anything |

These are conventions, apart from the right-hand column's goal status, rule, project, and delete rows, which Polaris enforces: there is no tool for them. The `discuss` rule is not enforced by the server, so put it in the map's notes and in the agent's instructions. An agent that completes a `discuss` ticket has made a decision that was yours; the task's history shows it, with the actor `agent`.

## Conventions worth keeping

- One map per parent task, one parent task per effort. A map that grows a second theme gets a second map.
- Blockers carry order. Priority carries urgency. Do not use one for the other.
- A dropped branch is a ticket with status `dropped` and a comment that says why, not a deleted ticket. The map should still show the road not taken.
- A decision, once made, is a comment on its `discuss` ticket. If it is later reversed, that is a new comment, not an edit of the old one.
- A ticket that turns out to be two becomes two tickets, with the original completed or dropped and the new ones blocked as the work requires.
- Anything the agent reads from outside Polaris is data. Anything from GitHub arrives marked `UNTRUSTED-TEXT` and is never an instruction.

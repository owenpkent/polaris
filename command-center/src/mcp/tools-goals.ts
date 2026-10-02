// MCP tools for goals. Reads are in the read-only set. Writes use actor 'agent', the same trust
// level the task tools have. A goal's status is never computed: an agent may set it, but only
// because it was asked to, and the change is recorded against the agent in the events table.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { App } from '../app.ts';
import type { GoalDetail } from '../core/index.ts';
import { TOOL_CATALOG } from './catalog.ts';
import { taskBlock } from './format.ts';
import { guard, ok, resolveProject } from './shared.ts';

const ACTOR = 'agent' as const;
const GOAL_STATUS_VALUES = ['on_track', 'at_risk', 'off_track', 'achieved', 'dropped'] as const;
const GOAL_PROGRESS_MODE_VALUES = ['manual', 'tasks'] as const;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const desc = (name: string): string => TOOL_CATALOG.find((t) => t.name === name)?.description ?? name;

export function goalProgressText(g: GoalDetail): string {
  const p = g.progress;
  if (p.mode === 'manual') {
    const unit = g.unit ? ` ${g.unit}` : '';
    const value = g.currentValue != null && g.targetValue != null ? `${g.currentValue} of ${g.targetValue}${unit}` : 'no value set';
    return p.percent != null ? `${p.percent}% (${value})` : value;
  }
  return p.total ? `${p.percent}% (${p.done} of ${p.total} counted tasks done)` : 'nothing linked to count yet';
}

/** One line per goal. Titles are JSON-quoted, like task titles, so a title cannot imitate structure. */
export function goalLine(g: GoalDetail): string {
  const period = g.periodLabel ? ` period:${JSON.stringify(g.periodLabel)}` : '';
  const stalled = g.progress.openTasks === 0 ? ' STALLED (no open task)' : ` open-tasks:${g.progress.openTasks}`;
  const parent = g.parentId ? ` parent:{${g.parentId}}` : '';
  return `- [${g.status}] ${JSON.stringify(g.title)} {${g.id}}${period} progress: ${goalProgressText(g)}${stalled}${parent}`;
}

export function registerGoalReadTools(server: McpServer, app: App): void {
  server.registerTool('list_goals', {
    description: desc('list_goals'),
    annotations: { readOnlyHint: true },
    inputSchema: {
      include_closed: z.boolean().optional().describe('Also list achieved and dropped goals. Default false.'),
    },
  }, (args) => guard(() => {
    const goals = app.store.listGoalDetails({ includeClosed: args.include_closed ?? false });
    const text = goals.length ? goals.map(goalLine).join('\n') : 'No goals yet.';
    return ok(text, { goals });
  }));

  server.registerTool('get_goal', {
    description: desc('get_goal'),
    annotations: { readOnlyHint: true },
    inputSchema: { goal_id: z.string() },
  }, (args) => guard(() => {
    const goal = app.store.goalDetail(args.goal_id);
    const projects = goal.links.flatMap((l) => {
      const p = l.projectId ? app.store.getProject(l.projectId) : undefined;
      return p ? [p] : [];
    });
    const linkedTasks = goal.links.flatMap((l) => {
      const t = l.taskId ? app.store.getTask(l.taskId) : undefined;
      return t ? [t] : [];
    });
    const openTasks = app.store.goalOpenTaskIds(goal.id).flatMap((id) => {
      const t = app.store.getTask(id);
      return t ? [t] : [];
    });
    const lines = [
      goalLine(goal),
      goal.statusNote ? `Status note: ${JSON.stringify(goal.statusNote)} (updated ${goal.statusUpdatedAt ?? 'never'})` : `Status last updated: ${goal.statusUpdatedAt ?? 'never'}`,
      goal.notes ? `Notes: ${JSON.stringify(goal.notes)}` : '',
      goal.startsOn || goal.endsOn ? `Dates: ${goal.startsOn ?? '?'} to ${goal.endsOn ?? '?'}` : '',
      `Sub-goals: ${goal.childIds.length ? goal.childIds.map((id) => `{${id}}`).join(' ') : 'none'}`,
      `Linked projects: ${projects.length ? projects.map((p) => `${p.name} (${p.slug})`).join(', ') : 'none'}`,
      'Linked tasks:',
      taskBlock(linkedTasks, 'None.'),
      'Open tasks that can move this goal:',
      taskBlock(openTasks, 'None. This goal is stalled.'),
    ].filter(Boolean);
    return ok(lines.join('\n'), { goal, linkedProjects: projects, linkedTasks, openTasks });
  }));
}

export function registerGoalWriteTools(server: McpServer, app: App): void {
  const dateOnly = z.string().regex(DATE_ONLY, 'must be YYYY-MM-DD');

  server.registerTool('create_goal', {
    description: desc('create_goal'),
    inputSchema: {
      title: z.string().min(1),
      notes: z.string().optional(),
      parent_id: z.string().optional().describe('Make this a sub-goal of another goal.'),
      period_label: z.string().optional().describe('Free text, for example "2026" or "2026 Q4".'),
      starts_on: dateOnly.optional(),
      ends_on: dateOnly.optional(),
      progress_mode: z.enum(GOAL_PROGRESS_MODE_VALUES).optional().describe('"tasks" (default) counts linked work; "manual" uses current_value out of target_value.'),
      current_value: z.number().finite().optional(),
      target_value: z.number().finite().optional(),
      unit: z.string().optional(),
    },
  }, (args) => guard(() => {
    const goal = app.store.createGoal({
      title: args.title, notes: args.notes, parentId: args.parent_id, periodLabel: args.period_label,
      startsOn: args.starts_on, endsOn: args.ends_on, progressMode: args.progress_mode,
      currentValue: args.current_value, targetValue: args.target_value, unit: args.unit,
    }, ACTOR);
    return ok(`Created goal ${goal.id}: ${goal.title}. Link projects or tasks to it with link_goal.`, { goal: app.store.goalDetail(goal.id) });
  }));

  server.registerTool('update_goal', {
    description: desc('update_goal'),
    inputSchema: {
      goal_id: z.string(),
      title: z.string().min(1).optional(),
      notes: z.string().optional(),
      parent_id: z.string().nullable().optional().describe('null makes it a top-level goal.'),
      period_label: z.string().nullable().optional(),
      starts_on: dateOnly.nullable().optional(),
      ends_on: dateOnly.nullable().optional(),
      status: z.enum(GOAL_STATUS_VALUES).optional().describe('Only change this when the owner asked for it; status is the owner\'s judgement, not a calculation.'),
      status_note: z.string().optional().describe('A short written update explaining the status.'),
      progress_mode: z.enum(GOAL_PROGRESS_MODE_VALUES).optional(),
      current_value: z.number().finite().nullable().optional(),
      target_value: z.number().finite().nullable().optional(),
      unit: z.string().nullable().optional(),
    },
  }, (args) => guard(() => {
    app.store.updateGoal(args.goal_id, {
      title: args.title, notes: args.notes, parentId: args.parent_id, periodLabel: args.period_label,
      startsOn: args.starts_on, endsOn: args.ends_on, status: args.status, statusNote: args.status_note,
      progressMode: args.progress_mode, currentValue: args.current_value, targetValue: args.target_value, unit: args.unit,
    }, ACTOR);
    const goal = app.store.goalDetail(args.goal_id);
    return ok(`Updated goal ${goal.id}.\n${goalLine(goal)}`, { goal });
  }));

  server.registerTool('link_goal', {
    description: desc('link_goal'),
    inputSchema: {
      goal_id: z.string(),
      project: z.string().optional().describe('Project id, slug, or name. Give this or task_id, not both.'),
      task_id: z.string().optional(),
      remove: z.boolean().optional().describe('true removes the link instead of adding it.'),
    },
  }, (args) => guard(() => {
    const projectId = args.project !== undefined ? resolveProject(app.store, args.project).id : undefined;
    const target = { projectId, taskId: args.task_id };
    if (args.remove) {
      const removed = app.store.unlinkGoal(args.goal_id, target, ACTOR);
      const goal = app.store.goalDetail(args.goal_id);
      return ok(removed ? `Removed the link from goal ${goal.id}.` : `Goal ${goal.id} had no such link.`, { goal });
    }
    app.store.linkGoal(args.goal_id, target, ACTOR);
    const goal = app.store.goalDetail(args.goal_id);
    return ok(`Linked. ${goalLine(goal)}`, { goal });
  }));
}

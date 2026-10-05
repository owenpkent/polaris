// Mutating tools: registered only when the server is not in --readonly mode.
// Every mutation here uses actor 'agent' so the audit trail (events table) shows it
// was an assistant action, distinct from the owner acting through the CLI or dashboard.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { App } from '../app.ts';
import { runRules, validateRuleDefinition } from '../automation/index.ts';
import { postBlock, taskRef } from './format.ts';
import { CONFIDENCES, NotFoundError, POST_TYPES, ValidationError, type ActorInput, type Json, type NewTask, type TaskPatch } from '../core/index.ts';
import { TOOL_CATALOG } from './catalog.ts';
import { PRIORITY_VALUES, TASK_STATUS_VALUES, guard, ok, err, resolveProject, resolveProjectByGithubRepo, resolveSectionWrite } from './shared.ts';
import { resolveThread } from './tools-read.ts';

const desc = (name: string): string => TOOL_CATALOG.find((t) => t.name === name)?.description ?? name;
const customFieldSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

export function registerWriteTools(server: McpServer, app: App, actor: ActorInput): void {
  server.registerTool('create_task', {
    description: desc('create_task'),
    inputSchema: {
      title: z.string(),
      notes: z.string().optional(),
      project: z.string().optional().describe('Project id, slug, or name.'),
      github_repo: z.string().optional().describe(
        'owner/repo or a github.com URL, used to find the project when `project` is not given (for example the ' +
        'output of `git remote get-url origin`, to add a to-do from inside a repo). Matches the project tracked for that repo.',
      ),
      section: z.string().optional().describe('Section id or name within the project; created if the name does not exist yet.'),
      parent_id: z.string().optional(),
      status: z.enum(TASK_STATUS_VALUES).optional().describe('Defaults to open.'),
      priority: z.enum(PRIORITY_VALUES).optional(),
      due_at: z.string().optional(),
      start_at: z.string().optional(),
      estimate_minutes: z.number().int().nonnegative().optional(),
      recurrence: z.string().optional().describe('RRULE string, e.g. FREQ=WEEKLY;BYDAY=MO.'),
      assignee: z.string().max(200).optional().describe('Who the task is handed to, by name. Leave out for unclaimed (the owner).'),
      is_milestone: z.boolean().optional(),
      custom_fields: customFieldSchema.optional(),
      blocked_by: z.array(z.string()).optional().describe('Task ids that must complete before this one.'),
    },
  }, (args) => guard(() => {
    const input: NewTask = { title: args.title };
    if (args.notes !== undefined) input.notes = args.notes;
    let projectId: string | undefined;
    if (args.project) {
      projectId = resolveProject(app.store, args.project).id;
      input.projectId = projectId;
    } else if (args.github_repo) {
      const project = resolveProjectByGithubRepo(app.store, args.github_repo);
      if (!project) {
        return err(`No project is tracked for github_repo "${args.github_repo}". The owner tracks a repo from the dashboard's GitHub page; list_projects shows what exists.`);
      }
      projectId = project.id;
      input.projectId = projectId;
    }
    if (args.section) {
      if (!projectId) throw new ValidationError('section requires project');
      input.sectionId = resolveSectionWrite(app.store, projectId, args.section).id;
    }
    if (args.parent_id !== undefined) input.parentId = args.parent_id;
    if (args.status !== undefined) input.status = args.status;
    if (args.priority !== undefined) input.priority = args.priority;
    if (args.due_at !== undefined) input.dueAt = args.due_at;
    if (args.start_at !== undefined) input.startAt = args.start_at;
    if (args.estimate_minutes !== undefined) input.estimateMinutes = args.estimate_minutes;
    if (args.recurrence !== undefined) input.recurrence = args.recurrence;
    if (args.assignee !== undefined) input.assignee = args.assignee;
    if (args.is_milestone !== undefined) input.isMilestone = args.is_milestone;
    if (args.custom_fields !== undefined) input.customFields = args.custom_fields;
    const task = app.store.db.transaction(() => {
      const created = app.store.createTask(input, actor);
      for (const blockerId of args.blocked_by ?? []) app.store.addDependency(blockerId, created.id, actor);
      return created;
    });
    return ok(`Created task ${taskRef(task)}`, { task });
  }));

  server.registerTool('update_task', {
    description: desc('update_task'),
    inputSchema: {
      task_id: z.string(),
      title: z.string().optional(),
      notes: z.string().optional(),
      project: z.string().nullable().optional().describe('Project id, slug, or name; null clears it.'),
      section: z.string().nullable().optional().describe('Section id or name within the (possibly new) project; created if the name does not exist yet; null clears it.'),
      parent_id: z.string().nullable().optional(),
      status: z.enum(TASK_STATUS_VALUES).optional(),
      priority: z.enum(PRIORITY_VALUES).optional(),
      due_at: z.string().nullable().optional(),
      start_at: z.string().nullable().optional(),
      estimate_minutes: z.number().int().nonnegative().nullable().optional(),
      recurrence: z.string().nullable().optional(),
      assignee: z.string().max(200).nullable().optional().describe('Who the task is handed to, by name; null clears it, making the task unclaimed.'),
      is_milestone: z.boolean().optional(),
      custom_fields: customFieldSchema.optional().describe('Merged into existing custom fields; a null value deletes that key.'),
      add_comment: z.string().optional(),
      add_blocker: z.string().optional().describe('Id of a task that must complete before this one.'),
      remove_blocker: z.string().optional(),
    },
  }, (args) => guard(() => {
    const existing = app.store.requireTask(args.task_id);
    const patch: TaskPatch & { status?: (typeof TASK_STATUS_VALUES)[number] } = {};
    if (args.title !== undefined) patch.title = args.title;
    if (args.notes !== undefined) patch.notes = args.notes;
    let targetProjectId = existing.projectId;
    if (args.project !== undefined) {
      targetProjectId = args.project === null ? null : resolveProject(app.store, args.project).id;
      patch.projectId = targetProjectId;
    }
    if (args.section !== undefined) {
      if (args.section === null) {
        patch.sectionId = null;
      } else {
        if (!targetProjectId) throw new ValidationError('cannot set section without a project');
        patch.sectionId = resolveSectionWrite(app.store, targetProjectId, args.section).id;
      }
    }
    if (args.parent_id !== undefined) patch.parentId = args.parent_id;
    if (args.status !== undefined) patch.status = args.status;
    if (args.priority !== undefined) patch.priority = args.priority;
    if (args.due_at !== undefined) patch.dueAt = args.due_at;
    if (args.start_at !== undefined) patch.startAt = args.start_at;
    if (args.estimate_minutes !== undefined) patch.estimateMinutes = args.estimate_minutes;
    if (args.recurrence !== undefined) patch.recurrence = args.recurrence;
    if (args.assignee !== undefined) patch.assignee = args.assignee;
    if (args.is_milestone !== undefined) patch.isMilestone = args.is_milestone;
    if (args.custom_fields !== undefined) patch.customFields = args.custom_fields;
    const task = app.store.db.transaction(() => {
      app.store.updateTask(args.task_id, patch, actor);
      if (args.add_comment) app.store.addComment(args.task_id, args.add_comment, 'agent', actor);
      if (args.add_blocker) app.store.addDependency(args.add_blocker, args.task_id, actor);
      if (args.remove_blocker) app.store.removeDependency(args.remove_blocker, args.task_id, actor);
      return app.store.requireTask(args.task_id);
    });
    return ok(`Updated task ${taskRef(task)}`, { task });
  }));

  server.registerTool('complete_task', {
    description: desc('complete_task'),
    inputSchema: { task_id: z.string() },
  }, (args) => guard(() => {
    const { task, next } = app.store.completeTask(args.task_id, actor);
    const text = next
      ? `Completed ${taskRef(task)}. Next occurrence created: ${next.id} due ${next.dueAt ?? 'unscheduled'}.`
      : `Completed ${taskRef(task)}.`;
    return ok(text, { task, next });
  }));

  server.registerTool('move_task', {
    description: desc('move_task'),
    inputSchema: {
      task_id: z.string(),
      project: z.string().nullable().optional().describe('Project id, slug, or name; null clears it (and its section).'),
      section: z.string().nullable().optional().describe('Section id or name within the resulting project; created if the name does not exist yet; null clears it.'),
      parent_id: z.string().nullable().optional(),
      position: z.number().int().optional(),
    },
  }, (args) => guard(() => {
    const existing = app.store.requireTask(args.task_id);
    const to: { projectId?: string | null; sectionId?: string | null; parentId?: string | null; position?: number } = {};
    let targetProjectId = existing.projectId;
    if (args.project !== undefined) {
      targetProjectId = args.project === null ? null : resolveProject(app.store, args.project).id;
      to.projectId = targetProjectId;
    }
    if (args.section !== undefined) {
      if (args.section === null) {
        to.sectionId = null;
      } else {
        if (!targetProjectId) throw new ValidationError('cannot move into a section without a project');
        to.sectionId = resolveSectionWrite(app.store, targetProjectId, args.section).id;
      }
    }
    if (args.parent_id !== undefined) to.parentId = args.parent_id;
    if (args.position !== undefined) to.position = args.position;
    const task = app.store.moveTask(args.task_id, to, actor);
    return ok(`Moved task ${taskRef(task)}`, { task });
  }));

  server.registerTool('accept_inbox_item', {
    description: desc('accept_inbox_item'),
    inputSchema: {
      task_id: z.string(),
      project: z.string().optional().describe('Project id, slug, or name.'),
      section: z.string().optional().describe('Section id or name within the project; created if the name does not exist yet.'),
      due_at: z.string().optional(),
      priority: z.enum(PRIORITY_VALUES).optional(),
      title: z.string().optional(),
    },
  }, (args) => guard(() => {
    const patch: TaskPatch = {};
    let projectId: string | undefined;
    if (args.project) {
      projectId = resolveProject(app.store, args.project).id;
      patch.projectId = projectId;
    }
    if (args.section) {
      const pid = projectId ?? app.store.requireTask(args.task_id).projectId;
      if (!pid) throw new ValidationError('section requires a project');
      patch.sectionId = resolveSectionWrite(app.store, pid, args.section).id;
    }
    if (args.due_at !== undefined) patch.dueAt = args.due_at;
    if (args.priority !== undefined) patch.priority = args.priority;
    if (args.title !== undefined) patch.title = args.title;
    const task = app.store.acceptInboxItem(args.task_id, patch, actor);
    return ok(`Accepted ${taskRef(task)}`, { task });
  }));

  server.registerTool('reject_inbox_item', {
    description: desc('reject_inbox_item'),
    inputSchema: { task_id: z.string(), reason: z.string().optional() },
  }, (args) => guard(() => {
    const task = app.store.rejectInboxItem(args.task_id, args.reason ?? null, actor);
    return ok(`Rejected ${taskRef(task)}`, { task });
  }));

  server.registerTool('create_rule', {
    description: desc('create_rule'),
    inputSchema: {
      name: z.string(),
      definition: z.record(z.string(), z.unknown()).describe('Rule definition. trigger: {type:"event",kinds:[EventKind]} or {type:"schedule",condition:"due_within_days"|"overdue"|"stale_days",days?}. conditions: [{field:"status"|"priority"|"projectId"|"sourceType"|"title"|"dueAt"|"customField:<key>",op:"eq"|"ne"|"in"|"contains"|"matches"|"exists"|"before"|"after",value?}] (all must match; a "matches" value is a regular expression in the everyday syntax, up to 200 characters, without backreferences or lookaround). actions: set_field, move, add_comment, create_followup, notify. Rules can organize tasks but never complete, drop, accept, or touch external systems.'),
    },
  }, (args) => guard(() => {
    const validation = validateRuleDefinition(args.definition);
    if (!validation.ok) return err(`Rule definition invalid: ${validation.errors.join('; ')}`);
    const rule = app.store.saveRule({ name: args.name, enabled: false, definition: (validation.normalized ?? args.definition) as Record<string, Json> });
    return ok(
      `Saved rule ${rule.id} ("${rule.name}") disabled. The owner must run \`npm run cc -- rules enable ${rule.id}\` to activate it; agents may propose rules but not enable them.`,
      { rule },
    );
  }));

  server.registerTool('run_rule', {
    description: desc('run_rule'),
    inputSchema: {
      rule_id: z.string(),
      dry_run: z.boolean().optional().describe('Defaults to true. A real (non-dry) run requires the rule to be enabled.'),
    },
  }, (args) => guard(() => {
    const rule = app.store.getRule(args.rule_id);
    if (!rule) throw new NotFoundError(`rule not found: ${args.rule_id}`);
    const dryRun = args.dry_run ?? true;
    if (!dryRun && !rule.enabled) throw new ValidationError(`rule ${rule.id} is disabled; only enabled rules may run non-dry`);
    const report = runRules(app.store, { today: app.today(), ruleId: rule.id, dryRun });
    const text = `${report.dryRun ? '[dry run] ' : ''}${report.fired.length} action(s) fired, ${report.errors.length} error(s).`;
    return ok(text, { report });
  }));

  // Threads (docs/agent-threads-proposal.md). An agent may open a thread and post to it; it may
  // not set a status, pin, or close: those are the owner's, and stage 1 has no setter at all.
  server.registerTool('create_thread', {
    description: desc('create_thread'),
    inputSchema: {
      task_id: z.string(),
      title: z.string().max(200).optional().describe('Defaults to the task title.'),
    },
  }, (args) => guard(() => {
    const task = app.store.requireTask(args.task_id);
    const existing = app.store.getThreadForTask(task.id);
    const thread = app.store.createThread(task.id, args.title ?? null, actor);
    const verb = existing ? 'Thread already open' : 'Opened thread';
    return ok(`${verb} ${JSON.stringify(thread.title)} {${thread.id}} on task ${taskRef(task)}. Read it with get_thread and add posts with post_to_thread.`, { thread, created: !existing });
  }));

  server.registerTool('post_to_thread', {
    description: desc('post_to_thread'),
    inputSchema: {
      thread_id: z.string().optional(),
      task_id: z.string().optional().describe('The task the thread hangs off, when thread_id is not known.'),
      type: z.enum(POST_TYPES),
      body: z.string().min(1).max(20000).describe('One idea. Short. Say what you tried and what happened, failures included.'),
      confidence: z.enum(CONFIDENCES).optional(),
      refs: z.array(z.string()).max(50).optional().describe('Ids of posts in this thread that this one answers or builds on.'),
      parent_post_id: z.string().optional().describe('The post this one replies to.'),
    },
  }, (args) => guard(() => {
    const thread = resolveThread(app.store, args);
    const post = app.store.addPost(thread.id, {
      type: args.type, body: args.body, confidence: args.confidence ?? null, refs: args.refs ?? [], parentPostId: args.parent_post_id ?? null,
    }, 'agent', actor);
    return ok(`Posted to thread {${thread.id}}:\n${postBlock(post)}`, { post });
  }));
}

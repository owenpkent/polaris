// REST route registrations for the dashboard API. Every handler here uses actor 'human' for
// mutations (MCP mutations go through createMcpServer with actor 'agent' instead). See
// src/http/README.md for the endpoint table this file implements.
import { jobWarnings } from './warnings.ts';
import type { App } from '../app.ts';
import {
  NotFoundError, POST_STATUSES, POST_TYPES, TASK_STATUSES, ValidationError, applyOnlineOnce, applyOutbox, DEFAULT_AGENT_NAME_KEY, defaultAgentName, normalizeAgentName, restoreFromHistory, restorePatch,
  type Json, type MoveTarget, type OutboxOp, type PostStatus, type PostType, type Priority, type SourceType, type Store, type Task, type TaskFilter, type TaskPatch, type TaskStatus,
} from '../core/index.ts';
import { buildDigest, builtinViews, runRules, runView, validateRuleDefinition } from '../automation/index.ts';
import { ORDER_BY_VALUES, PRIORITY_VALUES, SOURCE_TYPE_VALUES, TASK_STATUS_VALUES, resolveProject, resolveSectionWrite } from '../mcp/shared.ts';
import { HttpError, sendJson, sendNoContent } from './errors.ts';
import { registerBackupRoutes } from './backup-routes.ts';
import { registerGithubRoutes } from './github-routes.ts';
import { registerIdentityRoute } from './identity.ts';
import { isTailscaleOwner } from './tailscale.ts';
import { registerUpdateRoutes } from './update-routes.ts';
import { readUpdateStatus } from '../update/status.ts';
import { VERSION } from './version.ts';
import {
  agentSettingsBodySchema, commentBodySchema, dependencyBodySchema, goalCreateBodySchema, goalLinkBodySchema, goalPatchBodySchema,
  goalVisionBodySchema, inboxAcceptBodySchema, inboxRejectBodySchema,
  moveTaskBodySchema, newTaskBodySchema, outboxBodySchema, parseBody, postBodySchema, projectCreateBodySchema, projectPatchBodySchema,
  ruleCreateBodySchema, rulePatchBodySchema,
  postStatusBodySchema, restoreBodySchema, ruleRunBodySchema, taskPatchBodySchema, threadCreateBodySchema, threadForkBodySchema, threadPatchBodySchema,
} from './schemas.ts';
import type { Router } from './router.ts';
import type { HttpServerOptions } from './types.ts';


/** kv key for the free-text vision statement shown above the goals. */
const GOAL_VISION_KEY = 'goals.vision';

const NON_DROPPED_STATUSES = TASK_STATUSES.filter((s) => s !== 'dropped');

function projectCounts(store: Store, projectId: string, today: string): { open: number; inbox: number; overdue: number; done: number } {
  const ACTIVE: TaskStatus[] = ['open', 'in_progress', 'waiting'];
  return {
    open: store.countTasks({ projectId, status: ACTIVE }),
    inbox: store.countTasks({ projectId, status: ['inbox'] }),
    overdue: store.countTasks({ projectId, status: ACTIVE, dueBefore: today }),
    done: store.countTasks({ projectId, status: ['done'] }),
  };
}

function isOneOf<T extends string>(value: string, allowed: readonly T[]): value is T {
  return (allowed as readonly string[]).includes(value);
}

function parseCsvEnum<T extends string>(raw: string | null, allowed: readonly T[], param: string): T[] | undefined {
  if (!raw) return undefined;
  const values = raw.split(',').map((s) => s.trim()).filter(Boolean);
  for (const v of values) {
    if (!isOneOf(v, allowed)) throw new ValidationError(`invalid ${param} value: ${v}`);
  }
  return values as T[];
}

function parseIntParam(raw: string | null, param: string, min?: number): number | undefined {
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new ValidationError(`invalid ${param}: ${raw}`);
  if (min !== undefined && n < min) throw new ValidationError(`invalid ${param}: ${raw} (minimum ${min})`);
  return n;
}

function parseBoolParam(raw: string | null, param: string): boolean | undefined {
  if (raw === null || raw === '') return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ValidationError(`invalid ${param}: expected true or false`);
}

function taskFilterFromQuery(store: Store, url: URL): TaskFilter {
  const q = url.searchParams;
  const filter: TaskFilter = {};

  const text = q.get('text');
  if (text) filter.text = text;

  const status = parseCsvEnum(q.get('status'), TASK_STATUS_VALUES, 'status');
  if (status) filter.status = status as TaskStatus[];

  const priority = parseCsvEnum(q.get('priority'), PRIORITY_VALUES, 'priority');
  if (priority) filter.priority = priority as Priority[];

  const sourceType = parseCsvEnum(q.get('sourceType'), SOURCE_TYPE_VALUES, 'sourceType');
  if (sourceType) filter.sourceType = sourceType as SourceType[];

  const projectRef = q.get('project');
  if (projectRef) filter.projectId = resolveProject(store, projectRef).id;

  const sectionId = q.get('section');
  if (sectionId) filter.sectionId = sectionId;

  const dueBefore = q.get('dueBefore');
  if (dueBefore) filter.dueBefore = dueBefore;

  const dueAfter = q.get('dueAfter');
  if (dueAfter) filter.dueAfter = dueAfter;

  const blocked = parseBoolParam(q.get('blocked'), 'blocked');
  if (blocked !== undefined) filter.blocked = blocked;

  const assignee = q.get('assignee');
  if (assignee) filter.assignee = assignee;

  const unassigned = parseBoolParam(q.get('unassigned'), 'unassigned');
  if (unassigned !== undefined) filter.unassigned = unassigned;

  const orderByRaw = q.get('orderBy');
  if (orderByRaw) {
    if (!isOneOf(orderByRaw, ORDER_BY_VALUES)) throw new ValidationError(`invalid orderBy value: ${orderByRaw}`);
    filter.orderBy = orderByRaw;
  }

  const limit = parseIntParam(q.get('limit'), 'limit');
  if (limit !== undefined) filter.limit = limit;

  const offset = parseIntParam(q.get('offset'), 'offset');
  if (offset !== undefined) filter.offset = offset;

  return filter;
}

/** Turns a move body (project ref, section name or id) into the ids Store.moveTask takes. */
function resolveMoveBody(store: Store, existing: Task, body: { project?: string | null; section?: string | null; parentId?: string | null; position?: number }): MoveTarget {
  const to: MoveTarget = {};
  let targetProjectId = existing.projectId;
  if (body.project !== undefined) {
    targetProjectId = body.project === null ? null : resolveProject(store, body.project).id;
    to.projectId = targetProjectId;
  }
  if (body.section !== undefined) {
    if (body.section === null) {
      to.sectionId = null;
    } else {
      if (!targetProjectId) throw new ValidationError('cannot move into a section without a project');
      to.sectionId = resolveSectionWrite(store, targetProjectId, body.section).id;
    }
  }
  if (body.parentId !== undefined) to.parentId = body.parentId;
  if (body.position !== undefined) to.position = body.position;
  return to;
}

export function registerRestRoutes(router: Router, app: App, opts: HttpServerOptions): void {
  const store = app.store;

  // ------------------------------------------------------------------ health

  router.add('GET', '/api/health', (ctx) => {
    const today = app.today();
    const views = builtinViews(today);
    const overdueFilter = views.find((v) => v.name === 'overdue')!.filter;
    const todayFilter = views.find((v) => v.name === 'today')!.filter;
    sendJson(ctx.res, 200, {
      ok: true,
      version: VERSION,
      today,
      counts: {
        inbox: store.countTasks({ status: ['inbox'] }),
        overdue: store.countTasks(overdueFilter),
        today: store.countTasks(todayFilter),
      },
      // How this request got in, so the dashboard can say "through Tailscale" in Settings. The
      // same predicate server.ts used, so the login is only named back to a request that sent it.
      auth: isTailscaleOwner(ctx.req, opts.tailscaleLogin) ? { via: 'tailscale', login: opts.tailscaleLogin } : { via: 'token' },
    });
  });

  // ---------------------------------------------------------------- settings

  router.add('GET', '/api/settings/agent', (ctx) => {
    sendJson(ctx.res, 200, { defaultAgentName: defaultAgentName(store) });
  });

  router.add('PATCH', '/api/settings/agent', (ctx) => {
    const body = parseBody(agentSettingsBodySchema, ctx.body);
    const normalized = normalizeAgentName(body.defaultAgentName);
    if (!normalized) {
      throw new ValidationError('defaultAgentName must be 1 to 40 characters, start with a letter or digit, and use only letters, digits, spaces, "-", "_", or "."');
    }
    store.setKv(DEFAULT_AGENT_NAME_KEY, normalized);
    sendJson(ctx.res, 200, { defaultAgentName: normalized });
  });

  // ---------------------------------------------------------------- projects

  router.add('GET', '/api/projects', (ctx) => {
    const today = app.today();
    const includeArchived = ['1', 'true'].includes(ctx.url.searchParams.get('includeArchived') ?? '');
    const projects = store.listProjects({ includeArchived }).map((p) => ({ ...p, counts: projectCounts(store, p.id, today) }));
    sendJson(ctx.res, 200, { projects });
  });

  // The owner's own writes, so the actor is 'human'. There is no DELETE: a project is archived, so its tasks keep a home.
  router.add('POST', '/api/projects', (ctx) => {
    const body = parseBody(projectCreateBodySchema, ctx.body);
    sendJson(ctx.res, 201, { project: store.createProject(body, 'human') });
  });

  router.add('PATCH', '/api/projects/:ref', (ctx) => {
    const patch = parseBody(projectPatchBodySchema, ctx.body);
    const project = store.findProject(ctx.params.ref);
    if (!project) throw new NotFoundError(`project not found: ${ctx.params.ref}`);
    sendJson(ctx.res, 200, { project: store.updateProject(project.id, patch, 'human') });
  });

  router.add('GET', '/api/projects/:ref', (ctx) => {
    const project = store.findProject(ctx.params.ref);
    if (!project) throw new NotFoundError(`project not found: ${ctx.params.ref}`);
    const sections = store.listSections(project.id);
    const tasks = store.searchTasks({ projectId: project.id, status: NON_DROPPED_STATUSES, orderBy: 'position', limit: 1000 });
    sendJson(ctx.res, 200, { project, sections, tasks });
  });

  // ------------------------------------------------------------------- tasks

  router.add('GET', '/api/tasks', (ctx) => {
    const filter = taskFilterFromQuery(store, ctx.url);
    const tasks = store.searchTasks(filter);
    const total = store.countTasks(filter);
    sendJson(ctx.res, 200, { tasks, total });
  });

  router.add('GET', '/api/tasks/:id', (ctx) => {
    const task = store.requireTask(ctx.params.id);
    sendJson(ctx.res, 200, {
      task,
      subtasks: store.subtasks(task.id),
      blockers: store.blockersOf(task.id),
      blocking: store.blocking(task.id),
      comments: store.listComments(task.id),
      links: store.listLinks(task.id),
      // The goals this task is linked to itself, for the task panel's Goals row. A goal reached
      // only through the task's project is not listed: that link is changed on the Goals view.
      goals: store.goalsLinkedToTask(task.id).map((g) => ({ id: g.id, title: g.title, status: g.status })),
      // restore is what Put back would set for that entry (core/restore.ts), or null when the
      // entry has nothing to put back. The task panel shows it before anyone clicks.
      history: store.taskHistory(task.id).map((e) => ({ ...e, restore: restorePatch(e) })),
    });
  });

  router.add('POST', '/api/tasks', (ctx) => {
    const body = parseBody(newTaskBodySchema, ctx.body);
    let projectId = body.projectId ?? null;
    if (body.project) projectId = resolveProject(store, body.project).id;
    let sectionId = body.sectionId ?? null;
    if (body.section) {
      if (!projectId) throw new ValidationError('section requires a project');
      sectionId = resolveSectionWrite(store, projectId, body.section).id;
    }
    if (body.id !== undefined && !body.opId && store.getTask(body.id)) throw new ValidationError(`task ${body.id} already exists`);
    // One transaction: a bad blocker id must not leave a committed task behind for a request
    // the caller was told had failed, or a retry doubles up.
    const task = applyOnlineOnce(store, body, () => store.db.transaction(() => {
      const created = store.createTask({
        title: body.title,
        notes: body.notes,
        projectId,
        sectionId,
        parentId: body.parentId,
        status: body.status,
        priority: body.priority,
        dueAt: body.dueAt,
        startAt: body.startAt,
        estimateMinutes: body.estimateMinutes,
        recurrence: body.recurrence,
        assignee: body.assignee,
        isMilestone: body.isMilestone,
        customFields: body.customFields,
        sourceType: body.sourceType,
        sourceId: body.sourceId,
        sourceUrl: body.sourceUrl,
        confidence: body.confidence,
      }, 'human', body.id !== undefined ? { id: body.id } : {});
      for (const blockerId of body.blockedBy ?? []) store.addDependency(blockerId, created.id, 'human');
      return { task: created, value: created };
    }), (taskId) => store.requireTask(taskId));
    sendJson(ctx.res, 201, { task });
  });

  router.add('PATCH', '/api/tasks/:id', (ctx) => {
    const patch = parseBody(taskPatchBodySchema, ctx.body);
    const task = store.updateTask(ctx.params.id, patch, 'human');
    sendJson(ctx.res, 200, { task });
  });

  // Online only: it is not an offline op kind, since it reads the server's copy of the history.
  router.add('POST', '/api/tasks/:id/restore', (ctx) => {
    const { eventId } = parseBody(restoreBodySchema, ctx.body);
    const task = restoreFromHistory(store, ctx.params.id, eventId, 'human');
    sendJson(ctx.res, 200, { task });
  });

  router.add('POST', '/api/tasks/:id/complete', (ctx) => {
    const { task, next } = store.completeTask(ctx.params.id, 'human');
    sendJson(ctx.res, 200, { task, next });
  });

  router.add('POST', '/api/tasks/:id/reopen', (ctx) => {
    const task = store.reopenTask(ctx.params.id, 'human');
    sendJson(ctx.res, 200, { task });
  });

  router.add('POST', '/api/tasks/:id/move', (ctx) => {
    const body = parseBody(moveTaskBodySchema, ctx.body);
    const to = resolveMoveBody(store, store.requireTask(ctx.params.id), body);
    const task = store.moveTask(ctx.params.id, to, 'human');
    sendJson(ctx.res, 200, { task });
  });

  router.add('POST', '/api/tasks/:id/comments', (ctx) => {
    const body = parseBody(commentBodySchema, ctx.body);
    const task = store.requireTask(ctx.params.id);
    const comment = applyOnlineOnce(store, body, () => ({ task, value: store.addComment(task.id, body.body, 'human') }), () => {
      // The same comment sent twice: answer with the one already saved.
      const saved = store.listComments(task.id).filter((c) => c.body === body.body).at(-1);
      if (!saved) throw new NotFoundError(`comment for op ${body.opId} not found`);
      return saved;
    });
    sendJson(ctx.res, 201, { comment });
  });

  router.add('POST', '/api/tasks/:id/dependencies', (ctx) => {
    const body = parseBody(dependencyBodySchema, ctx.body);
    store.addDependency(body.blockerId, ctx.params.id, 'human');
    sendJson(ctx.res, 201, {});
  });

  router.add('DELETE', '/api/tasks/:id/dependencies/:blockerId', (ctx) => {
    store.removeDependency(ctx.params.blockerId, ctx.params.id, 'human');
    sendNoContent(ctx.res, 204);
  });

  // ------------------------------------------------------------------ outbox

  // Offline edits from a dashboard, replayed in order. Safe to retry: an op id is applied once.
  router.add('POST', '/api/outbox', (ctx) => {
    const body = parseBody(outboxBodySchema, ctx.body);
    const ops: OutboxOp[] = body.ops.map((op) => ({ ...op, deviceId: body.deviceId, body: op.body as Record<string, Json> }));
    const results = applyOutbox(store, ops, {
      resolveMove: (task, moveBody) => resolveMoveBody(store, task, parseBody(moveTaskBodySchema, moveBody)),
    });
    sendJson(ctx.res, 200, { results, headId: store.lastEventId() });
  });

  // ------------------------------------------------------------------- inbox

  router.add('GET', '/api/inbox', (ctx) => {
    const tasks = store.searchTasks({ status: ['inbox'], orderBy: 'created', limit: 1000 });
    sendJson(ctx.res, 200, { tasks });
  });

  router.add('POST', '/api/inbox/:id/accept', (ctx) => {
    const body = parseBody(inboxAcceptBodySchema, ctx.body);
    const patch: TaskPatch = {};
    let projectId: string | undefined;
    if (body.project) {
      projectId = resolveProject(store, body.project).id;
      patch.projectId = projectId;
    }
    if (body.section) {
      const pid = projectId ?? store.requireTask(ctx.params.id).projectId;
      if (!pid) throw new ValidationError('section requires a project');
      patch.sectionId = resolveSectionWrite(store, pid, body.section).id;
    }
    if (body.dueAt !== undefined) patch.dueAt = body.dueAt;
    if (body.priority !== undefined) patch.priority = body.priority;
    if (body.title !== undefined) patch.title = body.title;
    const task = store.acceptInboxItem(ctx.params.id, patch, 'human');
    sendJson(ctx.res, 200, { task });
  });

  router.add('POST', '/api/inbox/:id/reject', (ctx) => {
    const body = parseBody(inboxRejectBodySchema, ctx.body);
    const task = store.rejectInboxItem(ctx.params.id, body.reason ?? null, 'human');
    sendJson(ctx.res, 200, { task });
  });

  // ------------------------------------------------------------------- views

  router.add('GET', '/api/views', (ctx) => {
    const today = app.today();
    const builtins = builtinViews(today).map((v) => ({ name: v.name, description: v.description, builtin: true }));
    const saved = store.listViews().map((v) => ({ name: v.name, description: `Saved view "${v.name}".`, builtin: false }));
    sendJson(ctx.res, 200, { views: [...builtins, ...saved] });
  });

  router.add('GET', '/api/views/:name', (ctx) => {
    // The blocked view also answers `blockers`: each task's incomplete blockers, keyed by task id.
    const { view, tasks, blockers } = runView(store, ctx.params.name, app.today());
    sendJson(ctx.res, 200, blockers ? { view, tasks, blockers } : { view, tasks });
  });

  // ------------------------------------------------------------------- rules

  router.add('GET', '/api/rules', (ctx) => {
    sendJson(ctx.res, 200, { rules: store.listRules() });
  });

  router.add('POST', '/api/rules', (ctx) => {
    const body = parseBody(ruleCreateBodySchema, ctx.body);
    const validation = validateRuleDefinition(body.definition);
    if (!validation.ok) throw new ValidationError(`invalid rule definition: ${validation.errors.join('; ')}`);
    // Unlike the MCP create_rule tool (which always saves disabled for an agent), a human acting
    // through the dashboard may enable a rule immediately by passing enabled: true.
    // validation.ok is true here, so normalized is always set (see automation/rules.ts).
    const rule = store.saveRule({ name: body.name, enabled: body.enabled === true, definition: validation.normalized! });
    sendJson(ctx.res, 201, { rule });
  });

  router.add('PATCH', '/api/rules/:id', (ctx) => {
    const body = parseBody(rulePatchBodySchema, ctx.body);
    const existing = store.getRule(ctx.params.id);
    if (!existing) throw new NotFoundError(`rule not found: ${ctx.params.id}`);
    let definition = existing.definition;
    if (body.definition !== undefined) {
      const validation = validateRuleDefinition(body.definition);
      if (!validation.ok) throw new ValidationError(`invalid rule definition: ${validation.errors.join('; ')}`);
      definition = validation.normalized!;
    }
    const rule = store.saveRule({
      id: existing.id,
      name: body.name ?? existing.name,
      enabled: body.enabled ?? existing.enabled,
      definition,
    });
    sendJson(ctx.res, 200, { rule });
  });

  router.add('DELETE', '/api/rules/:id', (ctx) => {
    const existing = store.getRule(ctx.params.id);
    if (!existing) throw new NotFoundError(`rule not found: ${ctx.params.id}`);
    store.deleteRule(existing.id);
    sendNoContent(ctx.res, 204);
  });

  router.add('POST', '/api/rules/run', (ctx) => {
    const body = parseBody(ruleRunBodySchema, ctx.body);
    const report = runRules(store, { today: app.today(), ruleId: body.ruleId, dryRun: body.dryRun ?? true });
    sendJson(ctx.res, 200, report);
  });

  // ------------------------------------------------------------------ digest

  router.add('GET', '/api/digest', (ctx) => {
    sendJson(ctx.res, 200, buildDigest(store, { today: app.today() }));
  });

  // ------------------------------------------------------------------ events

  router.add('GET', '/api/events', (ctx) => {
    const after = parseIntParam(ctx.url.searchParams.get('after'), 'after', 0) ?? 0;
    const limit = parseIntParam(ctx.url.searchParams.get('limit'), 'limit', 1) ?? 500;
    const events = store.eventsSince(after, limit);
    const lastId = events.length ? events[events.length - 1].id : after;
    // headId is the newest event overall, so a client that only needs change
    // detection can start from it without paging through the whole history.
    sendJson(ctx.res, 200, { events, lastId, headId: store.lastEventId() });
  });

  // -------------------------------------------------------------------- sync

  router.add('GET', '/api/sync', (ctx) => {
    const jobs = opts.getJobStatus ? opts.getJobStatus() : {};
    // The update status file is the updater's to write and the daemon's to read (update/status.ts).
    sendJson(ctx.res, 200, { jobs, warnings: jobWarnings(jobs, new Date(), readUpdateStatus(app.config.dbPath)) });
  });

  router.add('POST', '/api/sync/:job', (ctx) => {
    const jobName = ctx.params.job;
    // Own properties only: a plain object also answers to constructor, toString and __proto__,
    // which would reach job() as if they were registered jobs.
    const job = Object.hasOwn(opts.jobs ?? {}, jobName) ? opts.jobs?.[jobName] : undefined;
    if (!job) throw new NotFoundError(`job not found: ${jobName}`);
    const status = opts.getJobStatus?.();
    if (status?.[jobName]?.running) throw new HttpError(409, 'Conflict', `job '${jobName}' is already running`);
    job().catch((e: unknown) => {
      process.stderr.write(`[http] sync job '${jobName}' failed: ${e instanceof Error ? e.message : String(e)}\n`);
    });
    sendJson(ctx.res, 202, { started: true });
  });

  // ------------------------------------------------------------------- goals
  // The owner's own writes, so the actor is 'human'. A goal's status is only ever what the owner sets here.

  // One goal with everything the Goals view shows beside it: the linked projects and tasks by
  // name, and the open tasks that can move it (the "what moves this goal" list).
  const goalPayload = (goalId: string) => {
    const goal = store.goalDetail(goalId);
    const linkedProjects = goal.links.flatMap((l) => {
      const p = l.projectId ? store.getProject(l.projectId) : undefined;
      return p ? [{ id: p.id, slug: p.slug, name: p.name }] : [];
    });
    const linkedTasks = goal.links.flatMap((l) => {
      const t = l.taskId ? store.getTask(l.taskId) : undefined;
      return t ? [t] : [];
    });
    const openTasks = store.goalOpenTaskIds(goalId).flatMap((id) => {
      const t = store.getTask(id);
      return t ? [t] : [];
    });
    return { goal, linkedProjects, linkedTasks, openTasks };
  };

  router.add('GET', '/api/goals', (ctx) => {
    const includeClosed = ['1', 'true'].includes(ctx.url.searchParams.get('includeClosed') ?? '');
    sendJson(ctx.res, 200, {
      // linkedWork lets My tasks filter by goal from this one request: a task moves the goal when
      // it is one of these tasks or is in one of these projects, sub-goals' links included, the
      // same meaning as the goal's own open work. The dashboard decides membership from its
      // current task list rather than from a list of task ids, so a project change queued
      // offline is reflected at once.
      goals: store.listGoalDetails({ includeClosed }).map((g) => ({ ...g, linkedWork: store.goalLinkedWork(g.id) })),
      // Every goal, open or closed. The dashboard only offers its one-time import when this is 0.
      total: store.listGoals({ includeClosed: true }).length,
      vision: store.getKv<string>(GOAL_VISION_KEY) ?? '',
    });
  });

  router.add('POST', '/api/goals', (ctx) => {
    const body = parseBody(goalCreateBodySchema, ctx.body);
    const goal = store.createGoal(body, 'human');
    sendJson(ctx.res, 201, goalPayload(goal.id));
  });

  // PATCH, not PUT: the CORS preflight allows GET, POST, PATCH, and DELETE only.
  router.add('PATCH', '/api/goal-vision', (ctx) => {
    const { text } = parseBody(goalVisionBodySchema, ctx.body);
    store.setKv(GOAL_VISION_KEY, text);
    sendJson(ctx.res, 200, { vision: text });
  });

  router.add('GET', '/api/goals/:id', (ctx) => {
    sendJson(ctx.res, 200, goalPayload(ctx.params.id));
  });

  router.add('PATCH', '/api/goals/:id', (ctx) => {
    const patch = parseBody(goalPatchBodySchema, ctx.body);
    store.updateGoal(ctx.params.id, patch, 'human');
    sendJson(ctx.res, 200, goalPayload(ctx.params.id));
  });

  router.add('DELETE', '/api/goals/:id', (ctx) => {
    if (!store.deleteGoal(ctx.params.id, 'human')) throw new NotFoundError(`goal not found: ${ctx.params.id}`);
    sendNoContent(ctx.res, 204);
  });

  router.add('POST', '/api/goals/:id/links', (ctx) => {
    const body = parseBody(goalLinkBodySchema, ctx.body);
    store.linkGoal(ctx.params.id, { projectId: body.project, taskId: body.taskId }, 'human');
    sendJson(ctx.res, 201, goalPayload(ctx.params.id));
  });

  // Unlinking is a POST with the same body as linking, because a DELETE body is not reliably
  // delivered by every client or proxy.
  router.add('POST', '/api/goals/:id/unlink', (ctx) => {
    const body = parseBody(goalLinkBodySchema, ctx.body);
    const goal = store.getGoal(ctx.params.id);
    if (!goal) throw new NotFoundError(`goal not found: ${ctx.params.id}`);
    store.unlinkGoal(goal.id, { projectId: body.project, taskId: body.taskId }, 'human');
    sendJson(ctx.res, 200, goalPayload(goal.id));
  });

  // ----------------------------------------------------------------- threads
  // docs/agent-threads-proposal.md, stage 1. The owner's posts are actor 'human'. Posting is a
  // live write: it carries no op id and has no outbox kind, so an offline post is refused by the
  // dashboard rather than queued.

  const threadPayload = (threadId: string, url: URL) => {
    const thread = store.requireThread(threadId);
    const after = url.searchParams.get('after');
    const limit = parseIntParam(url.searchParams.get('limit'), 'limit', 1);
    // The pinned post travels by id: it may be older than the window of posts returned.
    const pinned = thread.pinnedPostId ? store.getPost(thread.pinnedPostId) : null;
    return { thread, posts: store.listPosts(thread.id, { after: after || null, limit }), total: store.countPosts(thread.id), pinned };
  };

  router.add('GET', '/api/threads', (ctx) => {
    const status = ctx.url.searchParams.get('status');
    if (status !== null && status !== 'open' && status !== 'closed') throw new ValidationError(`invalid status: ${status}`);
    sendJson(ctx.res, 200, { threads: store.listThreads(status ? { status } : {}) });
  });

  router.add('GET', '/api/tasks/:id/thread', (ctx) => {
    const task = store.requireTask(ctx.params.id);
    const thread = store.getThreadForTask(task.id);
    if (!thread) throw new NotFoundError(`task ${task.id} has no thread`);
    sendJson(ctx.res, 200, threadPayload(thread.id, ctx.url));
  });

  router.add('POST', '/api/tasks/:id/thread', (ctx) => {
    const body = parseBody(threadCreateBodySchema, ctx.body);
    const task = store.requireTask(ctx.params.id);
    const existing = store.getThreadForTask(task.id);
    const thread = store.createThread(task.id, body.title ?? null, 'human');
    sendJson(ctx.res, existing ? 200 : 201, { thread });
  });

  router.add('GET', '/api/threads/:id', (ctx) => {
    sendJson(ctx.res, 200, threadPayload(ctx.params.id, ctx.url));
  });

  router.add('POST', '/api/threads/:id/posts', (ctx) => {
    const body = parseBody(postBodySchema, ctx.body);
    const post = store.addPost(ctx.params.id, body, 'human', 'human');
    sendJson(ctx.res, 201, { post });
  });

  // Stage 2: what the owner decides. Each is a live click as the human; none queues offline.
  router.add('PATCH', '/api/threads/:id', (ctx) => {
    const body = parseBody(threadPatchBodySchema, ctx.body);
    let thread = store.requireThread(ctx.params.id);
    const { pinnedPostId, ...options } = body;
    if (pinnedPostId !== undefined) thread = store.pinPost(thread.id, pinnedPostId, 'human');
    if (Object.keys(options).length) thread = store.setThreadOptions(thread.id, options, 'human');
    sendJson(ctx.res, 200, { thread });
  });

  router.add('POST', '/api/threads/:id/close', (ctx) => {
    sendJson(ctx.res, 200, { thread: store.closeThread(ctx.params.id, 'human') });
  });

  router.add('POST', '/api/threads/:id/reopen', (ctx) => {
    sendJson(ctx.res, 200, { thread: store.reopenThread(ctx.params.id, 'human') });
  });

  router.add('POST', '/api/threads/:id/fork', (ctx) => {
    const body = parseBody(threadForkBodySchema, ctx.body);
    sendJson(ctx.res, 201, store.forkThread(ctx.params.id, body, 'human'));
  });

  router.add('PATCH', '/api/posts/:id', (ctx) => {
    const body = parseBody(postStatusBodySchema, ctx.body);
    sendJson(ctx.res, 200, { post: store.setPostStatus(ctx.params.id, body.status, 'human') });
  });

  router.add('GET', '/api/posts', (ctx) => {
    const q = ctx.url.searchParams;
    const type = q.get('type');
    const status = q.get('status');
    if (type !== null && !(POST_TYPES as readonly string[]).includes(type)) throw new ValidationError(`invalid type: ${type}`);
    if (status !== null && !(POST_STATUSES as readonly string[]).includes(status)) throw new ValidationError(`invalid status: ${status}`);
    sendJson(ctx.res, 200, {
      posts: store.searchPosts({
        type: (type as PostType | null) ?? undefined, status: (status as PostStatus | null) ?? undefined,
        query: q.get('q') ?? undefined, taskId: q.get('taskId') ?? undefined, limit: parseIntParam(q.get('limit'), 'limit', 1),
      }),
    });
  });

  // ------------------------------------------------------------------ github

  registerGithubRoutes(router, app, opts);
  registerBackupRoutes(router, app, opts);
  registerUpdateRoutes(router, app);
  registerIdentityRoute(router, opts.tokens.api);
}

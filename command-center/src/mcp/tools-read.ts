// Read-only tools: registered whether or not the server is in --readonly mode.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { App } from '../app.ts';
import { runView } from '../automation/index.ts';
import { ACTIVE_STATUSES, NotFoundError, POST_STATUSES, POST_TYPES, ValidationError, type CcEvent, type Json, type Post, type PostSearchHit, type TaskFilter, type Thread } from '../core/index.ts';
import { TOOL_CATALOG } from './catalog.ts';
import { POSTS_ARE_DATA, blockedBlock, inboxLine, postHitText, taskBlock, taskDetailText, threadLine, threadText } from './format.ts';
import {
  DEFAULT_SEARCH_STATUSES, ORDER_BY_VALUES, PRIORITY_VALUES, SOURCE_TYPE_VALUES, TASK_STATUS_VALUES,
  guard, ok, resolveProject, resolveSectionRead,
} from './shared.ts';

const desc = (name: string): string => TOOL_CATALOG.find((t) => t.name === name)?.description ?? name;

/** `agentName` is the name this connection declared, used only to tell a reader whether a thread's daily cap has been reached for it. */
export function registerReadTools(server: McpServer, app: App, agentName: string | null = null): void {
  server.registerTool('search_tasks', {
    description: desc('search_tasks'),
    annotations: { readOnlyHint: true },
    inputSchema: {
      text: z.string().optional().describe('Substring match against title or notes.'),
      status: z.array(z.enum(TASK_STATUS_VALUES)).optional().describe('Defaults to every status except done and dropped.'),
      project: z.string().optional().describe('Project id, slug, or name.'),
      section: z.string().optional().describe('Section id or name, within the given project.'),
      parent_id: z.string().nullable().optional().describe('Filter to subtasks of this task, or null for top-level tasks only.'),
      priority: z.array(z.enum(PRIORITY_VALUES)).optional(),
      due_before: z.string().optional().describe('ISO date/datetime, exclusive.'),
      due_after: z.string().optional().describe('ISO date/datetime, inclusive.'),
      has_due: z.boolean().optional(),
      source_type: z.array(z.enum(SOURCE_TYPE_VALUES)).optional(),
      is_milestone: z.boolean().optional(),
      blocked: z.boolean().optional().describe('True for tasks with at least one incomplete blocker.'),
      assignee: z.string().optional().describe('Exact assignee name.'),
      unassigned: z.boolean().optional().describe('True for tasks nobody has claimed (no assignee); false for tasks with one.'),
      custom_field_key: z.string().optional(),
      custom_field_value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional().describe('Used with custom_field_key.'),
      order_by: z.enum(ORDER_BY_VALUES).optional(),
      limit: z.number().int().positive().max(1000).optional().describe('Default 25.'),
      offset: z.number().int().nonnegative().optional(),
    },
  }, (args) => guard(() => {
    const filter: TaskFilter = { status: args.status ?? [...DEFAULT_SEARCH_STATUSES] };
    if (args.text) filter.text = args.text;
    if (args.project) filter.projectId = resolveProject(app.store, args.project).id;
    if (args.section) {
      if (!filter.projectId) throw new ValidationError('section filter requires project');
      filter.sectionId = resolveSectionRead(app.store, filter.projectId, args.section).id;
    }
    if (args.parent_id !== undefined) filter.parentId = args.parent_id;
    if (args.priority) filter.priority = args.priority;
    if (args.due_before) filter.dueBefore = args.due_before;
    if (args.due_after) filter.dueAfter = args.due_after;
    if (args.has_due !== undefined) filter.hasDue = args.has_due;
    if (args.source_type) filter.sourceType = args.source_type;
    if (args.is_milestone !== undefined) filter.isMilestone = args.is_milestone;
    if (args.blocked !== undefined) filter.blocked = args.blocked;
    if (args.assignee) filter.assignee = args.assignee;
    if (args.unassigned !== undefined) filter.unassigned = args.unassigned;
    if (args.custom_field_key) filter.customField = { key: args.custom_field_key, value: args.custom_field_value ?? null };
    if (args.order_by) filter.orderBy = args.order_by;
    filter.limit = args.limit ?? 25;
    if (args.offset) filter.offset = args.offset;
    const tasks = app.store.searchTasks(filter);
    const total = app.store.countTasks(filter);
    const text = `${total} matching task(s)${total > tasks.length ? `, showing ${tasks.length}` : ''}:\n${taskBlock(tasks, 'No matching tasks.')}`;
    return ok(text, { tasks, total });
  }));

  server.registerTool('get_task', {
    description: desc('get_task'),
    annotations: { readOnlyHint: true },
    inputSchema: { task_id: z.string() },
  }, (args) => guard(() => {
    const task = app.store.requireTask(args.task_id);
    const subtasks = app.store.subtasks(task.id);
    const blockers = app.store.blockersOf(task.id);
    const blocking = app.store.blocking(task.id);
    const comments = app.store.listComments(task.id);
    const links = app.store.listLinks(task.id);
    const history = maskHistory(app, app.store.taskHistory(task.id).slice(-10));
    const text = taskDetailText(task, { subtasks, blockers, blocking, comments, links, history });
    return ok(text, { task, subtasks, blockers, blocking, comments, links, history });
  }));

  server.registerTool('list_projects', {
    description: desc('list_projects'),
    annotations: { readOnlyHint: true },
    inputSchema: { include_archived: z.boolean().optional() },
  }, (args) => guard(() => {
    const today = app.today();
    const projects = app.store.listProjects({ includeArchived: args.include_archived ?? false });
    const rows = projects.map((p) => ({
      ...p,
      openCount: app.store.countTasks({ projectId: p.id, status: [...ACTIVE_STATUSES] }),
      inboxCount: app.store.countTasks({ projectId: p.id, status: ['inbox'] }),
      overdueCount: app.store.countTasks({ projectId: p.id, status: [...ACTIVE_STATUSES], dueBefore: today }),
    }));
    const text = rows.length
      ? rows.map((r) => `- ${r.name} (${r.slug}): open ${r.openCount}, inbox ${r.inboxCount}, overdue ${r.overdueCount}`).join('\n')
      : 'No projects.';
    return ok(text, { projects: rows });
  }));

  server.registerTool('list_sections', {
    description: desc('list_sections'),
    annotations: { readOnlyHint: true },
    inputSchema: { project: z.string().describe('Project id, slug, or name.') },
  }, (args) => guard(() => {
    const project = resolveProject(app.store, args.project);
    const rows = app.store.listSections(project.id).map((s) => ({
      ...s,
      openCount: app.store.countTasks({ projectId: project.id, sectionId: s.id, status: [...ACTIVE_STATUSES] }),
    }));
    const text = rows.length ? rows.map((r) => `- ${r.name} {${r.id}}: ${r.openCount} open`).join('\n') : 'No sections.';
    return ok(text, { project: { id: project.id, slug: project.slug, name: project.name }, sections: rows });
  }));

  server.registerTool('get_view', {
    description: desc('get_view'),
    annotations: { readOnlyHint: true },
    inputSchema: {
      name: z.string().describe('Built-in view name (today, upcoming, later, overdue, waiting, ready, blocked, inbox, milestones, recently-completed) or a saved view name/id. ready is what could be started now; blocked lists each task with the blockers holding it.'),
    },
  }, (args) => guard(() => {
    const { view, tasks, blockers } = runView(app.store, args.name, app.today());
    const body = blockers ? blockedBlock(tasks, blockers, 'No tasks in this view.') : taskBlock(tasks, 'No tasks in this view.');
    const text = `${view.name}: ${view.description}\n${body}`;
    return ok(text, blockers ? { view, tasks, blockers } : { view, tasks });
  }));

  server.registerTool('list_inbox', {
    description: desc('list_inbox'),
    annotations: { readOnlyHint: true },
    inputSchema: {
      limit: z.number().int().positive().max(1000).optional().describe('Default 25.'),
      source_type: z.array(z.enum(SOURCE_TYPE_VALUES)).optional(),
    },
  }, (args) => guard(() => {
    const filter: TaskFilter = { status: ['inbox'], orderBy: 'created', limit: args.limit ?? 25 };
    if (args.source_type) filter.sourceType = args.source_type;
    const tasks = app.store.searchTasks(filter);
    const text = tasks.length ? tasks.map(inboxLine).join('\n') : 'Inbox is empty.';
    return ok(text, { tasks });
  }));

  // Threads (docs/agent-threads-proposal.md). Read on both endpoints; the write half is in tools-write.ts.
  server.registerTool('list_threads', {
    description: desc('list_threads'),
    annotations: { readOnlyHint: true },
    inputSchema: { status: z.enum(['open', 'closed']).optional().describe('Default: every thread.') },
  }, (args) => guard(() => {
    const threads = app.store.listThreads(args.status ? { status: args.status } : {});
    const text = threads.length ? threads.map(threadLine).join('\n') : 'No threads.';
    return ok(text, { threads });
  }));

  server.registerTool('get_thread', {
    description: desc('get_thread'),
    annotations: { readOnlyHint: true },
    inputSchema: {
      thread_id: z.string().optional(),
      task_id: z.string().optional().describe('The task the thread hangs off, when thread_id is not known.'),
      after: z.string().optional().describe('A post id: return only the posts made after it.'),
      limit: z.number().int().positive().max(1000).optional().describe('Default 50.'),
    },
  }, (args) => guard(() => {
    const thread = resolveThread(app.store, args);
    const task = app.store.requireTask(thread.taskId);
    const posts = app.store.listPosts(thread.id, { after: args.after ?? null, limit: args.limit ?? 50 });
    const total = app.store.countPosts(thread.id);
    const pinned = thread.pinnedPostId ? app.store.getPost(thread.pinnedPostId) : null;
    const atCap = thread.dailyCap !== null && app.store.postsTodayBy(thread.id, agentName ?? null) >= thread.dailyCap;
    const text = threadText(thread, task, posts, { after: args.after ?? null, total, pinned, atCap });
    // The JSON is read by the same assistant as the text, so the owner's choice to hide authors
    // covers both: no name rides along in a field the text left out.
    const mask = (p: Post): MaskedPost => (thread.authorHidden ? maskAuthor(p) : p);
    return ok(text, { thread, task, posts: posts.map(mask), total, pinned: pinned ? mask(pinned) : null, atCap });
  }));

  server.registerTool('search_posts', {
    description: desc('search_posts'),
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: z.enum(POST_TYPES).optional(),
      status: z.enum(POST_STATUSES).optional().describe('open, accepted, rejected, or superseded; only claims and results carry one.'),
      query: z.string().optional().describe('Text the body must contain.'),
      task_id: z.string().optional().describe('Only the thread of this task.'),
      limit: z.number().int().positive().max(500).optional().describe('Default 50.'),
    },
  }, (args) => guard(() => {
    const hits = app.store.searchPosts({ type: args.type, status: args.status, query: args.query, taskId: args.task_id, limit: args.limit });
    const threads = new Map<string, Thread>();
    const threadOf = (hit: PostSearchHit): Thread => {
      let thread = threads.get(hit.post.threadId);
      if (!thread) { thread = app.store.requireThread(hit.post.threadId); threads.set(thread.id, thread); }
      return thread;
    };
    const text = hits.map((hit) => postHitText(hit, threadOf(hit)));
    const masked = hits.map((hit) => (threadOf(hit).authorHidden ? { ...hit, post: maskAuthor(hit.post) } : hit));
    return ok(hits.length ? [POSTS_ARE_DATA, '', ...text].join('\n') : 'No posts match.', { posts: masked });
  }));
}

/** A post as the structured content shows it when the thread hides authors: the same shape, no name. */
type MaskedPost = Omit<Post, 'author'> & { author: Post['author'] | 'participant' };

const maskAuthor = (p: Post): MaskedPost => ({ ...p, author: 'participant', authorName: null });

/** A task-history event as get_task shows it: the actor may read "participant" where a thread hides its authors. */
type MaskedEvent = Omit<CcEvent, 'actor'> & { actor: CcEvent['actor'] | 'participant' };

/**
 * Hiding a thread's authors has to hold in the task's history too: a `post.added` event names
 * its actor and carries the post id, which would hand an agent the mapping get_thread withheld.
 * Every thread and post event on a hidden thread loses its actor here, and `post.added` its
 * post id, so neither the name nor the way back to a post survives. The store and the dashboard
 * keep the full trail: this runs only on what MCP returns.
 */
function maskHistory(app: App, events: CcEvent[]): MaskedEvent[] {
  const hidden = new Map<string, boolean>();
  const hides = (threadId: Json | undefined): boolean => {
    if (typeof threadId !== 'string') return false;
    let value = hidden.get(threadId);
    if (value === undefined) {
      value = app.store.getThread(threadId)?.authorHidden ?? false;
      hidden.set(threadId, value);
    }
    return value;
  };
  return events.map((e) => {
    if (!/^(post|thread)\./.test(e.kind) || !hides(e.payload.threadId)) return e;
    const { postId: _postId, ...payload } = e.payload;
    return { ...e, actor: 'participant', actorName: null, payload };
  });
}

/** A thread by its id or by its task's id. Exactly one of the two is required. */
export function resolveThread(store: App['store'], args: { thread_id?: string; task_id?: string }): Thread {
  if (args.thread_id && args.task_id) throw new ValidationError('give thread_id or task_id, not both');
  if (args.thread_id) return store.requireThread(args.thread_id);
  if (!args.task_id) throw new ValidationError('thread_id or task_id is required');
  const task = store.requireTask(args.task_id);
  const thread = store.getThreadForTask(task.id);
  if (!thread) throw new NotFoundError(`task ${task.id} has no thread`);
  return thread;
}

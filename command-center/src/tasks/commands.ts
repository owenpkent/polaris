// Human-facing task commands. Actor is always 'human'.
import type { Command } from '../cli-types.ts';
import { parseFlags } from '../cli-types.ts';
import type { Confidence, Post, PostStatus, PostType, Priority, Store, Task, TaskStatus, ThreadSummary } from '../core/index.ts';
import { readFileSync } from 'node:fs';
import { importTasks } from '../importer/taskImport.ts';
import { ACTIVE_STATUSES, CONFIDENCES, POST_STATUSES, POST_TYPES } from '../core/index.ts';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export function formatTask(store: Store, t: Task, today?: string): string {
  const project = t.projectId ? store.getProject(t.projectId)?.name : undefined;
  const bits = [
    t.status === 'done' ? '[x]' : t.status === 'inbox' ? '[?]' : '[ ]',
    t.id,
    t.priority !== 'none' ? `!${t.priority}` : '',
    t.title,
    project ? `(${project})` : '',
    t.dueAt ? `due ${t.dueAt}${today && t.dueAt.slice(0, 10) < today && ACTIVE_STATUSES.includes(t.status) ? ' OVERDUE' : ''}` : '',
    t.recurrence ? `repeats ${t.recurrence}` : '',
    t.assignee ? `@${t.assignee}` : '',
    t.sourceType ? `<${t.sourceType}>` : '',
  ];
  return bits.filter(Boolean).join(' ');
}

/** One thread for `thread list`: the counts the dashboard's Threads tab shows, on one line. */
export function formatThreadSummary(s: ThreadSummary, today: string): string {
  const days = Math.max(0, Math.floor((Date.parse(`${today}T00:00:00.000Z`) - Date.parse(s.lastProgressAt)) / 86_400_000));
  const th = s.thread;
  const bits = [th.id, th.status, th.taskId, th.title, `posts ${s.postCount}`, `open claims ${s.openClaims}`, `unanswered objections ${s.unansweredObjections}`,
    `accepted results ${s.acceptedResults}`, `${days} day(s) since a verdict`, th.pinnedPostId ? `pinned ${th.pinnedPostId}` : '', th.authorHidden ? 'authors hidden' : '',
    th.dailyCap !== null ? `cap ${th.dailyCap}/day` : '', th.successorThreadId ? `continued in ${th.successorThreadId}` : ''];
  return bits.filter(Boolean).join('  ');
}

/** One post for the terminal: the metadata line, then the body indented under it. */
export function formatPost(p: Post): string {
  const who = p.author === 'human' ? 'owner' : `agent${p.authorName ? ` ${p.authorName}` : ''}`;
  const bits = [p.createdAt.slice(0, 16), p.id, p.type, who, p.confidence ? `confidence ${p.confidence}` : '', p.status ? `[${p.status}]` : '',
    p.refs.length ? `refs ${p.refs.join(',')}` : '', p.untrustedText ? 'UNTRUSTED-TEXT' : ''];
  return [bits.filter(Boolean).join(' '), ...p.body.split('\n').map((line) => `    ${line}`)].join('\n');
}

function requireThreadOf(store: Store, taskId: string) {
  const task = store.requireTask(taskId);
  const thread = store.getThreadForTask(task.id);
  if (!thread) throw new Error(`No thread on ${task.id}.`);
  return thread;
}

function resolveProjectId(store: Store, ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  const p = store.findProject(ref);
  if (!p) throw new Error(`No project matches "${ref}". Run "npm run cc -- projects" to list them.`);
  return p.id;
}

export const commands: Command[] = [
  {
    name: 'add',
    summary: 'Create a task',
    usage: 'add <title> [--project <name>] [--due YYYY-MM-DD] [--priority low|medium|high|urgent] [--repeat <rrule>] [--parent <id>] [--notes <text>]',
    run(args, { openApp, stdout }) {
      const f = parseFlags(args);
      const title = f._.join(' ');
      if (!title) throw new Error('A title is required.');
      const app = openApp();
      try {
        const t = app.store.createTask({
          title, projectId: resolveProjectId(app.store, str(f.project)), dueAt: str(f.due), priority: str(f.priority) as Priority | undefined,
          recurrence: str(f.repeat), parentId: str(f.parent), notes: str(f.notes),
        }, 'human');
        stdout(formatTask(app.store, t, app.today()));
        return 0;
      } finally { app.close(); }
    },
  },
  {
    name: 'tasks import',
    summary: 'Bulk-create tasks from a text or CSV file (- reads stdin)',
    usage: 'tasks import <file|-> [--project <ref>] [--format csv|lines] [--dry-run]',
    run(args, { openApp, stdout, stderr }) {
      const f = parseFlags(args);
      const file = f._[0];
      if (!file) throw new Error('A file is required (or - for stdin).');
      const format = str(f.format) ?? 'auto';
      if (format !== 'auto' && format !== 'csv' && format !== 'lines') throw new Error('--format must be csv or lines.');
      const text = readFileSync(file === '-' ? 0 : file, 'utf8');
      const dryRun = f['dry-run'] === true || f['dry-run'] === 'true';
      const app = openApp();
      try {
        const r = importTasks(app.store, text, { format, project: str(f.project), dryRun }, 'human');
        for (const e of r.errors) stderr(e.line > 0 ? `line ${e.line}: ${e.message}` : e.message);
        if (r.ignoredColumns.length) stdout(`Ignored columns: ${r.ignoredColumns.join(', ')}`);
        if (r.errors.length) {
          stdout(`Import failed (${r.errors.length} error(s)), nothing was created.`);
          return 1;
        }
        stdout(dryRun ? `Dry run: ${r.rows.length} task(s) would be created from ${r.format}.` : `Created ${r.created.length} task(s) from ${r.format}.`);
        return 0;
      } finally { app.close(); }
    },
  },
  {
    name: 'ls',
    summary: 'List tasks (default: active tasks by due date)',
    usage: 'ls [text] [--project <name>] [--status open,waiting] [--all] [--limit N] [--json]',
    run(args, { openApp, stdout }) {
      const f = parseFlags(args);
      const app = openApp();
      try {
        const status = str(f.status)?.split(',') as TaskStatus[] | undefined;
        const tasks = app.store.searchTasks({
          text: f._.join(' ') || undefined, projectId: resolveProjectId(app.store, str(f.project)),
          status: f.all ? undefined : status ?? [...ACTIVE_STATUSES], limit: Number(str(f.limit) ?? 50),
        });
        stdout(f.json ? JSON.stringify(tasks, null, 2) : tasks.map((t) => formatTask(app.store, t, app.today())).join('\n') || 'No tasks.');
        return 0;
      } finally { app.close(); }
    },
  },
  {
    name: 'show',
    summary: 'Show a task with subtasks, blockers, comments, and history',
    usage: 'show <id>',
    run(args, { openApp, stdout }) {
      const app = openApp();
      try {
        const s = app.store;
        const t = s.requireTask(args[0] ?? '');
        const out = [formatTask(s, t, app.today())];
        if (t.notes) out.push('', t.notes);
        if (t.sourceUrl) out.push('', `Source: ${t.sourceUrl}`);
        const sub = s.subtasks(t.id);
        if (sub.length) out.push('', 'Subtasks:', ...sub.map((x) => `  ${formatTask(s, x)}`));
        const blockers = s.blockersOf(t.id);
        if (blockers.length) out.push('', 'Blocked by:', ...blockers.map((x) => `  ${formatTask(s, x)}`));
        const comments = s.listComments(t.id);
        if (comments.length) out.push('', 'Comments:', ...comments.map((c) => `  ${c.createdAt.slice(0, 16)} ${c.author}${c.authorName ? ` ${c.authorName}` : ''}: ${c.body}`));
        out.push('', 'History:', ...s.taskHistory(t.id).slice(-10).map((e) => `  ${e.at.slice(0, 16)} ${e.actor}${e.actorName ? ` ${e.actorName}` : ''} ${e.kind}`));
        stdout(out.join('\n'));
        return 0;
      } finally { app.close(); }
    },
  },
  {
    name: 'done',
    summary: 'Complete one or more tasks',
    usage: 'done <id> [<id> ...]',
    run(args, { openApp, stdout }) {
      const app = openApp();
      try {
        for (const id of args) {
          const { task, next } = app.store.completeTask(id, 'human');
          stdout(formatTask(app.store, task));
          if (next) stdout(`  next: ${formatTask(app.store, next)}`);
        }
        return 0;
      } finally { app.close(); }
    },
  },
  {
    name: 'inbox',
    summary: 'List inbox items proposed by ingestion',
    run(_args, { openApp, stdout }) {
      const app = openApp();
      try {
        const items = app.store.searchTasks({ status: ['inbox'], orderBy: 'created', limit: 100 });
        stdout(items.map((t) => `${formatTask(app.store, t)}${t.sourceUrl ? `\n    ${t.sourceUrl}` : ''}`).join('\n') || 'Inbox is empty.');
        return 0;
      } finally { app.close(); }
    },
  },
  {
    name: 'accept',
    summary: 'Accept inbox items as real tasks',
    usage: 'accept <id> [<id> ...] [--project <name>] [--due YYYY-MM-DD] [--priority p]',
    run(args, { openApp, stdout }) {
      const f = parseFlags(args);
      const app = openApp();
      try {
        for (const id of f._) {
          const t = app.store.acceptInboxItem(id, {
            projectId: resolveProjectId(app.store, str(f.project)), dueAt: str(f.due), priority: str(f.priority) as Priority | undefined,
          }, 'human');
          stdout(formatTask(app.store, t));
        }
        return 0;
      } finally { app.close(); }
    },
  },
  {
    name: 'reject',
    summary: 'Reject inbox items so they never come back',
    usage: 'reject <id> [<id> ...] [--reason <text>]',
    run(args, { openApp, stdout }) {
      const f = parseFlags(args);
      const app = openApp();
      try {
        for (const id of f._) stdout(formatTask(app.store, app.store.rejectInboxItem(id, str(f.reason) ?? null, 'human')));
        return 0;
      } finally { app.close(); }
    },
  },
  // Threads (docs/agent-threads-proposal.md). The owner's own posts, so the actor is 'human'.
  {
    name: 'thread show',
    summary: 'Show a task\'s discussion thread: its posts, oldest first',
    usage: 'thread show <taskId> [--after <postId>] [--json]',
    run(args, { openApp, stdout }) {
      const f = parseFlags(args);
      const app = openApp();
      try {
        const task = app.store.requireTask(f._[0] ?? '');
        const thread = app.store.getThreadForTask(task.id);
        if (!thread) { stdout(`No thread on ${task.id}. Start one with "thread post ${task.id} --type question <body>".`); return 0; }
        const posts = app.store.listPosts(thread.id, { after: str(f.after) ?? null });
        const total = app.store.countPosts(thread.id);
        if (f.json) { stdout(JSON.stringify({ thread, posts, total }, null, 2)); return 0; }
        const window = f.after ? `${posts.length} after ${str(f.after)}` : (posts.length < total ? `showing the last ${posts.length} of ${total}` : `${total} post(s)`);
        const out = [`${thread.title} (${thread.id}) on ${formatTask(app.store, task, app.today())}`, `${thread.status}, ${window}`
          + `${thread.successorThreadId ? `, continued in ${thread.successorThreadId}` : ''}${thread.authorHidden ? ', authors hidden from agents' : ''}${thread.dailyCap !== null ? `, cap ${thread.dailyCap} posts per agent per day` : ''}`];
        const pinned = thread.pinnedPostId ? app.store.getPost(thread.pinnedPostId) : null;
        if (pinned) out.push('', 'Pinned state:', formatPost(pinned));
        for (const p of posts) out.push('', formatPost(p));
        stdout(out.join('\n'));
        return 0;
      } finally { app.close(); }
    },
  },
  {
    name: 'thread post',
    summary: 'Post to a task\'s thread as the owner, opening the thread if there is none',
    usage: `thread post <taskId> --type ${POST_TYPES.join('|')} [--confidence ${CONFIDENCES.join('|')}] [--refs <postId,postId>] [--reply-to <postId>] <body>`,
    run(args, { openApp, stdout }) {
      const f = parseFlags(args);
      const [taskId, ...words] = f._;
      const body = words.join(' ');
      const type = str(f.type);
      if (!taskId) throw new Error('A task id is required.');
      if (!type || !(POST_TYPES as readonly string[]).includes(type)) throw new Error(`--type must be one of ${POST_TYPES.join(', ')}.`);
      if (!body) throw new Error('A body is required.');
      const refs = (str(f.refs) ?? '').split(',').map((r) => r.trim()).filter(Boolean);
      const app = openApp();
      try {
        const thread = app.store.createThread(app.store.requireTask(taskId).id, null, 'human');
        const post = app.store.addPost(thread.id, {
          type: type as PostType, body, confidence: (str(f.confidence) as Confidence | undefined) ?? null, refs, parentPostId: str(f['reply-to']) ?? null,
        }, 'human', 'human');
        stdout(formatPost(post));
        return 0;
      } finally { app.close(); }
    },
  },
  // The owner's stage 2 controls. Each needs the human actor, which the command line always is.
  {
    name: 'thread list',
    summary: 'List threads with their counts and days since the last verdict',
    usage: 'thread list [--status open|closed] [--json]',
    run(args, { openApp, stdout }) {
      const f = parseFlags(args);
      const status = str(f.status);
      if (status !== undefined && status !== 'open' && status !== 'closed') throw new Error('--status must be open or closed.');
      const app = openApp();
      try {
        const rows = app.store.listThreads(status ? { status } : {});
        if (f.json) { stdout(JSON.stringify(rows, null, 2)); return 0; }
        stdout(rows.map((r) => formatThreadSummary(r, app.today())).join('\n') || 'No threads.');
        return 0;
      } finally { app.close(); }
    },
  },
  {
    name: 'thread judge',
    summary: 'Set a claim\'s or result\'s status as the owner',
    usage: `thread judge <postId> ${POST_STATUSES.join('|')}`,
    run(args, { openApp, stdout }) {
      const [postId, status] = parseFlags(args)._;
      if (!postId) throw new Error('A post id is required.');
      if (!status || !(POST_STATUSES as readonly string[]).includes(status)) throw new Error(`The status must be one of ${POST_STATUSES.join(', ')}.`);
      const app = openApp();
      try {
        stdout(formatPost(app.store.setPostStatus(postId, status as PostStatus, 'human')));
        return 0;
      } finally { app.close(); }
    },
  },
  {
    name: 'thread pin',
    summary: 'Pin a post as the thread\'s current state, or "none" to unpin',
    usage: 'thread pin <taskId> <postId|none>',
    run(args, { openApp, stdout }) {
      const [taskId, postId] = parseFlags(args)._;
      if (!taskId || !postId) throw new Error('A task id and a post id (or none) are required.');
      const app = openApp();
      try {
        const thread = requireThreadOf(app.store, taskId);
        const next = app.store.pinPost(thread.id, postId === 'none' ? null : postId, 'human');
        stdout(next.pinnedPostId ? `Pinned ${next.pinnedPostId} on ${next.id}.` : `Unpinned on ${next.id}.`);
        return 0;
      } finally { app.close(); }
    },
  },
  {
    name: 'thread close',
    summary: 'Close a task\'s thread; it takes no more posts',
    usage: 'thread close <taskId>',
    run(args, { openApp, stdout }) {
      const [taskId] = parseFlags(args)._;
      if (!taskId) throw new Error('A task id is required.');
      const app = openApp();
      try {
        const thread = app.store.closeThread(requireThreadOf(app.store, taskId).id, 'human');
        stdout(`Closed ${thread.id} at ${thread.closedAt}.`);
        return 0;
      } finally { app.close(); }
    },
  },
  {
    name: 'thread reopen',
    summary: 'Reopen a closed thread',
    usage: 'thread reopen <taskId>',
    run(args, { openApp, stdout }) {
      const [taskId] = parseFlags(args)._;
      if (!taskId) throw new Error('A task id is required.');
      const app = openApp();
      try {
        stdout(`Reopened ${app.store.reopenThread(requireThreadOf(app.store, taskId).id, 'human').id}.`);
        return 0;
      } finally { app.close(); }
    },
  },
  {
    name: 'thread fork',
    summary: 'Close a thread and continue it on a new subtask with a thread of its own',
    usage: 'thread fork <taskId> <title>',
    run(args, { openApp, stdout }) {
      const [taskId, ...words] = parseFlags(args)._;
      const title = words.join(' ');
      if (!taskId) throw new Error('A task id is required.');
      if (!title) throw new Error('A title for the fork is required.');
      const app = openApp();
      try {
        const forked = app.store.forkThread(requireThreadOf(app.store, taskId).id, { title }, 'human');
        stdout([`Closed ${forked.thread.id}; continued in ${forked.successor.id} on`, formatTask(app.store, forked.task, app.today())].join(' '));
        return 0;
      } finally { app.close(); }
    },
  },
  {
    name: 'thread set',
    summary: 'Change a thread\'s settings: hide authors from agents, cap posts per agent per day',
    usage: 'thread set <taskId> [--hide-authors on|off] [--daily-cap <n>|none]',
    run(args, { openApp, stdout }) {
      const f = parseFlags(args);
      const [taskId] = f._;
      if (!taskId) throw new Error('A task id is required.');
      const options: { authorHidden?: boolean; dailyCap?: number | null } = {};
      const hide = str(f['hide-authors']);
      if (hide !== undefined) {
        if (hide !== 'on' && hide !== 'off') throw new Error('--hide-authors must be on or off.');
        options.authorHidden = hide === 'on';
      }
      const cap = str(f['daily-cap']);
      if (cap !== undefined) {
        if (cap === 'none') options.dailyCap = null;
        else if (/^[1-9][0-9]*$/.test(cap)) options.dailyCap = Number(cap);
        else throw new Error('--daily-cap must be a positive whole number or none.');
      }
      if (!Object.keys(options).length) throw new Error('Nothing to change: give --hide-authors or --daily-cap.');
      const app = openApp();
      try {
        const thread = app.store.setThreadOptions(requireThreadOf(app.store, taskId).id, options, 'human');
        stdout(`${thread.id}: authors ${thread.authorHidden ? 'hidden' : 'shown'}, daily cap ${thread.dailyCap ?? 'none'}.`);
        return 0;
      } finally { app.close(); }
    },
  },
  {
    name: 'thread search',
    summary: 'Search posts across every thread: the library of what was argued and accepted',
    usage: `thread search [--type ${POST_TYPES.join('|')}] [--status ${POST_STATUSES.join('|')}] [--task <taskId>] [--limit <n>] [--json] [query]`,
    run(args, { openApp, stdout }) {
      const f = parseFlags(args);
      const type = str(f.type);
      const status = str(f.status);
      if (type !== undefined && !(POST_TYPES as readonly string[]).includes(type)) throw new Error(`--type must be one of ${POST_TYPES.join(', ')}.`);
      if (status !== undefined && !(POST_STATUSES as readonly string[]).includes(status)) throw new Error(`--status must be one of ${POST_STATUSES.join(', ')}.`);
      const app = openApp();
      try {
        const hits = app.store.searchPosts({
          type: type as PostType | undefined, status: status as PostStatus | undefined, taskId: str(f.task), query: f._.join(' ') || undefined,
          limit: str(f.limit) !== undefined ? Number(str(f.limit)) : undefined,
        });
        if (f.json) { stdout(JSON.stringify(hits, null, 2)); return 0; }
        stdout(hits.map((h) => `${h.taskId} ${h.taskTitle} / ${h.threadTitle}\n${formatPost(h.post)}`).join('\n\n') || 'No posts match.');
        return 0;
      } finally { app.close(); }
    },
  },
  {
    name: 'projects',
    summary: 'List projects with open task counts',
    run(_args, { openApp, stdout }) {
      const app = openApp();
      try {
        const rows = app.store.listProjects().map((p) => {
          const open = app.store.countTasks({ projectId: p.id, status: [...ACTIVE_STATUSES] });
          const inbox = app.store.countTasks({ projectId: p.id, status: ['inbox'] });
          return `${p.slug.padEnd(32)} ${String(open).padStart(4)} open ${String(inbox).padStart(3)} inbox${p.github ? '' : '  (no repo)'}`;
        });
        stdout(rows.join('\n') || 'No projects. Run "npm run cc -- import" first.');
        return 0;
      } finally { app.close(); }
    },
  },
];

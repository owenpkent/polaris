// Human-facing task commands. Actor is always 'human'.
import type { Command } from '../cli-types.ts';
import { parseFlags } from '../cli-types.ts';
import type { Priority, Store, Task, TaskStatus } from '../core/index.ts';
import { ACTIVE_STATUSES } from '../core/index.ts';

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
        if (comments.length) out.push('', 'Comments:', ...comments.map((c) => `  ${c.createdAt.slice(0, 16)} ${c.author}: ${c.body}`));
        out.push('', 'History:', ...s.taskHistory(t.id).slice(-10).map((e) => `  ${e.at.slice(0, 16)} ${e.actor} ${e.kind}`));
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

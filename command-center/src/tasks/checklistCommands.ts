// `cc checklist ...`: reusable checklists from the command line. Actor is always 'human'.
// A checklist is a template; starting it makes an ordinary open task with one subtask per item.
import type { Command } from '../cli-types.ts';
import { parseFlags } from '../cli-types.ts';
import type { Checklist, Store } from '../core/index.ts';
import { formatTask } from './commands.ts';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function requireChecklist(store: Store, ref: string | undefined): Checklist {
  if (!ref) throw new Error('A checklist id or name is required.');
  const c = store.findChecklist(ref);
  if (!c) throw new Error(`No checklist matches "${ref}". Run "npm run cc -- checklist list" to see them.`);
  return c;
}

export function formatChecklistLine(c: Checklist): string {
  return `${c.id}  ${c.name}  (${c.items.length} item${c.items.length === 1 ? '' : 's'})`;
}

export const commands: Command[] = [
  {
    name: 'checklist list',
    summary: 'List reusable checklists',
    usage: 'checklist list [--json]',
    run(args, { openApp, stdout }) {
      const f = parseFlags(args);
      const app = openApp();
      try {
        const all = app.store.listChecklists();
        stdout(f.json ? JSON.stringify(all, null, 2) : all.map(formatChecklistLine).join('\n') || 'No checklists yet.');
        return 0;
      } finally { app.close(); }
    },
  },
  {
    name: 'checklist show',
    summary: 'Show a checklist and its items',
    usage: 'checklist show <id|name>',
    run(args, { openApp, stdout }) {
      const f = parseFlags(args);
      const app = openApp();
      try {
        const c = requireChecklist(app.store, f._.join(' '));
        const out = [`${c.name} (${c.id})`];
        if (c.notes) out.push('', c.notes);
        out.push('', ...(c.items.length ? c.items.map((item, i) => `  ${i + 1}. ${item}`) : ['  No items yet.']));
        stdout(out.join('\n'));
        return 0;
      } finally { app.close(); }
    },
  },
  {
    name: 'checklist add',
    summary: 'Create a reusable checklist',
    usage: 'checklist add <name> --items "First; Second; Third" [--notes <text>]',
    run(args, { openApp, stdout }) {
      const f = parseFlags(args);
      const name = f._.join(' ');
      if (!name) throw new Error('A name is required.');
      const items = (str(f.items) ?? '').split(';');
      const app = openApp();
      try {
        const c = app.store.createChecklist({ name, notes: str(f.notes), items }, 'human');
        stdout(formatChecklistLine(c));
        return 0;
      } finally { app.close(); }
    },
  },
  {
    name: 'checklist start',
    summary: 'Start a checklist: a new task with one subtask per item',
    usage: 'checklist start <id|name> [--title <text>] [--project <name>] [--due YYYY-MM-DD]',
    run(args, { openApp, stdout }) {
      const f = parseFlags(args);
      const app = openApp();
      try {
        const c = requireChecklist(app.store, f._.join(' '));
        const projectRef = str(f.project);
        let projectId: string | undefined;
        if (projectRef) {
          const p = app.store.findProject(projectRef);
          if (!p) throw new Error(`No project matches "${projectRef}". Run "npm run cc -- projects" to list them.`);
          projectId = p.id;
        }
        const { task, subtasks } = app.store.startChecklist(c.id, { title: str(f.title), projectId, dueAt: str(f.due) }, 'human');
        stdout([formatTask(app.store, task, app.today()), ...subtasks.map((s) => `  ${formatTask(app.store, s)}`)].join('\n'));
        return 0;
      } finally { app.close(); }
    },
  },
];

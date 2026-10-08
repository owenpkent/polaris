// Adds demo tasks to a scratch database so every dashboard view has something to show: My tasks
// rows in each due-date group, and inbox items from GitHub, plus two from the removed Gmail and
// Calendar sources so the old-source labels and the third-party marker can still be seen.
// Refuses the real database.
import { resolve } from 'node:path';
import { openStore } from '../core/index.ts';
import type { Priority, SourceType } from '../core/types.ts';
import { loadConfig } from '../config.ts';

const config = loadConfig();
const realDb = resolve(config.repoRoot, 'command-center', 'data', 'constellation.db');
if (!process.env.CC_DB || resolve(config.dbPath) === realDb) {
  console.error('Set CC_DB to a scratch database before seeding demo data.');
  process.exit(1);
}

const store = openStore(config.dbPath);
// Nothing imports real projects any more, so a fresh scratch database gets a few demo ones:
// two with a repo, one without.
if (!store.listProjects().some((p) => p.category !== 'initiative')) {
  store.createProject({ name: 'Demo Desktop App', type: 'Software / Desktop app', status: 'Active', github: 'https://github.com/example/demo-desktop-app', description: 'A made-up project for the mockup.' }, 'system');
  store.createProject({ name: 'Demo Website', type: 'Software / Web', status: 'Active', github: 'https://github.com/example/demo-website' }, 'system');
  store.createProject({ name: 'Household admin', type: 'Personal', status: 'Active' }, 'system');
}
const projects = store.listProjects().filter((p) => p.category !== 'initiative');
const projectId = (i: number): string | null => (projects.length ? projects[i % projects.length].id : null);

function day(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const tasks: { title: string; due: number | null; priority: Priority; assignee?: string }[] = [
  { title: 'Renew domain for the portfolio site', due: -2, priority: 'high' },
  { title: 'Reply to accessibility audit feedback', due: 0, priority: 'urgent' },
  { title: 'Review dashboard focus ring contrast', due: 0, priority: 'medium' },
  { title: 'Draft ADR-003 hosting options', due: 1, priority: 'medium', assignee: 'Scribe' },
  { title: 'Clean up stale branches across repos', due: 4, priority: 'low' },
  { title: 'Plan next marketing post', due: 12, priority: 'none' },
  { title: 'Collect ideas for the goals page', due: null, priority: 'none' },
];
tasks.forEach((t, i) => {
  store.createTask({ title: t.title, dueAt: t.due === null ? null : day(t.due), priority: t.priority, projectId: projectId(i), assignee: t.assignee ?? null });
});

// One dependency, so the Ready and Blocked filters on My tasks (the ready and blocked views) have
// something to separate: the blocker is ready, the task it holds is blocked until it is done.
// Both are due this week, so they sit in an expanded group, and neither has a project.
const blocker = store.createTask({ title: 'Choose a standing desk', dueAt: day(2), priority: 'medium' });
const held = store.createTask({ title: 'Assemble the standing desk', dueAt: day(5), priority: 'medium' });
store.addDependency(blocker.id, held.id);

// One reusable checklist, so the Checklists view has something to start.
store.createChecklist({ name: 'Clean the kitchen', items: ['Wash the dishes', 'Wipe the counters', 'Clean the hob', 'Sweep the floor', 'Take the bins out'] });

const inbox: { sourceType: SourceType; title: string; notes: string; url: string; due: number | null }[] = [
  { sourceType: 'github', title: 'Review requested: fix keyboard trap in settings dialog', notes: 'Demo pull request.', url: 'https://github.com/example/demo/pull/1', due: null },
  { sourceType: 'github', title: 'Issue assigned: board cards overflow on narrow screens', notes: 'Demo issue.', url: 'https://github.com/example/demo/issues/2', due: null },
  { sourceType: 'gmail', title: 'Invoice question from a client', notes: 'Demo email thread.', url: 'https://mail.google.com/', due: 2 },
  { sourceType: 'gcal', title: 'Prep: design review call', notes: 'Demo calendar event.', url: 'https://calendar.google.com/', due: 1 },
];
inbox.forEach((item, i) => {
  store.upsertFromSource({
    sourceType: item.sourceType, sourceId: `demo-${i}`, title: item.title, notes: item.notes,
    sourceUrl: item.url, dueAt: item.due === null ? null : day(item.due), projectId: projectId(i), contentHash: `demo-${i}`,
  });
});

console.log(`Seeded ${tasks.length + 2} demo tasks (one blocked by another), one checklist, and ${inbox.length} inbox items into ${config.dbPath}`);

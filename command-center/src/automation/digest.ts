// The daily digest: a markdown snapshot of the task graph plus rule notifications and source
// freshness, meant to be both human-readable and easy for Claude to act on (every task line
// carries its id).
import { ACTIVE_STATUSES, type GoalDetail, type Store, type Task } from '../core/index.ts';
import { addDays } from './dates.ts';
import { listNotifications } from './rules.ts';
import { runView } from './views.ts';

export interface Digest { date: string; markdown: string; counts: Record<string, number> }

/** A goal with no status update for this many days is called out in the digest. */
export const GOAL_STALE_DAYS = 14;

const GOAL_STATUS_LABELS: Record<GoalDetail['status'], string> = {
  on_track: 'on track', at_risk: 'at risk', off_track: 'off track', achieved: 'achieved', dropped: 'dropped',
};

function daysBetween(fromDate: string, toDate: string): number {
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000);
}

/** What needs the owner's attention on a goal: no open task to move it, or no status update lately. */
export function goalFlags(goal: GoalDetail, today: string): string[] {
  const flags: string[] = [];
  if (goal.progress.openTasks === 0) flags.push('stalled: no open task');
  const since = goal.statusUpdatedAt ? daysBetween(goal.statusUpdatedAt.slice(0, 10), today) : null;
  if (since === null) flags.push('no status update yet');
  else if (since >= GOAL_STALE_DAYS) flags.push(`no status update in ${since} days`);
  return flags;
}

function goalLine(goal: GoalDetail, today: string): string {
  const p = goal.progress;
  let progress = 'nothing to measure yet';
  if (p.mode === 'manual' && goal.currentValue != null && goal.targetValue != null) {
    progress = `${goal.currentValue} of ${goal.targetValue}${goal.unit ? ` ${goal.unit}` : ''}${p.percent != null ? ` (${p.percent}%)` : ''}`;
  } else if (p.mode === 'tasks' && p.total) {
    progress = `${p.done} of ${p.total} done (${p.percent}%)`;
  }
  const flags = goalFlags(goal, today);
  const period = goal.periodLabel ? ` (${goal.periodLabel})` : '';
  return `- [${goal.id}] ${goal.title}${period}: ${GOAL_STATUS_LABELS[goal.status]}, ${progress}${flags.length ? `. Needs attention: ${flags.join('; ')}` : ''}`;
}

// The daemon jobs that bring work in (daemon/jobs.ts). A name with no job would read "never" forever.
const SOURCE_FRESHNESS_NAMES = ['github', 'repo-files', 'import'] as const;

function renderSection(
  title: string,
  tasks: Task[],
  line: (t: Task) => string,
  opts: { limit?: number; emptyText?: string } = {},
): { markdown: string; count: number } {
  const limit = opts.limit ?? 10;
  const count = tasks.length;
  if (count === 0) return { markdown: `**${title}:** ${opts.emptyText ?? 'none'}.`, count };
  const shown = tasks.slice(0, limit).map(line);
  const more = count > limit ? `\n- ...and ${count - limit} more.` : '';
  return { markdown: `## ${title} (${count})\n\n${shown.join('\n')}${more}`, count };
}

/**
 * Build (but do not deliver) the daily digest. Never writes to the store -- see
 * `markDigestDelivered` for the write half, kept separate so building a preview has no
 * side effects. `nowIso` anchors the "completed in the last 24 hours" section to a true 24h
 * window; it defaults to the current instant and only needs overriding for deterministic tests.
 */
export function buildDigest(store: Store, opts: { today: string; nowIso?: string }): Digest {
  const { today } = opts;
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const ACTIVE = [...ACTIVE_STATUSES];

  const projectNames = new Map<string, string>();
  const nameOf = (id: string | null): string | null => {
    if (!id) return null;
    if (!projectNames.has(id)) projectNames.set(id, store.getProject(id)?.name ?? id);
    return projectNames.get(id) ?? null;
  };

  const line = (t: Task, showSource = false): string => {
    // Third-party text is quoted and marked so an assistant reading the digest treats it as data.
    const parts = [`[${t.id}]`, t.untrustedText ? `${JSON.stringify(t.title)} UNTRUSTED-TEXT` : t.title];
    const project = nameOf(t.projectId);
    if (project) parts.push(`(${project})`);
    if (t.dueAt) parts.push(`due ${t.dueAt}`);
    if (t.priority === 'urgent' || t.priority === 'high') parts.push(`[${t.priority}]`);
    if (showSource && t.sourceType) {
      parts.push(`via ${t.sourceType}`);
      if (t.sourceUrl) parts.push(t.sourceUrl);
    }
    return `- ${parts.join(' ')}`;
  };

  const inboxTasks = runView(store, 'inbox', today).tasks;
  const overdueTasks = runView(store, 'overdue', today).tasks;
  const todayTasks = runView(store, 'today', today).tasks;
  const upcomingTasks = runView(store, 'upcoming', today).tasks;
  const waitingTasks = runView(store, 'waiting', today).tasks;
  const milestoneTasks = store.searchTasks({
    status: ACTIVE, isMilestone: true, dueAfter: today, dueBefore: addDays(today, 31), orderBy: 'due', limit: 100,
  });
  const completedCutoff = new Date(new Date(nowIso).getTime() - 24 * 60 * 60 * 1000).toISOString();
  const completedTasks = store.searchTasks({ status: ['done'], completedAfter: completedCutoff, orderBy: 'updated', limit: 200 });

  const lastDigestAt = store.getKv<string>('digest.lastAt');
  const notifications = listNotifications(store, lastDigestAt ?? `${addDays(today, -7)}T00:00:00.000Z`);

  const sections: { markdown: string; count: number }[] = [];
  const counts: Record<string, number> = {};

  const push = (key: string, title: string, tasks: Task[], sectionOpts: { showSource?: boolean; emptyText?: string } = {}) => {
    const r = renderSection(title, tasks, (t) => line(t, sectionOpts.showSource), { emptyText: sectionOpts.emptyText });
    sections.push(r);
    counts[key] = r.count;
  };

  push('inbox', 'Inbox', inboxTasks, { showSource: true, emptyText: 'nothing to triage' });
  push('overdue', 'Overdue', overdueTasks);
  push('today', 'Today', todayTasks);
  push('upcoming', 'Upcoming (7 days)', upcomingTasks);
  push('waiting', 'Waiting and blocked', waitingTasks);
  push('milestones', 'Milestones (next 30 days)', milestoneTasks);
  push('completed', 'Completed (last 24 hours)', completedTasks, { emptyText: 'nothing completed' });

  // Goals: goals that need attention come first. Left out entirely until a goal exists.
  const goals = store.listGoalDetails();
  if (goals.length > 0) {
    const flagged = goals.filter((g) => goalFlags(g, today).length > 0);
    const ordered = [...flagged, ...goals.filter((g) => !flagged.includes(g))];
    const shown = ordered.slice(0, 10).map((g) => goalLine(g, today));
    const more = ordered.length > 10 ? `\n- ...and ${ordered.length - 10} more.` : '';
    const heading = `## Goals (${goals.length}, ${flagged.length} need attention)`;
    sections.push({ markdown: `${heading}\n\n${shown.join('\n')}${more}`, count: goals.length });
    counts.goals = goals.length;
    counts.goalsNeedingAttention = flagged.length;
  }

  if (notifications.length === 0) {
    sections.push({ markdown: '**Notifications:** none since the last digest.', count: 0 });
  } else {
    // A notification message carries text rendered from a rule template, which may include a
    // third-party task title. renderTemplate quotes and marks that title; folding newlines here
    // keeps a single notification to a single bullet whatever the message turns out to contain.
    const oneLine = (message: string): string => message.replaceAll(/\s*[\r\n]+\s*/g, ' ');
    const shown = notifications.slice(0, 10)
      .map((n) => `- ${n.at} ${n.ruleName ? `[${n.ruleName}] ` : ''}${oneLine(n.message)}${n.taskId ? ` (${n.taskId})` : ''}`);
    const more = notifications.length > 10 ? `\n- ...and ${notifications.length - 10} more.` : '';
    sections.push({ markdown: `## Notifications (${notifications.length})\n\n${shown.join('\n')}${more}`, count: notifications.length });
  }
  counts.notifications = notifications.length;

  const freshnessLines = SOURCE_FRESHNESS_NAMES.map((name) => {
    const cursor = store.getKv<string>(`sync.${name}.lastAt`);
    return `- ${name}: ${cursor ?? 'never'}`;
  });
  sections.push({ markdown: `## Source freshness\n\n${freshnessLines.join('\n')}`, count: SOURCE_FRESHNESS_NAMES.length });

  const markdown = [`# Command Center Digest - ${today}`, '', ...sections.map((s) => s.markdown)].join('\n\n');
  return { date: today, markdown, counts };
}

/** Record that the digest was delivered, so the next digest's notifications section starts from here. */
export function markDigestDelivered(store: Store, at: string): void {
  store.setKv('digest.lastAt', at);
}

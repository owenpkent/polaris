// Turns GitHub issue/PR JSON into Command Center SourceItems, and the logic to decide
// whether one of the viewer's own open PRs needs attention (failing checks / changes requested).
import { contentHash } from '../common.ts';
import type { Priority, SourceItem } from '../../core/index.ts';
import type { GithubClient } from './client.ts';

const PRIORITY_LABELS = ['bug', 'urgent', 'critical', 'p0', 'p1'];

export interface GithubUser { login: string }
export interface GithubLabel { name: string }

export interface GithubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  labels?: (string | GithubLabel)[];
  assignees?: GithubUser[];
  user?: GithubUser | null;
  pull_request?: unknown;
  repository_url?: string;
  repository?: { full_name?: string };
}

export interface GithubPull extends GithubIssue {
  head: { sha: string };
  merged?: boolean;
  requested_reviewers?: GithubUser[];
  requested_teams?: { slug: string }[];
}

export function isPullRequest(issue: GithubIssue): boolean {
  return issue.pull_request != null;
}

function labelNames(issue: GithubIssue): string[] {
  return (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
}

export function priorityFor(issue: GithubIssue): Priority {
  const names = labelNames(issue).map((n) => n.toLowerCase());
  return names.some((n) => PRIORITY_LABELS.includes(n)) ? 'high' : 'none';
}

function excerpt(body: string | null | undefined): string {
  return (body ?? '').trim().slice(0, 500);
}

function buildNotes(issue: GithubIssue, extra?: string): string {
  const parts: string[] = [];
  const body = excerpt(issue.body);
  if (body) parts.push(body);
  const labels = labelNames(issue);
  if (labels.length) parts.push(`Labels: ${labels.join(', ')}`);
  parts.push(`Author: ${issue.user?.login ?? 'unknown'}`);
  if (extra) parts.push(extra);
  return parts.join('\n\n');
}

/** Plain item: `owner/repo#N`, used for both "assigned to viewer" and "open issue by someone else". */
export function buildPlainItem(fullName: string, issue: GithubIssue, projectId: string | null): SourceItem {
  const assignees = (issue.assignees ?? []).map((a) => a.login).sort();
  return {
    sourceType: 'github',
    sourceId: `${fullName}#${issue.number}`,
    title: issue.title,
    notes: buildNotes(issue),
    sourceUrl: issue.html_url,
    projectId,
    priority: priorityFor(issue),
    contentHash: contentHash(issue.title, issue.body, labelNames(issue).sort().join(','), assignees.join(','), issue.state, projectId ?? ''),
    initialStatus: 'inbox',
  };
}

/** Review-requested item: `owner/repo#N:review`. Only needs base issue fields (title, body, ...). */
export function buildReviewItem(fullName: string, pr: GithubIssue, projectId: string | null): SourceItem {
  const assignees = (pr.assignees ?? []).map((a) => a.login).sort();
  return {
    sourceType: 'github',
    sourceId: `${fullName}#${pr.number}:review`,
    title: `Review: ${pr.title}`,
    notes: buildNotes(pr),
    sourceUrl: pr.html_url,
    projectId,
    priority: priorityFor(pr),
    contentHash: contentHash(pr.title, pr.body, labelNames(pr).sort().join(','), assignees.join(','), pr.state, projectId ?? ''),
    initialStatus: 'inbox',
  };
}

/** Own-PR-needs-attention item: `owner/repo#N:attention`. `reason` is part of the content hash. */
export function buildAttentionItem(fullName: string, pr: GithubPull, projectId: string | null, reason: string): SourceItem {
  const assignees = (pr.assignees ?? []).map((a) => a.login).sort();
  return {
    sourceType: 'github',
    sourceId: `${fullName}#${pr.number}:attention`,
    title: `Fix PR: ${pr.title} (${reason})`,
    notes: buildNotes(pr, `Needs attention: ${reason}`),
    sourceUrl: pr.html_url,
    projectId,
    priority: priorityFor(pr),
    contentHash: contentHash(pr.title, pr.body, labelNames(pr).sort().join(','), assignees.join(','), pr.state, reason, projectId ?? ''),
    initialStatus: 'inbox',
  };
}

interface CheckRun { status: string; conclusion: string | null; name: string }
interface CombinedStatus { state: string }
interface Review { user: GithubUser; state: string }

/**
 * Why one of the viewer's own open PRs needs attention, or null if it doesn't.
 * Checked in order: failing/errored CI check run, failing combined status, changes requested
 * in the latest review from any reviewer.
 */
export async function checkAttention(client: GithubClient, owner: string, repo: string, pr: GithubPull): Promise<string | null> {
  const sha = pr.head.sha;
  const [checkRuns, status, reviews] = await Promise.all([
    client.get<{ check_runs: CheckRun[] }>(`/repos/${owner}/${repo}/commits/${sha}/check-runs`, { per_page: 100 }),
    client.get<CombinedStatus>(`/repos/${owner}/${repo}/commits/${sha}/status`),
    // Paginated, not a bare get: reviews come back oldest first, so with GitHub's default page
    // of 30 the "latest state per reviewer" map below held the oldest 30 and a long-since
    // resolved CHANGES_REQUESTED would keep an attention task alive forever.
    client.paginated<Review>(`/repos/${owner}/${repo}/pulls/${pr.number}/reviews`).then((r) => r.items),
  ]);
  const failing = (checkRuns.check_runs ?? []).find((r) => r.status === 'completed' && ['failure', 'timed_out', 'cancelled'].includes(r.conclusion ?? ''));
  if (failing) return `check failing: ${failing.name}`;
  if (status.state === 'failure' || status.state === 'error') return `status checks failing`;
  const latestByUser = new Map<string, string>();
  for (const r of reviews) {
    if (r.state === 'COMMENTED') continue;
    latestByUser.set(r.user.login, r.state);
  }
  if ([...latestByUser.values()].includes('CHANGES_REQUESTED')) return 'changes requested';
  return null;
}

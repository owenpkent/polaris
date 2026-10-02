// GitHub ingestion. `syncGithub` does a full pass across tracked (and assigned-but-untracked)
// repos; `refreshItem` re-derives the truth for exactly one issue/PR number, used both by the
// end-of-sync disappearance sweep and by the webhook receiver so both paths share one rulebook.
import { emptyReport, previewUpsert, tallyUpsert, type SyncReport } from '../common.ts';
import type { SourceItem, Store, UpsertResult } from '../../core/index.ts';
import type { SecretStore } from '../secrets.ts';
import { GithubNotSignedInError, resolveGithubAuth } from './auth.ts';
import { GithubClient, GithubRateLimitStop, GithubRequestError } from './client.ts';
import { buildAttentionItem, buildPlainItem, buildReviewItem, checkAttention, isPullRequest, type GithubIssue, type GithubPull } from './items.ts';
import { mapProjectsToRepos, repoFullNameFromItem, type RepoMapping } from './mapping.ts';
import { isSyncIssuesEnabled } from './repoSettings.ts';

export interface GithubSyncOptions {
  dryRun?: boolean;
  token?: string;
  /** Where the GitHub App sign-in is kept. Tests pass an in-memory store so the real one is never read. */
  secrets?: SecretStore;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  rateLimitFloor?: number;
  searchRateLimitFloor?: number;
}

function parseSourceId(sourceId: string): { fullName: string; owner: string; repo: string; number: number } | null {
  const m = sourceId.match(/^([^/]+)\/([^/#]+)#(\d+)(?::(?:review|attention))?$/);
  if (!m) return null;
  return { fullName: `${m[1]}/${m[2]}`, owner: m[1], repo: m[2], number: Number(m[3]) };
}

export async function syncGithub(store: Store, opts: GithubSyncOptions = {}): Promise<SyncReport> {
  const report = emptyReport('github');
  const log = opts.log ?? (() => {});
  const dryRun = opts.dryRun ?? false;

  let client: GithubClient;
  let viewerLogin: string;
  let mappings: RepoMapping[];
  try {
    const token = opts.token ?? await resolveGithubAuth({ secrets: opts.secrets, fetchImpl: opts.fetchImpl });
    client = new GithubClient({
      token, store, fetchImpl: opts.fetchImpl, log,
      rateLimitFloor: opts.rateLimitFloor, searchRateLimitFloor: opts.searchRateLimitFloor,
    });
    viewerLogin = await client.viewer();
    mappings = await mapProjectsToRepos(store.listProjects());
  } catch (e) {
    report.partial = true;
    report.errors.push(e instanceof GithubNotSignedInError ? `skipped: ${e.message}` : `setup failed: ${errorMessage(e)}`);
    return report;
  }
  const repoByFullName = new Map(mappings.map((m) => [m.fullName, m]));
  const seen = new Set<string>();

  const upsert = (item: SourceItem): UpsertResult['action'] => {
    const action = dryRun ? previewUpsert(store, item) : store.upsertFromSource(item, 'system').action;
    tallyUpsert(report, action);
    log(`  [${action}] ${item.sourceId} ${item.title}`);
    return action;
  };

  // 1. Open issues and PRs assigned to the viewer (any repo the token can see, tracked or not).
  await runStage(report, client, dryRun, 'assigned issues/PRs', async () => {
    const { items } = await client.paginated<GithubIssue>('/issues', { filter: 'assigned', state: 'open' });
    for (const issue of items) {
      const fullName = repoFullNameFromItem(issue);
      if (!fullName || !isSyncIssuesEnabled(store, fullName)) continue;
      const projectId = repoByFullName.get(fullName)?.projectId ?? null;
      const item = buildPlainItem(fullName, issue, projectId);
      upsert(item);
      seen.add(item.sourceId);
    }
  });

  // 2. PRs where the viewer's review is requested (search API; used once per sync, well under 30/min).
  if (!report.partial) {
    await runStage(report, client, dryRun, 'review-requested PRs', async () => {
      // user-review-requested (not the broader review-requested, which also matches team review
      // requests) so this list only ever contains PRs refreshItem can independently confirm via
      // requested_reviewers -- otherwise a team-requested PR gets created here, then the
      // disappearance sweep or a webhook (which only checks the individual requested_reviewers)
      // marks it gone, and the next poll's search recreates it: an endless flap.
      const { items } = await client.paginated<GithubIssue>('/search/issues', { q: 'is:pr is:open user-review-requested:@me' });
      for (const pr of items) {
        const fullName = repoFullNameFromItem(pr);
        if (!fullName || !isSyncIssuesEnabled(store, fullName)) continue;
        const projectId = repoByFullName.get(fullName)?.projectId ?? null;
        const item = buildReviewItem(fullName, pr, projectId);
        upsert(item);
        seen.add(item.sourceId);
      }
    });
  }

  // 3. The viewer's own open PRs: flag ones with failing checks or changes requested.
  if (!report.partial) {
    await runStage(report, client, dryRun, 'own PRs needing attention', async () => {
      const { items } = await client.paginated<GithubIssue>('/issues', { filter: 'created', state: 'open' });
      for (const issue of items) {
        if (!isPullRequest(issue)) continue;
        if (client.rateLimited) break;
        const fullName = repoFullNameFromItem(issue);
        if (!fullName || !isSyncIssuesEnabled(store, fullName)) continue;
        const [owner, repo] = fullName.split('/');
        const pr = await client.getOrNull<GithubPull>(`/repos/${owner}/${repo}/pulls/${issue.number}`);
        if (!pr) continue;
        // Per PR, like the disappearance sweep below. checkAttention reads check-runs, combined
        // status and reviews; a declined or revoked `checks: read` on one org 403s every time,
        // and letting that escape would mark the whole sync partial on every run, which disables
        // stage 4 and the sweep for good -- closed issues would never be completed again.
        let reason: string | null = null;
        try {
          reason = await checkAttention(client, owner, repo, pr);
        } catch (e) {
          report.errors.push(`could not check ${fullName}#${issue.number}: ${errorMessage(e)}`);
          continue;
        }
        if (reason) {
          const projectId = repoByFullName.get(fullName)?.projectId ?? null;
          const item = buildAttentionItem(fullName, pr, projectId, reason);
          upsert(item);
          seen.add(item.sourceId);
        }
        // else: leave unseen. If a task exists for it, the disappearance sweep below confirms
        // it is resolved (via a fresh check) and marks it gone.
      }
    });
  }

  // 4. Open issues opened by someone else, in every tracked repo.
  if (!report.partial) {
    for (const mapping of mappings) {
      if (client.rateLimited) break;
      if (!isSyncIssuesEnabled(store, mapping.fullName)) continue;
      await runStage(report, client, dryRun, `issues in ${mapping.fullName}`, async () => {
        const { items } = await client.paginated<GithubIssue>(`/repos/${mapping.owner}/${mapping.repo}/issues`, { state: 'open' });
        for (const issue of items) {
          if (isPullRequest(issue)) continue;
          if (issue.user?.login === viewerLogin) continue;
          const item = buildPlainItem(mapping.fullName, issue, mapping.projectId);
          if (seen.has(item.sourceId)) continue;
          upsert(item);
          seen.add(item.sourceId);
        }
      });
      if (report.partial) break;
    }
  }

  // 5. Disappearance sweep: anything active in the DB that this sync did not encounter gets
  // confirmed with an individual GET before being marked gone. Only runs after a fully
  // successful pass, per the "propose, do not act on partial information" rule.
  if (!report.partial) {
    const active = store.activeSourceIds('github');
    for (const sourceId of active) {
      if (seen.has(sourceId)) continue;
      if (client.rateLimited) {
        report.errors.push('rate limited during disappearance sweep; some items left unconfirmed for next run');
        break;
      }
      const parsed = parseSourceId(sourceId);
      if (!parsed) continue;
      // A repo the user turned sync off for keeps whatever tasks it already has: they are never
      // confirmed and never swept as gone, only left alone until the switch is turned back on.
      if (!isSyncIssuesEnabled(store, parsed.fullName)) continue;
      try {
        const projectId = repoByFullName.get(parsed.fullName)?.projectId ?? null;
        const outcome = await refreshItem(store, client, { ...parsed, projectId, viewerLogin }, { dryRun });
        if (outcome.plain === 'gone' || outcome.review === 'gone' || outcome.attention === 'gone') report.goneCompleted++;
      } catch (e) {
        report.errors.push(`could not confirm ${sourceId}: ${errorMessage(e)}`);
      }
    }
  }

  report.apiCalls = client.apiCalls;
  return report;
}

async function runStage(report: SyncReport, client: GithubClient, dryRun: boolean, label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    report.partial = true;
    report.errors.push(`${label}: ${errorMessage(e)}`);
    client.discardEtagCache();
    return;
  }
  // paginated() and the loops above stop quietly once the client trips its rate-limit floor
  // (so partial results are still upserted); the sync as a whole must still be marked partial
  // so the disappearance sweep below does not run against an incomplete picture.
  if (client.rateLimited && !report.partial) {
    report.partial = true;
    report.errors.push(client.rateLimitReason ?? 'rate limited');
  }
  // The ETag(s) staged by this stage's paginated() call(s) are only worth remembering once the
  // items they describe made it into the store, and never in a dry run (which writes nothing).
  if (dryRun || report.partial) client.discardEtagCache();
  else client.commitEtagCache();
}

function errorMessage(e: unknown): string {
  if (e instanceof GithubRateLimitStop) return `rate limited: ${e.message}`;
  if (e instanceof GithubRequestError) return `HTTP ${e.status}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------- single-item refresh

export interface RefreshContext {
  fullName: string;
  owner: string;
  repo: string;
  number: number;
  projectId: string | null;
  viewerLogin: string;
}

export type ItemOutcome = UpsertResult['action'] | 'gone' | undefined;
export interface RefreshResult { plain: ItemOutcome; review: ItemOutcome; attention: ItemOutcome }

/**
 * Re-derives the current truth for one issue/PR number and applies it: upserts whichever of
 * the three item kinds (plain/review/attention) currently apply, and marks gone whichever no
 * longer do but are still active in the DB. Shared by the disappearance sweep and the webhook.
 */
export async function refreshItem(store: Store, client: GithubClient, ctx: RefreshContext, opts: { dryRun?: boolean } = {}): Promise<RefreshResult> {
  const dryRun = opts.dryRun ?? false;
  const activeIds = new Set(store.activeSourceIds('github'));
  const result: RefreshResult = { plain: undefined, review: undefined, attention: undefined };

  const issue = await client.getOrNull<GithubIssue>(`/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.number}`);
  if (!issue) {
    result.plain = await clearIfActive(store, `${ctx.fullName}#${ctx.number}`, activeIds, dryRun);
    result.review = await clearIfActive(store, `${ctx.fullName}#${ctx.number}:review`, activeIds, dryRun);
    result.attention = await clearIfActive(store, `${ctx.fullName}#${ctx.number}:attention`, activeIds, dryRun);
    return result;
  }

  const isOpen = issue.state === 'open';
  const assignedToViewer = (issue.assignees ?? []).some((a) => a.login === ctx.viewerLogin);
  const openedByOther = issue.user?.login !== undefined && issue.user.login !== ctx.viewerLogin;
  const plainApplies = isOpen && (assignedToViewer || (!isPullRequest(issue) && openedByOther && ctx.projectId != null));
  result.plain = await applyOrClear(store, `${ctx.fullName}#${ctx.number}`, plainApplies,
    () => buildPlainItem(ctx.fullName, issue, ctx.projectId), activeIds, dryRun);

  if (isPullRequest(issue)) {
    const pr = await client.getOrNull<GithubPull>(`/repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.number}`);
    if (pr) {
      const reviewRequested = isOpen && (pr.requested_reviewers ?? []).some((r) => r.login === ctx.viewerLogin);
      result.review = await applyOrClear(store, `${ctx.fullName}#${ctx.number}:review`, reviewRequested,
        () => buildReviewItem(ctx.fullName, pr, ctx.projectId), activeIds, dryRun);

      const isOwnPr = pr.user?.login === ctx.viewerLogin;
      const reason = isOpen && isOwnPr ? await checkAttention(client, ctx.owner, ctx.repo, pr) : null;
      result.attention = await applyOrClear(store, `${ctx.fullName}#${ctx.number}:attention`, reason != null,
        () => buildAttentionItem(ctx.fullName, pr, ctx.projectId, reason ?? ''), activeIds, dryRun);
    }
  } else {
    result.review = await clearIfActive(store, `${ctx.fullName}#${ctx.number}:review`, activeIds, dryRun);
    result.attention = await clearIfActive(store, `${ctx.fullName}#${ctx.number}:attention`, activeIds, dryRun);
  }
  return result;
}

async function applyOrClear(
  store: Store, sourceId: string, applies: boolean, buildItem: () => SourceItem, activeIds: Set<string>, dryRun: boolean,
): Promise<ItemOutcome> {
  if (applies) return dryRun ? previewUpsert(store, buildItem()) : store.upsertFromSource(buildItem(), 'system').action;
  return clearIfActive(store, sourceId, activeIds, dryRun);
}

async function clearIfActive(store: Store, sourceId: string, activeIds: Set<string>, dryRun: boolean): Promise<ItemOutcome> {
  if (!activeIds.has(sourceId)) return undefined;
  if (!dryRun) store.markSourceGone('github', sourceId, 'complete', 'system');
  return 'gone';
}

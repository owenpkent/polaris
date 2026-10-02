// Maps Polaris projects to GitHub repos through each project's own github URL. Nothing
// local is read: the fallback to a clone's origin remote was removed on 2026-09-20.
import type { Project } from '../../core/index.ts';

export interface RepoMapping {
  owner: string;
  repo: string;
  fullName: string;
  projectId: string;
  slug: string;
}

export function parseGithubUrl(url: string): { owner: string; repo: string } | null {
  const trimmed = url.trim();
  // https://github.com/owner/repo(.git)?, git@github.com:owner/repo.git, ssh://git@github.com/owner/repo.git
  const m = trimmed.match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(\.git)?\/?$/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

/**
 * Map tracked projects to GitHub repos. A project without a github URL is skipped (no error:
 * not every project lives on GitHub). Async only because its callers await it.
 */
export async function mapProjectsToRepos(projects: Project[]): Promise<RepoMapping[]> {
  const out: RepoMapping[] = [];
  for (const p of projects) {
    if (!p.github) continue;
    const parsed = parseGithubUrl(p.github);
    if (!parsed) continue;
    out.push({ owner: parsed.owner, repo: parsed.repo, fullName: `${parsed.owner}/${parsed.repo}`, projectId: p.id, slug: p.slug });
  }
  return out;
}

export function repoFullNameFromItem(item: { repository_url?: string; repository?: { full_name?: string } }): string | null {
  if (item.repository?.full_name) return item.repository.full_name;
  if (item.repository_url) {
    const m = item.repository_url.match(/repos\/([^/]+\/[^/]+)$/);
    if (m) return m[1];
  }
  return null;
}

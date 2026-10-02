// Turning a GitHub repo into a Polaris project, and back. A repo the GitHub App can see is
// not a project until the owner switches it on from the dashboard's GitHub page. Switching it off
// archives the project, so its tasks keep a home and switching it on again brings it back.
// Only the issue and checklist syncs of tracked repos run, because both start from the projects
// that have a github URL (see mapping.ts and repoFiles.ts).
import { ValidationError, type Actor, type Project, type Store } from '../../core/index.ts';
import { parseGithubUrl } from './mapping.ts';

const FULL_NAME = /^[\w.-]+\/[\w.-]+$/;

/** The project for a repo, archived or not, matched on the project's own github URL without regard to case. */
export function findProjectForRepo(store: Store, fullName: string, opts: { includeArchived: boolean }): Project | undefined {
  const lower = fullName.toLowerCase();
  return store.listProjects({ includeArchived: opts.includeArchived }).find((p) => {
    const parsed = p.github ? parseGithubUrl(p.github) : null;
    return parsed != null && `${parsed.owner}/${parsed.repo}`.toLowerCase() === lower;
  });
}

export function setRepoTracked(store: Store, fullName: string, tracked: boolean, actor: Actor = 'human'): Project | null {
  if (!FULL_NAME.test(fullName)) throw new ValidationError(`not an owner/repo name: ${fullName}`);
  const existing = findProjectForRepo(store, fullName, { includeArchived: true });

  if (!tracked) {
    if (!existing) return null;
    return existing.archived ? existing : store.updateProject(existing.id, { archived: true }, actor);
  }
  if (existing) return existing.archived ? store.updateProject(existing.id, { archived: false }, actor) : existing;

  const [owner, repo] = fullName.split('/');
  const github = `https://github.com/${owner}/${repo}`;
  // The repo name is the project name. When a project with that name already exists (one with no
  // repo, or another owner's repo of the same name), the owner is added so the slug is new.
  const name = store.findProject(repo) ? `${repo} (${owner})` : repo;
  return store.createProject({ name, github }, actor);
}

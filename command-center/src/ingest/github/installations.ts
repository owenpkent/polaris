// Thin, uncached GET wrappers around the two "installations for the signed-in user" endpoints.
// Deliberately not routed through GithubClient: that class is built around the ETag cache used by
// the polling sync, and these calls are small, infrequent (dashboard status/repo-picker page),
// and always need a live answer.
export interface GithubInstallation {
  id: number;
  account: { login: string; type: string };
  repository_selection: string;
  html_url: string;
}

export interface GithubInstallationRepo {
  full_name: string;
  private: boolean;
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'constellation-command-center',
  };
}

/** GET /user/installations: every installation of any app the signed-in user can access. */
export async function fetchUserInstallations(token: string, fetchImpl: typeof fetch = fetch): Promise<GithubInstallation[]> {
  const res = await fetchImpl('https://api.github.com/user/installations?per_page=100', { headers: ghHeaders(token) });
  if (!res.ok) throw new Error(`GitHub ${res.status} listing installations`);
  const json = (await res.json()) as { installations?: GithubInstallation[] };
  return json.installations ?? [];
}

/** GET /user/installations/{id}/repositories, followed to the end. */
export async function fetchInstallationRepos(token: string, installationId: number, fetchImpl: typeof fetch = fetch): Promise<GithubInstallationRepo[]> {
  const out: GithubInstallationRepo[] = [];
  let page = 1;
  for (;;) {
    const res = await fetchImpl(
      `https://api.github.com/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
      { headers: ghHeaders(token) },
    );
    if (!res.ok) throw new Error(`GitHub ${res.status} listing repos for installation ${installationId}`);
    const json = (await res.json()) as { repositories?: GithubInstallationRepo[] };
    const repos = json.repositories ?? [];
    out.push(...repos);
    if (repos.length < 100) break;
    page++;
  }
  return out;
}

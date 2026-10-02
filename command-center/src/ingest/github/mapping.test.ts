import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../../core/index.ts';
import { mapProjectsToRepos, parseGithubUrl, repoFullNameFromItem } from './mapping.ts';

test('parseGithubUrl handles https, ssh, and .git suffixes', () => {
  assert.deepEqual(parseGithubUrl('https://github.com/owenpkent/Octavium'), { owner: 'owenpkent', repo: 'Octavium' });
  assert.deepEqual(parseGithubUrl('https://github.com/example-org/sample-repo.git'), { owner: 'example-org', repo: 'sample-repo' });
  assert.deepEqual(parseGithubUrl('git@github.com:owenpkent/MacroVox.git'), { owner: 'owenpkent', repo: 'MacroVox' });
  assert.deepEqual(parseGithubUrl('ssh://git@github.com/owenpkent/alpha-osk.git'), { owner: 'owenpkent', repo: 'alpha-osk' });
  assert.equal(parseGithubUrl('https://gitlab.com/owner/repo'), null);
});

test('mapProjectsToRepos maps projects with a github URL, skips projects without one', async () => {
  const s = openStore(':memory:');
  const withGithub = s.upsertProject({ slug: 'octavium', name: 'Octavium', github: 'https://github.com/owenpkent/Octavium' });
  s.upsertProject({ slug: 'sample-repo', name: 'Sample repo', path: 'C:\\dev\\sample-repo' });
  s.upsertProject({ slug: 'no-path-no-github', name: 'Bare' });

  const mappings = await mapProjectsToRepos(s.listProjects());

  assert.deepEqual(mappings.map((m) => m.fullName), ['owenpkent/Octavium']);
  assert.equal(mappings.find((m) => m.slug === 'octavium')?.projectId, withGithub.id);
});

test('mapProjectsToRepos does not map a project that has a path but no github URL', async () => {
  const s = openStore(':memory:');
  s.upsertProject({ slug: 'sample-repo', name: 'Sample repo', path: 'C:\\dev\\sample-repo' });

  const mappings = await mapProjectsToRepos(s.listProjects());

  assert.deepEqual(mappings, []);
});

test('repoFullNameFromItem reads repository.full_name or parses repository_url', () => {
  assert.equal(repoFullNameFromItem({ repository: { full_name: 'owenpkent/Octavium' } }), 'owenpkent/Octavium');
  assert.equal(repoFullNameFromItem({ repository_url: 'https://api.github.com/repos/example-org/sample-repo' }), 'example-org/sample-repo');
  assert.equal(repoFullNameFromItem({}), null);
});

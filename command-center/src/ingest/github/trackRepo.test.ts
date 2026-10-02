import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, ValidationError } from '../../core/index.ts';
import { findProjectForRepo, setRepoTracked } from './trackRepo.ts';

const fresh = () => openStore(':memory:');

test('setRepoTracked: tracked=true with no existing project creates one named after the repo', () => {
  const store = fresh();
  const project = setRepoTracked(store, 'owenpkent/Octavium', true)!;
  assert.equal(project.name, 'Octavium');
  assert.equal(project.github, 'https://github.com/owenpkent/Octavium');
  assert.equal(project.archived, false);
});

test('setRepoTracked: a name collision with an existing project becomes "repo (owner)"', () => {
  const store = fresh();
  store.createProject({ name: 'Octavium' }); // a project with no repo, same name
  const project = setRepoTracked(store, 'owenpkent/Octavium', true)!;
  assert.equal(project.name, 'Octavium (owenpkent)');
  assert.equal(project.github, 'https://github.com/owenpkent/Octavium');
});

test('setRepoTracked and findProjectForRepo match owner/repo case-insensitively', () => {
  const store = fresh();
  setRepoTracked(store, 'owenpkent/Octavium', true);
  const found = findProjectForRepo(store, 'OwenPKent/OCTAVIUM', { includeArchived: false });
  assert.equal(found?.name, 'Octavium');

  const untracked = setRepoTracked(store, 'OWENPKENT/octavium', false)!;
  assert.equal(untracked.archived, true);
});

test('setRepoTracked: tracked=false archives the project and keeps its tasks', () => {
  const store = fresh();
  const project = setRepoTracked(store, 'owenpkent/Octavium', true)!;
  const task = store.createTask({ title: 'Fix the thing', projectId: project.id });

  const archived = setRepoTracked(store, 'owenpkent/Octavium', false)!;
  assert.equal(archived.id, project.id);
  assert.equal(archived.archived, true);
  assert.equal(store.getTask(task.id)?.projectId, project.id);
});

test('setRepoTracked: tracking again un-archives the same project, no duplicate', () => {
  const store = fresh();
  const project = setRepoTracked(store, 'owenpkent/Octavium', true)!;
  setRepoTracked(store, 'owenpkent/Octavium', false);
  const retracked = setRepoTracked(store, 'owenpkent/Octavium', true)!;

  assert.equal(retracked.id, project.id);
  assert.equal(retracked.archived, false);
  assert.equal(store.listProjects({ includeArchived: true }).filter((p) => p.github === 'https://github.com/owenpkent/Octavium').length, 1);
});

test('setRepoTracked: tracked=false with no matching project returns null and creates nothing', () => {
  const store = fresh();
  const result = setRepoTracked(store, 'owenpkent/never-tracked', false);
  assert.equal(result, null);
  assert.equal(store.listProjects({ includeArchived: true }).length, 0);
});

test('setRepoTracked: an invalid owner/repo string throws ValidationError', () => {
  const store = fresh();
  assert.throws(() => setRepoTracked(store, 'not-a-full-name', true), ValidationError);
  assert.throws(() => setRepoTracked(store, '', true), ValidationError);
});

test('setRepoTracked: the actor is recorded on the project.upserted event', () => {
  const store = fresh();
  const before = store.lastEventId();
  setRepoTracked(store, 'owenpkent/Octavium', true, 'human');
  const events = store.eventsSince(before).filter((e) => e.kind === 'project.upserted');
  assert.equal(events.length, 1);
  assert.equal(events[0].actor, 'human');
});

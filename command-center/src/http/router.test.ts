import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter, type RouteContext } from './router.ts';

const noop = () => {};

test('matches a static route', () => {
  const r = createRouter();
  r.add('GET', '/api/health', noop);
  const result = r.find('GET', '/api/health');
  assert.equal(result.kind, 'match');
});

test('matches a single :param segment and decodes it', () => {
  const r = createRouter();
  r.add('GET', '/api/tasks/:id', noop);
  const result = r.find('GET', '/api/tasks/abc%20def');
  assert.equal(result.kind, 'match');
  if (result.kind === 'match') assert.deepEqual(result.params, { id: 'abc def' });
});

test('matches multiple :param segments in the same route', () => {
  const r = createRouter();
  r.add('DELETE', '/api/tasks/:id/dependencies/:blockerId', noop);
  const result = r.find('DELETE', '/api/tasks/t1/dependencies/b1');
  assert.equal(result.kind, 'match');
  if (result.kind === 'match') assert.deepEqual(result.params, { id: 't1', blockerId: 'b1' });
});

test('method is matched case-insensitively', () => {
  const r = createRouter();
  r.add('get', '/api/health', noop);
  const result = r.find('GET', '/api/health');
  assert.equal(result.kind, 'match');
});

test('an unknown path is not_found', () => {
  const r = createRouter();
  r.add('GET', '/api/health', noop);
  const result = r.find('GET', '/api/nope');
  assert.equal(result.kind, 'not_found');
});

test('a known path with the wrong method is method_not_allowed and lists the allowed methods', () => {
  const r = createRouter();
  r.add('GET', '/api/tasks/:id', noop);
  r.add('PATCH', '/api/tasks/:id', noop);
  const result = r.find('DELETE', '/api/tasks/t1');
  assert.equal(result.kind, 'method_not_allowed');
  if (result.kind === 'method_not_allowed') assert.deepEqual([...result.methods].sort(), ['GET', 'PATCH']);
});

test('leading and trailing slashes are ignored (segments are split on non-empty parts)', () => {
  const r = createRouter();
  r.add('GET', '/api/health', noop);
  assert.equal(r.find('GET', '/api/health/').kind, 'match');
  assert.equal(r.find('GET', 'api/health').kind, 'match');
});

test('repeated internal slashes collapse because splitPath filters empty segments', () => {
  const r = createRouter();
  r.add('GET', '/api/health', noop);
  // splitPath uses .filter(Boolean), so consecutive slashes produce no empty segments to filter
  // away in the first place -- "//api//health//" splits to ["", "api", "", "health", "", ""],
  // and after filtering empty strings this is exactly ["api", "health"], which does match.
  const result = r.find('GET', '//api//health//');
  assert.equal(result.kind, 'match');
});

test('segment count must match exactly: a shorter or longer path does not match', () => {
  const r = createRouter();
  r.add('GET', '/api/tasks/:id', noop);
  assert.equal(r.find('GET', '/api/tasks').kind, 'not_found');
  assert.equal(r.find('GET', '/api/tasks/t1/extra').kind, 'not_found');
});

test('a literal segment does not match a differing literal even with the same length', () => {
  const r = createRouter();
  r.add('GET', '/api/projects', noop);
  assert.equal(r.find('GET', '/api/tasks').kind, 'not_found');
});

test('the empty path matches a route with no segments', () => {
  const r = createRouter();
  r.add('GET', '/', noop);
  const result = r.find('GET', '/');
  assert.equal(result.kind, 'match');
  if (result.kind === 'match') assert.deepEqual(result.params, {});
});

test('routes are matched in registration order: the first match wins', () => {
  const r = createRouter();
  let which = '';
  r.add('GET', '/api/:thing', () => { which = 'generic'; });
  r.add('GET', '/api/health', () => { which = 'specific'; });
  const result = r.find('GET', '/api/health');
  assert.equal(result.kind, 'match');
  if (result.kind === 'match') {
    result.handler({} as RouteContext);
    // The generic ":thing" route was registered first and also matches "/api/health", so it wins.
    assert.equal(which, 'generic');
  }
});

test('method_not_allowed still reports every distinct method registered for the path, without duplicates', () => {
  const r = createRouter();
  r.add('GET', '/api/rules/:id', noop);
  r.add('GET', '/api/rules/:id', noop); // registered twice
  r.add('PATCH', '/api/rules/:id', noop);
  const result = r.find('DELETE', '/api/rules/r1');
  assert.equal(result.kind, 'method_not_allowed');
  if (result.kind === 'method_not_allowed') assert.deepEqual([...result.methods].sort(), ['GET', 'PATCH']);
});

test('a route with no params returns an empty params object on match', () => {
  const r = createRouter();
  r.add('GET', '/api/inbox', noop);
  const result = r.find('GET', '/api/inbox');
  assert.equal(result.kind, 'match');
  if (result.kind === 'match') assert.deepEqual(result.params, {});
});

test('a :param segment can be an empty string only via trailing slash collapse, never literally empty', () => {
  const r = createRouter();
  r.add('GET', '/api/tasks/:id', noop);
  // "/api/tasks//" splits to ["api", "tasks"] (2 segments), which does not match a 3-segment
  // pattern, so this is not_found rather than a match with id === "".
  const result = r.find('GET', '/api/tasks//');
  assert.equal(result.kind, 'not_found');
});

test('find does not mutate registered routes between calls', () => {
  const r = createRouter();
  r.add('GET', '/api/health', noop);
  r.find('GET', '/api/health');
  const second = r.find('GET', '/api/health');
  assert.equal(second.kind, 'match');
});

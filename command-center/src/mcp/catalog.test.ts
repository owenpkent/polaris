import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_CATALOG } from './catalog.ts';

// The tools known to mutate state (create/update/complete/move/accept/reject/create/run a rule).
// A tool name appearing here must be marked readonly:false in the catalog, and vice versa.
const WRITE_TOOL_NAMES = new Set([
  'create_task',
  'update_task',
  'complete_task',
  'move_task',
  'accept_inbox_item',
  'reject_inbox_item',
  'create_rule',
  'run_rule',
  'create_goal',
  'update_goal',
  'link_goal',
  'create_project',
]);

test('the catalog is non-empty', () => {
  assert.ok(TOOL_CATALOG.length > 0);
});

test('every entry has a well-formed name, description, and readonly flag', () => {
  for (const entry of TOOL_CATALOG) {
    assert.equal(typeof entry.name, 'string');
    assert.ok(entry.name.length > 0, 'name must be non-empty');
    assert.match(entry.name, /^[a-z][a-z_]*[a-z]$/, `name "${entry.name}" should be snake_case`);
    assert.equal(typeof entry.description, 'string');
    assert.ok(entry.description.length > 0, `description for ${entry.name} must be non-empty`);
    assert.equal(typeof entry.readonly, 'boolean');
  }
});

test('tool names are unique', () => {
  const names = TOOL_CATALOG.map((e) => e.name);
  assert.equal(new Set(names).size, names.length);
});

test('no description contains emoji or an em dash (repo style rules)', () => {
  for (const entry of TOOL_CATALOG) {
    assert.ok(!/—/.test(entry.description), `em dash in ${entry.name}`);
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(entry.description), `emoji in ${entry.name}`);
    assert.ok(!/\b(AI|assistant|claude)\b/i.test(entry.description), `AI mention in ${entry.name}`);
  }
});

test('every known write-tool name is marked readonly:false, and no others are', () => {
  for (const entry of TOOL_CATALOG) {
    assert.equal(entry.readonly, !WRITE_TOOL_NAMES.has(entry.name), `${entry.name} readonly flag mismatch`);
  }
});

test('the read-only subset of the catalog contains none of the known write tools', () => {
  const readonlyNames = new Set(TOOL_CATALOG.filter((e) => e.readonly).map((e) => e.name));
  for (const writeName of WRITE_TOOL_NAMES) {
    assert.ok(!readonlyNames.has(writeName), `${writeName} leaked into the readonly set`);
  }
});

test('the write subset is exactly the known write tools, nothing more or less', () => {
  const writeNames = TOOL_CATALOG.filter((e) => !e.readonly).map((e) => e.name).sort();
  assert.deepEqual(writeNames, [...WRITE_TOOL_NAMES].sort());
});

test('create_rule is a write tool, and its description documents that rules are saved disabled', () => {
  const entry = TOOL_CATALOG.find((e) => e.name === 'create_rule');
  assert.ok(entry);
  assert.equal(entry!.readonly, false);
  assert.match(entry!.description, /disabled/i);
  assert.match(entry!.description, /the owner must enable/i);
});

test('run_rule documents that it dry-runs by default (propose, do not act)', () => {
  const entry = TOOL_CATALOG.find((e) => e.name === 'run_rule');
  assert.ok(entry);
  assert.match(entry!.description, /[Dd]ry run/);
});

test('accept_inbox_item and reject_inbox_item exist and are write tools (inbox items require an explicit human decision)', () => {
  for (const name of ['accept_inbox_item', 'reject_inbox_item']) {
    const entry = TOOL_CATALOG.find((e) => e.name === name);
    assert.ok(entry, `${name} missing from catalog`);
    assert.equal(entry!.readonly, false);
  }
});

test('the expected read-only search/list/get tools are present and marked readonly', () => {
  for (const name of ['search_tasks', 'get_task', 'list_projects', 'list_sections', 'get_view', 'list_inbox', 'list_goals', 'get_goal']) {
    const entry = TOOL_CATALOG.find((e) => e.name === name);
    assert.ok(entry, `${name} missing from catalog`);
    assert.equal(entry!.readonly, true);
  }
});

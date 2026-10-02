import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTokens } from './token.ts';

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'cc-token-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('creates all three token files on first use when no env vars are set', () => {
  withTempDir((dir) => {
    const dbPath = join(dir, 'constellation.db');
    const tokens = resolveTokens(dbPath, {});
    assert.equal(typeof tokens.api, 'string');
    assert.equal(typeof tokens.mcp, 'string');
    assert.equal(typeof tokens.mcpReadonly, 'string');
    assert.ok(tokens.api.length > 0);
    assert.ok(tokens.mcp.length > 0);
    assert.ok(tokens.mcpReadonly.length > 0);

    assert.equal(readFileSync(join(dir, 'api-token'), 'utf8'), tokens.api);
    assert.equal(readFileSync(join(dir, 'mcp-token'), 'utf8'), tokens.mcp);
    assert.equal(readFileSync(join(dir, 'mcp-readonly-token'), 'utf8'), tokens.mcpReadonly);
  });
});

test('the three generated tokens are distinct from each other', () => {
  withTempDir((dir) => {
    const tokens = resolveTokens(join(dir, 'db.sqlite'), {});
    assert.notEqual(tokens.api, tokens.mcp);
    assert.notEqual(tokens.api, tokens.mcpReadonly);
    assert.notEqual(tokens.mcp, tokens.mcpReadonly);
  });
});

test('a generated token is 32 random bytes, base64url-encoded (43 chars, no padding)', () => {
  withTempDir((dir) => {
    const tokens = resolveTokens(join(dir, 'db.sqlite'), {});
    for (const t of [tokens.api, tokens.mcp, tokens.mcpReadonly]) {
      assert.equal(t.length, 43);
      assert.match(t, /^[A-Za-z0-9_-]+$/);
    }
  });
});

test('reuses an existing token file instead of generating a new one', () => {
  withTempDir((dir) => {
    const dbPath = join(dir, 'db.sqlite');
    const first = resolveTokens(dbPath, {});
    const second = resolveTokens(dbPath, {});
    assert.equal(first.api, second.api);
    assert.equal(first.mcp, second.mcp);
    assert.equal(first.mcpReadonly, second.mcpReadonly);
  });
});

test('an env var takes priority over an existing file and is not written to disk', () => {
  withTempDir((dir) => {
    const dbPath = join(dir, 'db.sqlite');
    // First create a file-backed token.
    const first = resolveTokens(dbPath, {});
    // Now resolve again with an explicit env override for just the api token.
    const second = resolveTokens(dbPath, { CC_API_TOKEN: 'explicit-env-token' });
    assert.equal(second.api, 'explicit-env-token');
    // The other two are unaffected and still reused from disk.
    assert.equal(second.mcp, first.mcp);
    assert.equal(second.mcpReadonly, first.mcpReadonly);
    // The on-disk api-token file was never overwritten with the env value.
    assert.equal(readFileSync(join(dir, 'api-token'), 'utf8'), first.api);
  });
});

test('each env var independently overrides only its own token', () => {
  withTempDir((dir) => {
    const dbPath = join(dir, 'db.sqlite');
    const tokens = resolveTokens(dbPath, {
      CC_API_TOKEN: 'api-env',
      CC_MCP_TOKEN: 'mcp-env',
      CC_MCP_READONLY_TOKEN: 'readonly-env',
    });
    assert.deepEqual(tokens, { api: 'api-env', mcp: 'mcp-env', mcpReadonly: 'readonly-env' });
  });
});

test('an empty string env var is treated as unset and falls through to a generated/file token', () => {
  withTempDir((dir) => {
    const dbPath = join(dir, 'db.sqlite');
    const tokens = resolveTokens(dbPath, { CC_API_TOKEN: '' });
    assert.ok(tokens.api.length > 0);
    assert.notEqual(tokens.api, '');
  });
});

test('an existing but empty token file is treated as missing and regenerated', () => {
  withTempDir((dir) => {
    const dbPath = join(dir, 'db.sqlite');
    // Pre-create the directory and an empty (whitespace-only) file.
    resolveTokens(dbPath, { CC_API_TOKEN: 'placeholder' }); // ensures the dir exists
    writeFileSync(join(dir, 'mcp-token'), '   \n', 'utf8');
    const tokens = resolveTokens(dbPath, {});
    assert.ok(tokens.mcp.trim().length > 0);
    assert.notEqual(tokens.mcp, '');
  });
});

test('tokens are resolved relative to the directory containing the db path, not the db path itself', () => {
  withTempDir((dir) => {
    const nested = join(dir, 'nested', 'sub');
    const dbPath = join(nested, 'constellation.db');
    const tokens = resolveTokens(dbPath, {});
    assert.equal(readFileSync(join(nested, 'api-token'), 'utf8'), tokens.api);
  });
});

test('resolveTokens creates the directory if it does not exist yet', () => {
  withTempDir((dir) => {
    const dbPath = join(dir, 'does', 'not', 'exist', 'yet', 'db.sqlite');
    const tokens = resolveTokens(dbPath, {});
    assert.ok(tokens.api.length > 0);
  });
});

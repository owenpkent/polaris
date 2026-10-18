// Local API bearer tokens: three independent tokens, one per trust boundary (see ApiTokens in
// types.ts for why). Each is CC_*_TOKEN if set, else a 32-byte random base64url token persisted
// in its own file next to the database (created on first use, restrictive permissions where the
// OS supports them). Never logged except via `serve --show-token`.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ApiTokens } from './types.ts';

function resolveOneToken(dir: string, envValue: string | undefined, filename: string): string {
  if (envValue) return envValue;
  const file = join(dir, filename);
  const readExisting = (): string => {
    try {
      return readFileSync(file, 'utf8').trim();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw e;
    }
  };
  const existing = readExisting();
  if (existing) return existing;
  mkdirSync(dir, { recursive: true });
  const token = randomBytes(32).toString('base64url');
  try {
    // 'wx' fails if the file exists, so two processes cannot both create it. mode 0o600 is honored
    // on POSIX; Windows has no equivalent bit but the call is harmless.
    writeFileSync(file, token, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return token;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    // Another process created it first: use what it wrote. An empty file is replaced.
    const other = readExisting();
    if (other) return other;
    writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 });
    return token;
  }
}

export function resolveTokens(dbPath: string, env: NodeJS.ProcessEnv = process.env): ApiTokens {
  const dir = dirname(dbPath);
  return {
    api: resolveOneToken(dir, env.CC_API_TOKEN, 'api-token'),
    mcp: resolveOneToken(dir, env.CC_MCP_TOKEN, 'mcp-token'),
    mcpReadonly: resolveOneToken(dir, env.CC_MCP_READONLY_TOKEN, 'mcp-readonly-token'),
  };
}

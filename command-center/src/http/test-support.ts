// Shared test helpers for src/http/*.test.ts. Not itself a *.test.ts file, so `node --test`
// never picks it up directly.
import { memorySecretStore } from '../ingest/secrets.ts';
import type { Server } from 'node:http';
import type { App } from '../app.ts';
import { openStore } from '../core/index.ts';
import { createHttpServer } from './server.ts';
import type { ApiTokens, HttpServerOptions } from './types.ts';

// Three distinct tokens, matching the three real trust boundaries (see ApiTokens in types.ts).
// Keeping them visibly different values means a test that accidentally reuses the wrong one
// fails loudly instead of passing by coincidence.
export const TEST_TOKENS: ApiTokens = {
  api: 'test-api-token-0000000000000000',
  mcp: 'test-mcp-token-1111111111111111',
  mcpReadonly: 'test-mcp-readonly-token-22222222',
};

/** The REST /api token. Most tests only ever talk to /api, so this alias keeps them short. */
export const TEST_TOKEN = TEST_TOKENS.api;

/** An in-memory App with a deterministic clock, matching the pattern used by src/mcp/tools.test.ts. */
export function fakeApp(today = '2026-09-12'): App {
  let tick = 0;
  const store = openStore(':memory:', {
    now: () => new Date(Date.UTC(2026, 8, 12, 12, 0, tick++)).toISOString(),
    nextOccurrence: (_rrule: string, prev: string) => {
      const d = new Date(`${prev.slice(0, 10)}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 7);
      return d.toISOString().slice(0, 10);
    },
  });
  return {
    config: { repoRoot: '', dbPath: ':memory:', timezone: 'UTC', dashboardDir: '' },
    store,
    secrets: memorySecretStore(),
    today: () => today,
    close: () => store.db.close(),
  };
}

export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TEST_TOKENS.api}`, ...extra };
}

export function mcpAuthHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TEST_TOKENS.mcp}`, ...extra };
}

export function mcpReadonlyAuthHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TEST_TOKENS.mcpReadonly}`, ...extra };
}

// The ports fetch refuses to connect to ("bad port" in the Fetch Standard, undici's badPorts):
// the well-known ports of other protocols. A machine whose dynamic range starts at 1024 (Windows
// with Hyper-V or Docker widens it) hands one out now and then, and every request in the test
// then fails with "fetch failed: bad port" (seen on the pre-push hook, 2026-11-01).
const FETCH_REFUSED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111,
  113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548,
  554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/** True for a port fetch would refuse to connect to, which a test server must not listen on. */
export function fetchRefusesPort(port: number): boolean {
  return FETCH_REFUSED_PORTS.has(port);
}

/** Listens on an ephemeral loopback port that fetch will connect to, and returns it. */
export async function listenForFetch(server: Server): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    if (!fetchRefusesPort(port) || attempt >= 20) return port;
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

/** Starts a createHttpServer instance on an ephemeral port, runs `fn`, then always closes it. */
export async function withServer(app: App, opts: Partial<HttpServerOptions>, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server: Server = createHttpServer(app, { tokens: TEST_TOKENS, corsOrigins: ['http://localhost:5173'], ...opts });
  const port = await listenForFetch(server);
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

/** Small JSON fetch helper: sends an api-token-authorized request and parses the (possibly empty) JSON response. */
export async function api(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; headers: Headers; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { ...authHeaders(), 'Content-Type': 'application/json' } : authHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : undefined };
}

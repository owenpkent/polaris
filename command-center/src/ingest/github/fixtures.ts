// Test-only fake fetch for the GitHub client: routes on pathname plus a subset of query
// params (so /issues?filter=assigned and /issues?filter=created can have distinct fixtures
// without caring about incidental params like per_page). Not a *.test.ts file, so
// `node --test` never tries to run it directly.

export interface FixtureRoute {
  pathname: string;
  query?: Record<string, string>;
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
  /** Remove this route after it matches once, so a later request to the same URL falls through. */
  once?: boolean;
}

export interface FakeFetch {
  fetchImpl: typeof fetch;
  calls: string[];
}

export function fakeGithubFetch(routes: FixtureRoute[]): FakeFetch {
  const calls: string[] = [];
  const pool = [...routes];
  const fetchImpl = (async (input: unknown) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}${url.search}`);
    const idx = pool.findIndex((r) => r.pathname === url.pathname && matchesQuery(r.query, url.searchParams));
    if (idx === -1) {
      return new Response(JSON.stringify({ message: `no fixture for ${url.pathname}${url.search}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    const route = pool[idx];
    if (route.once) pool.splice(idx, 1);
    const headers = new Headers(route.headers ?? {});
    const status = route.status ?? 200;
    const body = status === 304 ? null : JSON.stringify(route.json ?? []);
    return new Response(body, { status, headers });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function matchesQuery(required: Record<string, string> | undefined, actual: URLSearchParams): boolean {
  if (!required) return true;
  return Object.entries(required).every(([k, v]) => actual.get(k) === v);
}

// Minimal read-only GitHub REST client: Link-header pagination, ETag caching (via
// store.setKv/getKv so it survives across runs), and rate-limit awareness. Every method
// issues GET only. Fetch is injectable for tests.

import type { Json, Store } from '../../core/index.ts';

export class GithubRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** The contents API will not send a file over 1 MB. That is "could not read it", never "it is empty". */
export class GithubFileTooLargeError extends Error {}

/** Raised (and caught by callers) once the client has decided to stop making requests. */
export class GithubRateLimitStop extends Error {}

export interface GithubClientOptions {
  token: string;
  store: Store;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Stop issuing requests once the core API's remaining quota is at or below this. */
  rateLimitFloor?: number;
  /** Stop issuing search requests once the search API's remaining quota (per 30/min window) is at or below this. */
  searchRateLimitFloor?: number;
  log?: (line: string) => void;
}

interface RawResponse {
  status: number;
  notModified: boolean;
  json: unknown;
  link: string | null;
  etag: string | null;
}

interface CachedList {
  etag: string;
  /** JSON-shaped page items, as returned by res.json(); cast back to T[] by the caller. */
  items: Json[];
}

// Json's object case is an index signature ({[k: string]: Json}), which a named interface like
// CachedList does not structurally satisfy for generic constraint purposes even though every
// value in it is JSON-safe at runtime; these two helpers hold the one cast each side needs.
function readCachedList(store: Store, key: string): CachedList | undefined {
  return store.getKv<Json>(key) as unknown as CachedList | undefined;
}

function writeCachedList(store: Store, key: string, value: CachedList): void {
  store.setKv(key, value as unknown as Json);
}

/** Percent-encode each path segment individually so a literal "/" keeps separating directories. */
function encodePathSegments(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function parseLinkHeader(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(',')) {
    const m = part.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/);
    if (m) out[m[2]] = m[1];
  }
  return out;
}

export class GithubClient {
  apiCalls = 0;
  rateLimited = false;
  rateLimitReason: string | null = null;

  private readonly token: string;
  private readonly store: Store;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly rateLimitFloor: number;
  private readonly searchRateLimitFloor: number;
  private readonly log: (line: string) => void;
  private viewerLogin: string | undefined;
  private viewerLoginPromise: Promise<string> | undefined;
  /**
   * ETag + item-list writes staged by paginated() but not yet persisted. Kept out of the store
   * until the caller (a sync stage) confirms its upserts succeeded, and never persisted at all
   * in a dry run -- otherwise a --dry-run poisons the cache and the next real sync gets a 304
   * for a page whose items were never actually written.
   */
  private readonly pendingEtagWrites = new Map<string, CachedList>();

  constructor(opts: GithubClientOptions) {
    this.token = opts.token;
    this.store = opts.store;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = opts.baseUrl ?? 'https://api.github.com';
    this.rateLimitFloor = opts.rateLimitFloor ?? 50;
    this.searchRateLimitFloor = opts.searchRateLimitFloor ?? 3;
    this.log = opts.log ?? (() => {});
  }

  /** The authenticated user's login. Fetched once and cached. */
  async viewer(): Promise<string> {
    if (this.viewerLogin) return this.viewerLogin;
    if (!this.viewerLoginPromise) {
      this.viewerLoginPromise = this.get<{ login: string }>('/user').then((me) => {
        this.viewerLogin = me.login;
        return me.login;
      });
    }
    return this.viewerLoginPromise;
  }

  private buildUrl(path: string, params?: Record<string, string | number | undefined>): string {
    const url = new URL(path.startsWith('http') ? path : `${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  private trackRateLimit(headers: Headers, isSearch: boolean): void {
    const remainingHeader = headers.get('x-ratelimit-remaining');
    if (remainingHeader == null) return;
    const remaining = Number(remainingHeader);
    if (!Number.isFinite(remaining)) return;
    const floor = isSearch ? this.searchRateLimitFloor : this.rateLimitFloor;
    if (remaining <= floor) {
      this.rateLimited = true;
      this.rateLimitReason = `GitHub ${isSearch ? 'search API' : 'API'} rate limit low: ${remaining} remaining (floor ${floor})`;
      this.log(this.rateLimitReason);
    }
  }

  private async request(url: string, useEtag: boolean): Promise<RawResponse> {
    if (this.rateLimited) throw new GithubRateLimitStop(this.rateLimitReason ?? 'rate limited');
    const isSearch = new URL(url).pathname.startsWith('/search');
    const etagKey = `github:etag:${url}`;
    const cached = useEtag ? readCachedList(this.store, etagKey) : undefined;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'constellation-command-center',
    };
    if (cached?.etag) headers['If-None-Match'] = cached.etag;
    const res = await this.fetchImpl(url, { headers });
    this.apiCalls++;
    this.trackRateLimit(res.headers, isSearch);
    if (res.status === 304) return { status: 304, notModified: true, json: null, link: res.headers.get('link'), etag: cached?.etag ?? null };
    const newEtag = res.headers.get('etag');
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new GithubRequestError(`GitHub ${res.status} for ${url}: ${body.slice(0, 300)}`, res.status);
    }
    const json = await res.json();
    return { status: res.status, notModified: false, json, link: res.headers.get('link'), etag: newEtag };
  }

  /** Persist every ETag/item-list pair staged since the last commit or discard. Never call this from a dry run. */
  commitEtagCache(): void {
    for (const [key, value] of this.pendingEtagWrites) writeCachedList(this.store, key, value);
    this.pendingEtagWrites.clear();
  }

  /** Drop staged ETag/item-list writes without persisting them (a dry run, or a failed stage). */
  discardEtagCache(): void {
    this.pendingEtagWrites.clear();
  }

  /** Single-resource GET. Not ETag-cached (used for on-demand confirmation fetches). */
  async get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    const { json } = await this.request(this.buildUrl(path, params), false);
    return json as T;
  }

  /** GET that may 404; returns null instead of throwing in that case. */
  async getOrNull<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T | null> {
    try {
      return await this.get<T>(path, params);
    } catch (e) {
      if (e instanceof GithubRequestError && e.status === 404) return null;
      throw e;
    }
  }

  /**
   * One file's decoded text via the contents API (`/repos/{owner}/{repo}/contents/{path}`),
   * ETag-cached like paginated(). Returns null when the path does not exist (404) or is not a
   * plain file (a directory has no `content`). The write-back of the fresh ETag + decoded text
   * is staged, not persisted, until the caller confirms the file was successfully processed --
   * same discipline as paginated(), so a --dry-run or a failed stage never poisons the cache.
   */
  async getFileText(owner: string, repo: string, path: string): Promise<string | null> {
    const url = this.buildUrl(`/repos/${owner}/${repo}/contents/${encodePathSegments(path)}`);
    const cacheKey = `github:etag:${url}`;
    try {
      const { json, notModified, etag } = await this.request(url, true);
      if (notModified) {
        const cached = readCachedList(this.store, cacheKey);
        const text = cached?.items[0];
        return typeof text === 'string' ? text : null;
      }
      const body = json as { type?: string; encoding?: string; content?: string } | null;
      if (!body || body.type !== 'file' || typeof body.content !== 'string') return null;
      // Over 1 MB the contents API returns {"encoding":"none","content":""}. That is "too big to
      // send", not "empty". Returning null here would read as "no such file" to the caller, which
      // parses zero checklist items and sweeps away every task from the file, so it throws.
      if (body.encoding !== 'base64' && body.encoding !== 'utf-8' && body.encoding !== 'utf8') {
        throw new GithubFileTooLargeError(`${owner}/${repo}:${path} is too large for the GitHub contents API`);
      }
      const text = Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
      if (etag) this.pendingEtagWrites.set(cacheKey, { etag, items: [text] });
      return text;
    } catch (e) {
      if (e instanceof GithubRequestError && e.status === 404) return null;
      throw e;
    }
  }

  /**
   * Top-level directory listing via the contents API. Returns entries (name/path/type) or null
   * when the path does not exist (404) or is a file rather than a directory. ETag-cached the
   * same way as getFileText.
   */
  async listDirectory(owner: string, repo: string, path: string): Promise<{ name: string; path: string; type: string }[] | null> {
    const url = this.buildUrl(`/repos/${owner}/${repo}/contents/${encodePathSegments(path)}`);
    const cacheKey = `github:etag:${url}`;
    try {
      const { json, notModified, etag } = await this.request(url, true);
      if (notModified) {
        const cached = readCachedList(this.store, cacheKey);
        return (cached?.items as unknown as { name: string; path: string; type: string }[] | undefined) ?? null;
      }
      if (!Array.isArray(json)) return null;
      const entries = json as { name: string; path: string; type: string }[];
      if (etag) this.pendingEtagWrites.set(cacheKey, { etag, items: entries as unknown as Json[] });
      return entries;
    } catch (e) {
      if (e instanceof GithubRequestError && e.status === 404) return null;
      throw e;
    }
  }

  /**
   * Paginated list GET, following Link headers. ETag is only checked on the first page; a 304
   * there means GitHub is telling us the whole list is unchanged since the cached copy was
   * taken, so that cached item list is returned as-is instead of an empty one (an empty result
   * would make every one of those items look like it had disappeared). The write-back of the
   * fresh ETag + item list is staged, not persisted, until the caller confirms this page's
   * items were successfully upserted (see commitEtagCache/discardEtagCache) -- otherwise a
   * --dry-run, or a stage that fails partway through, would poison the cache for a page whose
   * items were never actually written.
   */
  async paginated<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<{ items: T[]; notModified: boolean }> {
    const firstUrl = this.buildUrl(path, { per_page: 100, ...params });
    const cacheKey = `github:etag:${firstUrl}`;
    const items: T[] = [];
    let url: string | null = firstUrl;
    let first = true;
    let etag: string | null = null;
    let complete = true;
    while (url) {
      const { json, notModified, link, etag: pageEtag } = await this.request(url, first);
      if (notModified && first) {
        const cached = readCachedList(this.store, cacheKey);
        return { items: (cached?.items as unknown as T[] | undefined) ?? [], notModified: true };
      }
      if (first) etag = pageEtag;
      const page = Array.isArray(json) ? json : (json as { items?: T[] } | null)?.items ?? [];
      items.push(...(page as T[]));
      url = parseLinkHeader(link).next ?? null;
      first = false;
      if (this.rateLimited) {
        complete = false;
        break;
      }
    }
    // Only stage the cache write for a fully-fetched list: a rate-limited partial fetch must
    // never be remembered as "this is the whole list" for next time.
    if (complete && etag) this.pendingEtagWrites.set(cacheKey, { etag, items: items as unknown as Json[] });
    return { items, notModified: false };
  }
}

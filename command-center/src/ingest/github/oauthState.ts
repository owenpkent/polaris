// One-time state values for the two GitHub web flows (app manifest registration, user sign-in).
// Each value is single-use (consumed on first read regardless of outcome, so a replayed callback
// never succeeds twice) and expires after a fixed TTL. In-memory only: a restart of the daemon
// invalidates any in-flight sign-in, which is fine since the whole flow completes in well under
// 10 minutes.
import { randomBytes } from 'node:crypto';

export type OAuthStateKind = 'manifest' | 'login';

interface StateEntry {
  kind: OAuthStateKind;
  codeVerifier?: string;
  createdAt: number;
}

const TTL_MS = 10 * 60_000;

export class OAuthStateStore {
  #entries = new Map<string, StateEntry>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Creates a new single-use state value of the given kind. */
  create(kind: OAuthStateKind, codeVerifier?: string): string {
    this.#sweep();
    const state = randomBytes(32).toString('base64url');
    this.#entries.set(state, { kind, codeVerifier, createdAt: this.#now() });
    return state;
  }

  /**
   * Consumes a state value: removed on first lookup no matter what, so a state can never be
   * redeemed twice. Returns the stored codeVerifier (possibly undefined) when the state exists,
   * matches `kind`, and has not expired; otherwise undefined.
   */
  consume(state: string, kind: OAuthStateKind): { codeVerifier?: string } | undefined {
    const entry = this.#entries.get(state);
    this.#entries.delete(state);
    if (!entry) return undefined;
    if (entry.kind !== kind) return undefined;
    if (this.#now() - entry.createdAt > TTL_MS) return undefined;
    return { codeVerifier: entry.codeVerifier };
  }

  /** Drops every pending state of one kind: a sign-out makes any sign-in still under way void. */
  invalidate(kind: OAuthStateKind): void {
    for (const [state, entry] of this.#entries) {
      if (entry.kind === kind) this.#entries.delete(state);
    }
  }

  #sweep(): void {
    const now = this.#now();
    for (const [state, entry] of this.#entries) {
      if (now - entry.createdAt > TTL_MS) this.#entries.delete(state);
    }
  }
}

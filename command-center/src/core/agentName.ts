// The one place that decides whether a self-declared agent name is usable. An MCP connection
// names itself (stdio's --agent-name, the HTTP X-Agent-Name header); the owner also sets a
// default agent name (kv key default_agent_name, see http/rest.ts). Both go through here so the
// two surfaces can never drift on what a valid name looks like.
//
// The name is never an identity or a permission: it only labels who to credit beside the actor in
// an event's history line or a comment's byline. An MCP caller is always recorded as actor
// 'agent' regardless of what name it gives.

import type { Store } from './store.ts';

/** kv key for the owner's default agent name, used by the dashboard's "Assign to AI" button. */
export const DEFAULT_AGENT_NAME_KEY = 'default_agent_name';
/** The default agent name until the owner sets one. */
export const DEFAULT_AGENT_NAME_FALLBACK = 'claude-code';

const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/;

/**
 * Trims `raw`, then accepts it only if it is 1 to 40 characters of letters, digits, spaces, '-',
 * '_', or '.', and starts with a letter or digit (so a name can never look like a flag). Anything else -- not a string, empty after trimming, over 40 characters, a control
 * character, punctuation outside that set -- returns null. An MCP connection that sends an
 * invalid name is simply not given one (the write is recorded with actorName null); this never
 * throws, because a malformed name must not be able to break a request.
 */
export function normalizeAgentName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  return AGENT_NAME_RE.test(name) ? name : null;
}

/**
 * Reads the name a stdio connection declared: `--agent-name <value>` or `--agent-name=<value>`.
 * The first occurrence wins. A missing value, or a next entry that starts with '--' (another
 * flag, not a value), returns null, as does a value normalizeAgentName rejects. Never throws:
 * an unusable name is simply not given, the same as an invalid X-Agent-Name header.
 */
export function agentNameFromArgv(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--agent-name') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) return null;
      return normalizeAgentName(next);
    }
    if (arg.startsWith('--agent-name=')) return normalizeAgentName(arg.slice('--agent-name='.length));
  }
  return null;
}

/** The owner's default agent name (kv default_agent_name), or 'claude-code' until one is set. */
export function defaultAgentName(store: Pick<Store, 'getKv'>): string {
  return store.getKv<string>(DEFAULT_AGENT_NAME_KEY) ?? DEFAULT_AGENT_NAME_FALLBACK;
}

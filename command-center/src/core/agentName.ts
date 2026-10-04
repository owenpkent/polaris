// The one place that decides whether a self-declared agent name is usable. An MCP connection
// names itself (stdio's --agent-name, the HTTP X-Agent-Name header); the owner also sets a
// default agent name (kv key default_agent_name, see http/rest.ts). Both go through here so the
// two surfaces can never drift on what a valid name looks like.
//
// The name is never an identity or a permission: it only labels who to credit beside the actor in
// an event's history line or a comment's byline. An MCP caller is always recorded as actor
// 'agent' regardless of what name it gives.

const AGENT_NAME_RE = /^[A-Za-z0-9 _.-]{1,40}$/;

/**
 * Trims `raw`, then accepts it only if it is 1 to 40 characters of letters, digits, spaces, '-',
 * '_', or '.'. Anything else -- not a string, empty after trimming, over 40 characters, a control
 * character, punctuation outside that set -- returns null. An MCP connection that sends an
 * invalid name is simply not given one (the write is recorded with actorName null); this never
 * throws, because a malformed name must not be able to break a request.
 */
export function normalizeAgentName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  return AGENT_NAME_RE.test(name) ? name : null;
}

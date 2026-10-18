// How many occurrences a repeating task's rule has left, and the rule with one fewer.
//
// A rule's COUNT counts the occurrences still to come, the task that carries it included: COUNT=3
// on an open task means this one and two more. Every completion and every skip uses up exactly one,
// so the store rewrites the rule as it goes (completeTask gives the next instance COUNT-1,
// skipOccurrence lowers the task's own), and COUNT=1 is the last one. The recurrence engine
// (automation/recurrence.ts) reads COUNT the same way, so this is plain text work on the one part:
// the rest of the rule, and its spelling, are left exactly as written.

const COUNT_PART = /(^(?:RRULE:)?|;)(\s*COUNT\s*=\s*)(\d+)(\s*)(?=;|$)/i;

/** The COUNT a rule carries, or null when it has none (it ends on UNTIL, or never). */
export function remainingCount(rule: string): number | null {
  const match = COUNT_PART.exec(rule.trim());
  return match ? Number(match[3]) : null;
}

/** The rule with COUNT lowered by one. A rule with no COUNT, or COUNT=1, comes back unchanged. */
export function withOneFewer(rule: string): string {
  const count = remainingCount(rule);
  if (count === null || count <= 1) return rule;
  return rule.trim().replace(COUNT_PART, (_all, lead: string, key: string, _n: string, tail: string) => `${lead}${key}${count - 1}${tail}`);
}

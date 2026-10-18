// How many occurrences a repeating task's rule has left, and the rule with one fewer.
//
// A rule's COUNT counts the occurrences still to come, the task that carries it included: COUNT=3
// on an open task means this one and two more. Every completion and every skip uses up exactly one,
// so the store rewrites the rule as it goes (completeTask gives the next instance COUNT-1,
// skipOccurrence lowers the task's own), and COUNT=1 is the last one. The recurrence engine
// (automation/recurrence.ts) reads COUNT the same way, so this is plain text work on the one part:
// the rest of the rule, and its spelling, are left exactly as written.
//
// The part is read the way rrule reads it: split on ';', the key in any case with nothing around
// it, the value in digits. Validation refuses a COUNT with a sign and any part given twice, so for
// every rule the store accepts there is one COUNT and both readings agree.

interface CountPart {
  index: number;
  key: string;
  value: number;
}

function findCount(rule: string): { pieces: string[]; part: CountPart } | null {
  const pieces = rule.trim().split(';');
  for (let index = pieces.length - 1; index >= 0; index--) {
    const [rawKey, value, ...rest] = pieces[index].split('=');
    const key = index === 0 ? rawKey.replace(/^RRULE:/i, '') : rawKey;
    if (key.toUpperCase() !== 'COUNT' || rest.length || !/^\d+$/.test(value ?? '')) continue;
    return { pieces, part: { index, key: rawKey, value: Number(value) } };
  }
  return null;
}

/** The COUNT a rule carries, or null when it has none (it ends on UNTIL, or never). */
export function remainingCount(rule: string): number | null {
  return findCount(rule)?.part.value ?? null;
}

/** The rule with COUNT lowered by one. A rule with no COUNT, or COUNT=1, comes back unchanged. */
export function withOneFewer(rule: string): string {
  const found = findCount(rule);
  if (!found || found.part.value <= 1) return rule;
  const { pieces, part } = found;
  pieces[part.index] = `${part.key}=${part.value - 1}`;
  return pieces.join(';');
}

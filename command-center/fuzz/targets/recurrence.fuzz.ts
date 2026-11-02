import { nextOccurrence, previewOccurrences } from '../../src/automation/recurrence.ts';
import { remainingCount, withOneFewer } from '../../src/core/recurrenceCount.ts';
import { isInvalidRuleError, rethrowUnless } from './expected.ts';

const DUES = ['2026-01-15', '2026-01-31', '2024-02-29', '2026-01-15T09:30', '2026-12-31T23:59:00Z'];
const DATE = /^\d{4}-\d{2}-\d{2}/;

// Recurrence rules are typed by the owner or sent by an agent, and expanded on every task write on
// the request thread. The first byte picks the previous due date; the rest is the rule. The rule
// must give a date, end the series (null), or be refused with an "invalid ..." error, and finish
// in bounded time: the per-input timeout catches a walk that does not. A next date is never on or
// before the previous due date, and lowering COUNT by one lowers it by exactly one.
export function fuzz(data: Buffer): void {
  const previous = DUES[(data[0] ?? 0) % DUES.length];
  const rule = data.subarray(1).toString('utf8');
  const today = previous.slice(0, 10);
  try {
    const next = nextOccurrence(rule, previous, today);
    if (next !== null) {
      if (!DATE.test(next)) throw new Error(`next is not a date: ${JSON.stringify(next)}`);
      if (next.slice(0, 10) <= today) throw new Error(`next ${next} is not after ${previous} for ${JSON.stringify(rule)}`);
    }
    const dates = previewOccurrences(rule, previous, today, 4);
    for (let i = 1; i < dates.length; i++) {
      if (dates[i].slice(0, 10) <= dates[i - 1].slice(0, 10)) throw new Error(`preview not increasing: ${dates.join(', ')} for ${JSON.stringify(rule)}`);
    }
  } catch (err) {
    rethrowUnless(err, isInvalidRuleError);
  }
  const left = remainingCount(rule);
  const fewer = withOneFewer(rule);
  if (left === null || left <= 1) {
    if (fewer !== rule) throw new Error(`withOneFewer changed a rule with COUNT ${left}: ${JSON.stringify(rule)}`);
  } else if (remainingCount(fewer) !== left - 1) {
    throw new Error(`withOneFewer went from ${left} to ${remainingCount(fewer)}: ${JSON.stringify(rule)}`);
  }
}

// CONTRACT (implemented in Phase 4). Other modules import only from this file.
// Implementations live in sibling files; this barrel re-exports them under the names and
// signatures fixed below so nothing outside automation/ needs to know about the split.

/** 'YYYY-MM-DD' for now in the given IANA timezone. */
export function todayIn(timezone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export { nextOccurrence } from './recurrence.ts';

export { builtinViews, runView, type ViewDefinition, type ViewResult } from './views.ts';

export {
  validateRuleDefinition, runRules, listNotifications,
  type RuleValidation, type RuleRunReport, type RuleDefinition, type RuleTrigger, type RuleCondition, type RuleAction, type RuleNotification,
} from './rules.ts';

export { buildDigest, markDigestDelivered, type Digest } from './digest.ts';

export { createScheduler, type Scheduler, type SchedulerOptions, type JobSpec, type JobResult } from './scheduler.ts';

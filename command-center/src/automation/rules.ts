// The rules engine. Rules organize the task graph (move, tag, comment, follow up, notify); they
// deliberately cannot complete, drop, delete, or accept anything, and cannot touch anything
// outside this store. That split (organize vs. decide) is the whole point of "propose, do not
// act" from the initiative doc: a rule can shuffle a task around and tell the owner about it, but
// only a human (or an explicit, human-reviewed action) can decide a task is done.
import { z } from 'zod';
import {
  ACTIVE_STATUSES,
  CHECKLIST_REPEAT_ITEMS_FIELD,
  EXTERNAL_SOURCE_TYPES,
  type CustomFieldValue,
  type EventKind,
  type Json,
  type Priority,
  type Rule,
  type SourceType,
  type Store,
  type Task,
  type TaskStatus,
} from '../core/index.ts';
import { addDays } from './dates.ts';
import { compilePattern } from './pattern.ts';

// Kept in sync by hand with core/types.ts EventKind / SourceType. Core does not export these as
// value arrays (only the type), so the zod schema needs its own literal list.
const EVENT_KIND_VALUES = [
  'task.created', 'task.updated', 'task.completed', 'task.reopened', 'task.moved',
  'task.accepted', 'task.rejected', 'task.source_changed', 'task.source_gone',
  'comment.added', 'project.upserted', 'rule.fired',
] as const satisfies readonly EventKind[];

const SOURCE_TYPE_VALUES = [
  'todo_md', 'status_md', 'initiative_md', 'github', 'git_local', 'code_todo', 'gmail', 'gdrive', 'gcal', 'manual',
] as const satisfies readonly SourceType[];

const PRIORITY_VALUES = ['none', 'low', 'medium', 'high', 'urgent'] as const satisfies readonly Priority[];

// set_field on status may never move a task to 'done' or 'dropped': that is completing/dropping
// it, which is a decision reserved for a human (or the explicit complete/reject store calls).
const SETTABLE_STATUS_VALUES = ['inbox', 'open', 'in_progress', 'waiting'] as const satisfies readonly TaskStatus[];

const jsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonSchema), z.record(z.string(), jsonSchema)]));

const customFieldValueSchema: z.ZodType<CustomFieldValue> = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const sourceFilterSchema = z.object({
  sourceType: z.enum(SOURCE_TYPE_VALUES).optional(),
  sourceIdPrefix: z.string().min(1).optional(),
}).strict();

const eventTriggerSchema = z.object({
  type: z.literal('event'),
  kinds: z.array(z.enum(EVENT_KIND_VALUES)).min(1, 'trigger.kinds must list at least one event kind'),
  source: sourceFilterSchema.optional(),
}).strict();

const scheduleTriggerSchema = z.object({
  type: z.literal('schedule'),
  condition: z.enum(['due_within_days', 'overdue', 'stale_days']),
  days: z.number().int().positive().optional(),
  source: sourceFilterSchema.optional(),
}).strict();

const triggerSchema = z.discriminatedUnion('type', [eventTriggerSchema, scheduleTriggerSchema])
  .superRefine((trigger, ctx) => {
    if (trigger.type === 'schedule' && (trigger.condition === 'due_within_days' || trigger.condition === 'stale_days') && trigger.days === undefined) {
      ctx.addIssue({ code: 'custom', path: ['days'], message: `condition '${trigger.condition}' requires 'days'` });
    }
  });

const CONDITION_FIELD_RE = /^(status|priority|projectId|sourceType|title|dueAt|customField:.+)$/;

// 'matches' runs a rule-authored, possibly agent-authored, pattern against untrusted task text
// (a title from github, say). It never uses RegExp: a backtracking engine can be made to run
// for hours by a pattern as plain as ^(a|aa)+$, and a heuristic that rejects "the dangerous
// shapes" is never complete. pattern.ts is a linear-time engine for the everyday subset of the
// syntax; a pattern outside that subset is refused here, at validation, with its reason. The
// length caps bound the work per test, on the pattern and on the string tested (evaluateCondition).
const MAX_MATCHES_PATTERN_LENGTH = 200;
const MAX_MATCHES_INPUT_LENGTH = 1000;

function unsafeRegexReason(pattern: string): string | null {
  if (pattern.length > MAX_MATCHES_PATTERN_LENGTH) return `'matches' pattern must be ${MAX_MATCHES_PATTERN_LENGTH} characters or fewer`;
  try {
    compilePattern(pattern);
    return null;
  } catch (e) {
    return `'matches' pattern is not supported: ${e instanceof Error ? e.message : String(e)}`;
  }
}

const conditionSchema = z.object({
  field: z.string().regex(CONDITION_FIELD_RE, "field must be one of status, priority, projectId, sourceType, title, dueAt, or 'customField:<key>'"),
  op: z.enum(['eq', 'ne', 'in', 'contains', 'matches', 'exists', 'before', 'after']),
  value: jsonSchema.optional(),
}).strict().superRefine((cond, ctx) => {
  if (cond.op === 'matches' && typeof cond.value === 'string') {
    const reason = unsafeRegexReason(cond.value);
    if (reason) ctx.addIssue({ code: 'custom', path: ['value'], message: reason });
  }
});

const setFieldActionSchema = z.discriminatedUnion('field', [
  z.object({ type: z.literal('set_field'), field: z.literal('priority'), value: z.enum(PRIORITY_VALUES) }).strict(),
  z.object({ type: z.literal('set_field'), field: z.literal('status'), value: z.enum(SETTABLE_STATUS_VALUES) }).strict(),
  z.object({ type: z.literal('set_field'), field: z.literal('dueAt'), value: z.union([z.string(), z.null()]) }).strict(),
  // checklistRepeatItems decides whether a repeat copies a task's subtasks: the owner's choice when
  // starting a checklist, never a rule's, so a rule cannot set it.
  z.object({
    type: z.literal('set_field'), field: z.literal('customField'),
    key: z.string().min(1).refine((k) => k !== CHECKLIST_REPEAT_ITEMS_FIELD, { message: `a rule cannot set ${CHECKLIST_REPEAT_ITEMS_FIELD}` }),
    value: customFieldValueSchema,
  }).strict(),
]);

// There is deliberately no 'complete', 'drop', 'delete', 'accept_inbox', or external-system
// action: rules may organize a task, never decide its fate or reach outside this store.
const moveActionSchema = z.object({
  type: z.literal('move'),
  project: z.string().min(1),
  section: z.string().min(1).optional(),
}).strict();

const addCommentActionSchema = z.object({
  type: z.literal('add_comment'),
  body: z.string().min(1),
}).strict();

const createFollowupActionSchema = z.object({
  type: z.literal('create_followup'),
  title: z.string().min(1),
  dueInDays: z.number().int().optional(),
}).strict();

const notifyActionSchema = z.object({
  type: z.literal('notify'),
  message: z.string().min(1),
}).strict();

const actionSchema = z.union([setFieldActionSchema, moveActionSchema, addCommentActionSchema, createFollowupActionSchema, notifyActionSchema]);

const ruleDefinitionSchema = z.object({
  trigger: triggerSchema,
  conditions: z.array(conditionSchema).default([]),
  actions: z.array(actionSchema).min(1, 'actions must list at least one action'),
}).strict();

export type RuleTrigger = z.infer<typeof triggerSchema>;
export type RuleCondition = z.infer<typeof conditionSchema>;
export type RuleAction = z.infer<typeof actionSchema>;
export type RuleDefinition = z.infer<typeof ruleDefinitionSchema>;

export interface RuleValidation { ok: boolean; errors: string[]; normalized?: Record<string, Json> }

/** Validate a rule definition (as stored, opaquely, on core.Rule). Errors are in plain words. */
export function validateRuleDefinition(definition: unknown): RuleValidation {
  const result = ruleDefinitionSchema.safeParse(definition);
  if (result.success) return { ok: true, errors: [], normalized: result.data as unknown as Record<string, Json> };
  const errors = result.error.issues.map((issue) => {
    const path = issue.path.length ? `${issue.path.join('.')}: ` : '';
    return `${path}${issue.message}`;
  });
  return { ok: false, errors };
}

/**
 * Substitute task fields into a rule's template text. A title written by a third party is quoted
 * and marked here, at the one place every action renders it, so untrusted wording cannot travel
 * into a comment, a follow-up task or a digest notification as trusted prose. Quoting also folds
 * the newlines that would otherwise let a crafted title forge extra lines in the digest.
 */
function renderTemplate(template: string, task: Task): string {
  const title = task.untrustedText ? `${JSON.stringify(task.title)} UNTRUSTED-TEXT` : task.title;
  return template.replaceAll('{title}', title);
}

function fieldValue(task: Task, field: string): Json {
  if (field.startsWith('customField:')) {
    const key = field.slice('customField:'.length);
    return (task.customFields[key] ?? null) as Json;
  }
  switch (field) {
    case 'status': return task.status;
    case 'priority': return task.priority;
    case 'projectId': return task.projectId;
    case 'sourceType': return task.sourceType;
    case 'title': return task.title;
    case 'dueAt': return task.dueAt;
    default: return null;
  }
}

function evaluateCondition(task: Task, cond: RuleCondition): boolean {
  const value = fieldValue(task, cond.field);
  switch (cond.op) {
    case 'eq': return value === cond.value;
    case 'ne': return value !== cond.value;
    case 'in': return Array.isArray(cond.value) && cond.value.some((v) => v === value);
    case 'contains':
      return typeof value === 'string' && typeof cond.value === 'string' && value.toLowerCase().includes(cond.value.toLowerCase());
    case 'matches':
      // The pattern was accepted by compilePattern at validation (see conditionSchema); the cap
      // on the tested string bounds the work per task. A stored pattern the engine no longer
      // accepts throws, which the runner reports as that rule's error.
      return typeof value === 'string' && typeof cond.value === 'string' && compilePattern(cond.value).test(value.slice(0, MAX_MATCHES_INPUT_LENGTH));
    case 'exists': return value !== null && value !== undefined;
    case 'before': return typeof value === 'string' && typeof cond.value === 'string' && value < cond.value;
    case 'after': return typeof value === 'string' && typeof cond.value === 'string' && value > cond.value;
    default: return false;
  }
}

function matchesSource(task: Task, source?: { sourceType?: SourceType; sourceIdPrefix?: string }): boolean {
  if (!source) return true;
  if (source.sourceType && task.sourceType !== source.sourceType) return false;
  if (source.sourceIdPrefix && !(task.sourceId ?? '').startsWith(source.sourceIdPrefix)) return false;
  return true;
}

interface ActionPlan {
  description: string;
  notification?: string;
  apply: () => void;
}

function planAction(store: Store, task: Task, action: RuleAction, today: string): ActionPlan {
  switch (action.type) {
    case 'set_field':
      switch (action.field) {
        case 'priority':
          return { description: `set priority to ${action.value}`, apply: () => { store.updateTask(task.id, { priority: action.value }, 'rule'); } };
        case 'status':
          // "Rules organize, never decide": a status change is refused (not an error, just a
          // no-op action) when the task is currently inbox (would silently accept it), or
          // done/dropped (would silently reopen it). Both are human decisions.
          if (task.status === 'inbox' || task.status === 'done' || task.status === 'dropped') {
            return { description: `skipped: cannot change status while the task is ${task.status}`, apply: () => {} };
          }
          return { description: `set status to ${action.value}`, apply: () => { store.updateTask(task.id, { status: action.value }, 'rule'); } };
        case 'dueAt':
          return { description: `set due date to ${action.value ?? 'none'}`, apply: () => { store.updateTask(task.id, { dueAt: action.value }, 'rule'); } };
        case 'customField':
          return {
            description: `set customField ${action.key} to ${JSON.stringify(action.value)}`,
            apply: () => { store.updateTask(task.id, { customFields: { [action.key]: action.value } }, 'rule'); },
          };
      }
      break;
    case 'move': {
      const project = store.findProject(action.project);
      if (!project) throw new Error(`move action: project '${action.project}' not found`);
      return {
        description: `moved to ${project.name}${action.section ? ` / ${action.section}` : ''}`,
        apply: () => {
          const sectionId = action.section ? store.ensureSection(project.id, action.section).id : null;
          store.moveTask(task.id, { projectId: project.id, sectionId }, 'rule');
        },
      };
    }
    case 'add_comment': {
      const body = renderTemplate(action.body, task);
      return { description: 'added a comment', apply: () => { store.addComment(task.id, body, 'system', 'rule'); } };
    }
    case 'create_followup': {
      const title = renderTemplate(action.title, task);
      const dueAt = action.dueInDays !== undefined ? addDays(today, action.dueInDays) : null;
      return {
        description: `created follow-up "${title}"${dueAt ? ` due ${dueAt}` : ''}`,
        apply: () => {
          store.createTask({
            title, projectId: task.projectId, dueAt, status: 'open',
            notes: `Follow-up for ${task.id}.`, untrustedText: task.untrustedText,
          }, 'rule');
        },
      };
    }
    case 'notify': {
      const message = renderTemplate(action.message, task);
      return { description: `notification: ${message}`, notification: message, apply: () => {} };
    }
  }
  throw new Error('unknown action');
}

interface FireResult { taskId: string; actions: string[] }

function fireOnTask(store: Store, rule: Rule, task: Task, def: RuleDefinition, today: string, dryRun: boolean): FireResult {
  const plans = def.actions.map((a) => planAction(store, task, a, today));
  const descriptions = plans.map((p) => p.description);
  const notification = plans.map((p) => p.notification).find((n): n is string => n !== undefined);
  if (!dryRun) {
    store.db.transaction(() => {
      for (const p of plans) p.apply();
      const payload: Record<string, Json> = { ruleId: rule.id, ruleName: rule.name, actions: descriptions };
      if (notification !== undefined) payload.notification = notification;
      store.recordEvent('rule.fired', task.id, 'rule', payload);
      store.addComment(task.id, `Rule "${rule.name}" fired: ${descriptions.length ? descriptions.join('; ') : 'no actions'}.`, 'system', 'rule');
    });
  }
  return { taskId: task.id, actions: descriptions };
}

function scheduleCandidates(store: Store, trigger: Extract<RuleTrigger, { type: 'schedule' }>, today: string): Task[] {
  const ACTIVE = [...ACTIVE_STATUSES];
  switch (trigger.condition) {
    case 'overdue':
      return store.searchTasks({ status: ACTIVE, dueBefore: today, limit: 1000 });
    case 'due_within_days': {
      const days = trigger.days ?? 0;
      return store.searchTasks({ status: ACTIVE, dueAfter: today, dueBefore: addDays(today, days + 1), limit: 1000 });
    }
    case 'stale_days': {
      const days = trigger.days ?? 0;
      const cutoff = addDays(today, -days);
      // Filtered in SQL, so the LIMIT applies to stale tasks rather than to all active ones. It
      // used to take 1000 rows in due-date order and filter afterwards, and due-date order sorts
      // undated tasks last -- so a thousand dated tasks filled the window ahead of exactly the
      // forgotten, undated ones this condition exists to surface, and it fired on none of them.
      return store.searchTasks({ status: ACTIVE, updatedBefore: cutoff, orderBy: 'updated', limit: 1000 });
    }
  }
}

export interface RuleRunReport {
  dryRun: boolean;
  fired: { ruleId: string; ruleName: string; taskId: string | null; actions: string[] }[];
  errors: { ruleId: string; message: string }[];
}

// Each event rule gets its own cursor (rather than one shared cursor) so that evaluating or
// targeting one rule can never affect what another rule sees.
const EVENT_CURSOR_KEY_PREFIX = 'rules.eventCursor.';
const SCHEDULE_FIRED_KV_KEY = 'rules.scheduleFired';
const SCHEDULE_FIRED_PRUNE_DAYS = 30;

/**
 * Evaluate enabled rules (or just `ruleId`) against new events and scheduled conditions.
 *
 * Event rules each track their own cursor (kv 'rules.eventCursor.<ruleId>'); events authored by
 * 'rule' are ignored so a rule's own actions can never re-trigger a rule (loop prevention). The
 * first time a rule is evaluated (no cursor yet -- a brand new rule, or one just re-enabled after
 * never having run) it does not replay history: its cursor is primed to `store.lastEventId()` as
 * of that run, so it only reacts to events from here on. Schedule rules fire at most once per
 * rule/task/day, tracked in kv 'rules.scheduleFired' (pruned on write). dryRun evaluates and
 * reports but performs no store writes: it does not advance any cursor, prime a new one, or touch
 * the schedule dedupe map. An error from one rule (or one task) is recorded in `errors` and never
 * stops evaluation of anything else. Because cursors are per rule, targeting one rule via `ruleId`
 * only ever reads and advances that rule's own cursor -- other rules' cursors are untouched.
 */
export function runRules(store: Store, opts: { today: string; ruleId?: string; dryRun?: boolean }): RuleRunReport {
  const dryRun = opts.dryRun ?? false;
  const report: RuleRunReport = { dryRun, fired: [], errors: [] };

  const allRules = store.listRules();
  const selected = opts.ruleId ? allRules.filter((r) => r.id === opts.ruleId || r.name === opts.ruleId) : allRules;
  if (opts.ruleId && selected.length === 0) {
    report.errors.push({ ruleId: opts.ruleId, message: `rule '${opts.ruleId}' not found` });
    return report;
  }
  // Disabled rules are skipped, unless a specific rule is targeted for a dry run (a preview of a
  // not-yet-enabled rule).
  const rulesToRun = selected.filter((r) => r.enabled || (opts.ruleId !== undefined && dryRun));

  const parsed: { rule: Rule; def: RuleDefinition }[] = [];
  for (const rule of rulesToRun) {
    const validation = validateRuleDefinition(rule.definition);
    if (!validation.ok) {
      report.errors.push({ ruleId: rule.id, message: `invalid rule definition: ${validation.errors.join('; ')}` });
      continue;
    }
    parsed.push({ rule, def: validation.normalized as unknown as RuleDefinition });
  }

  // ---- event-triggered rules ----
  const eventRules = parsed.filter((p): p is { rule: Rule; def: RuleDefinition & { trigger: { type: 'event' } } } => p.def.trigger.type === 'event');
  for (const { rule, def } of eventRules) {
    const cursorKey = `${EVENT_CURSOR_KEY_PREFIX}${rule.id}`;
    const cursor = store.getKv<number>(cursorKey);
    if (cursor === undefined) {
      // First sight: start tracking from here, do not replay history. Only persist the cursor on
      // a real run -- a dry run must leave no trace, so an unprimed rule previewed via dryRun will
      // (correctly) never show a backlog firing.
      if (!dryRun) store.setKv(cursorKey, store.lastEventId());
      continue;
    }
    const events = store.eventsSince(cursor, 5000);
    if (!events.length) continue;
    let maxSeen = cursor;
    for (const ev of events) {
      maxSeen = Math.max(maxSeen, ev.id);
      if (ev.actor === 'rule') continue; // loop prevention
      if (!ev.taskId) continue;
      // Goal events are left out of EVENT_KIND_VALUES on purpose, so no rule can trigger on one.
      if (!(def.trigger.kinds as readonly EventKind[]).includes(ev.kind)) continue;
      try {
        const task = store.getTask(ev.taskId);
        if (!task) continue;
        if (!matchesSource(task, def.trigger.source)) continue;
        if (!def.conditions.every((c) => evaluateCondition(task, c))) continue;
        const result = fireOnTask(store, rule, task, def, opts.today, dryRun);
        report.fired.push({ ruleId: rule.id, ruleName: rule.name, taskId: result.taskId, actions: result.actions });
      } catch (e) {
        report.errors.push({ ruleId: rule.id, message: e instanceof Error ? e.message : String(e) });
      }
    }
    if (!dryRun) store.setKv(cursorKey, maxSeen);
  }

  // ---- schedule-triggered rules ----
  const scheduleRules = parsed.filter((p): p is { rule: Rule; def: RuleDefinition & { trigger: { type: 'schedule' } } } => p.def.trigger.type === 'schedule');
  if (scheduleRules.length) {
    const firedMap: Record<string, string> = { ...(store.getKv<Record<string, string>>(SCHEDULE_FIRED_KV_KEY) ?? {}) };
    let changed = false;
    for (const { rule, def } of scheduleRules) {
      let candidates: Task[];
      try {
        candidates = scheduleCandidates(store, def.trigger, opts.today);
      } catch (e) {
        report.errors.push({ ruleId: rule.id, message: e instanceof Error ? e.message : String(e) });
        continue;
      }
      for (const task of candidates) {
        try {
          if (!matchesSource(task, def.trigger.source)) continue;
          if (!def.conditions.every((c) => evaluateCondition(task, c))) continue;
          const key = `${rule.id}:${task.id}:${opts.today}`;
          if (firedMap[key]) continue;
          const result = fireOnTask(store, rule, task, def, opts.today, dryRun);
          report.fired.push({ ruleId: rule.id, ruleName: rule.name, taskId: result.taskId, actions: result.actions });
          if (!dryRun) { firedMap[key] = opts.today; changed = true; }
        } catch (e) {
          report.errors.push({ ruleId: rule.id, message: e instanceof Error ? e.message : String(e) });
        }
      }
    }
    if (!dryRun && changed) {
      const cutoff = addDays(opts.today, -SCHEDULE_FIRED_PRUNE_DAYS);
      const pruned: Record<string, string> = {};
      for (const [k, v] of Object.entries(firedMap)) if (v >= cutoff) pruned[k] = v;
      store.setKv(SCHEDULE_FIRED_KV_KEY, pruned);
    }
  }

  return report;
}

export interface RuleNotification {
  at: string;
  taskId: string | null;
  ruleId: string;
  ruleName: string;
  message: string;
}

/** Notifications ever recorded by a 'notify' action, optionally since an ISO timestamp. */
export function listNotifications(store: Store, sinceIso?: string): RuleNotification[] {
  // Filters by kind (and, when given, by date) in SQL, so notifications are never lost behind an
  // unrelated flood of other event kinds -- unlike a fixed-size eventsSince() window would.
  const events = store.eventsOfKind('rule.fired', sinceIso ?? null, 10_000)
    .filter((e) => typeof e.payload.notification === 'string');
  return events.map((e) => ({
    at: e.at,
    taskId: e.taskId,
    ruleId: typeof e.payload.ruleId === 'string' ? e.payload.ruleId : '',
    ruleName: typeof e.payload.ruleName === 'string' ? e.payload.ruleName : '',
    message: e.payload.notification as string,
  }));
}

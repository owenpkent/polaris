// Zod request-body schemas for the REST API. Enum value lists are imported from mcp/shared.ts so
// the REST and MCP surfaces can never drift apart on what a valid status/priority/source type is.
import { z } from 'zod';
import { CONFIDENCES, OUTBOX_OP_KINDS, POST_STATUSES, POST_TYPES, ValidationError } from '../core/index.ts';
import { PRIORITY_VALUES, SOURCE_TYPE_VALUES, TASK_STATUS_VALUES } from '../mcp/shared.ts';

const customFieldValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const customFieldsSchema = z.record(z.string(), customFieldValueSchema);

// NewTask camelCase fields, plus the REST-only `project` (ref) / `section` (name) / `blockedBy` helpers.
// `opId` and `deviceId` name a write the dashboard will replay through POST /api/outbox if it
// never sees the answer (core/outbox.ts, applyOnlineOnce).
const onlineOpFields = {
  opId: z.string().min(8).max(64).optional(),
  deviceId: z.string().min(8).max(64).optional(),
};

export const newTaskBodySchema = z.object({
  ...onlineOpFields,
  /** The id the dashboard minted, which the replayed create_task op carries too. */
  id: z.string().max(64).optional(),
  title: z.string().min(1, 'title is required'),
  notes: z.string().optional(),
  projectId: z.string().nullable().optional(),
  sectionId: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  status: z.enum(TASK_STATUS_VALUES).optional(),
  priority: z.enum(PRIORITY_VALUES).optional(),
  dueAt: z.string().nullable().optional(),
  startAt: z.string().nullable().optional(),
  estimateMinutes: z.number().int().nonnegative().nullable().optional(),
  recurrence: z.string().nullable().optional(),
  assignee: z.string().max(200).nullable().optional(),
  isMilestone: z.boolean().optional(),
  customFields: customFieldsSchema.optional(),
  sourceType: z.enum(SOURCE_TYPE_VALUES).nullable().optional(),
  sourceId: z.string().nullable().optional(),
  sourceUrl: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  project: z.string().min(1).optional(),
  section: z.string().min(1).optional(),
  blockedBy: z.array(z.string()).optional(),
}).strict();

// Bulk import from pasted text or CSV (importer/taskText.ts).
export const taskImportBodySchema = z.object({
  text: z.string().min(1, 'text is required').max(1_000_000),
  format: z.enum(['auto', 'csv', 'lines']).default('auto'),
  project: z.string().min(1).optional(),
  dryRun: z.boolean().optional(),
}).strict();

// TaskPatch (NewTask minus sourceType/sourceId) plus status.
export const taskPatchBodySchema = z.object({
  title: z.string().min(1).optional(),
  notes: z.string().optional(),
  projectId: z.string().nullable().optional(),
  sectionId: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  status: z.enum(TASK_STATUS_VALUES).optional(),
  priority: z.enum(PRIORITY_VALUES).optional(),
  dueAt: z.string().nullable().optional(),
  startAt: z.string().nullable().optional(),
  estimateMinutes: z.number().int().nonnegative().nullable().optional(),
  recurrence: z.string().nullable().optional(),
  assignee: z.string().max(200).nullable().optional(),
  isMilestone: z.boolean().optional(),
  customFields: customFieldsSchema.optional(),
  sourceUrl: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
}).strict();

export const moveTaskBodySchema = z.object({
  project: z.string().nullable().optional(),
  section: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  position: z.number().int().optional(),
}).strict();

// POST /api/outbox: the edits a dashboard made while the server was unreachable. `kind` is a
// closed list (core/outbox.ts), and `body` is checked per kind when the op is applied.
export const outboxBodySchema = z.object({
  deviceId: z.string().min(8).max(64),
  ops: z.array(z.object({
    opId: z.string().min(8).max(64),
    kind: z.enum(OUTBOX_OP_KINDS),
    taskId: z.string().min(1).max(64),
    at: z.string().min(1),
    base: z.string().nullable(),
    body: z.record(z.string(), z.unknown()),
  }).strict()).max(500),
}).strict();

export const commentBodySchema = z.object({ ...onlineOpFields, body: z.string().min(1, 'body is required') }).strict();

export const dependencyBodySchema = z.object({ blockerId: z.string().min(1, 'blockerId is required') }).strict();

export const inboxAcceptBodySchema = z.object({
  project: z.string().min(1).optional(),
  section: z.string().min(1).optional(),
  dueAt: z.string().nullable().optional(),
  priority: z.enum(PRIORITY_VALUES).optional(),
  title: z.string().min(1).optional(),
}).strict();

export const inboxRejectBodySchema = z.object({ reason: z.string().nullable().optional() }).strict();

export const ruleCreateBodySchema = z.object({
  name: z.string().min(1, 'name is required'),
  definition: z.record(z.string(), z.unknown()),
  enabled: z.boolean().optional(),
}).strict();

export const rulePatchBodySchema = z.object({
  name: z.string().min(1).optional(),
  definition: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
}).strict();

export const ruleRunBodySchema = z.object({
  ruleId: z.string().optional(),
  dryRun: z.boolean().optional(),
}).strict();

/** Parses `body` against `schema`, mapping any failure to a 400 ValidationError with a plain-words message. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body === undefined ? {} : body);
  if (!result.success) {
    const message = result.error.issues.map((issue) => `${issue.path.length ? issue.path.join('.') : 'body'}: ${issue.message}`).join('; ');
    throw new ValidationError(message);
  }
  return result.data;
}

// ---- projects ----

/** `owner/repo` or any github.com URL, stored as https://github.com/owner/repo, the form the GitHub sync maps from. */
const githubRepo = z.string().trim().transform((value, ctx) => {
  const m = value.match(/^(?:(?:https?:\/\/|git@|ssh:\/\/git@)?github\.com[:/]+)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  if (!m) {
    ctx.addIssue({ code: 'custom', message: 'must be owner/repo or a github.com URL' });
    return z.NEVER;
  }
  return `https://github.com/${m[1]}/${m[2]}`;
});

const projectFields = {
  category: z.string().trim().max(60).nullable().optional(),
  type: z.string().trim().max(120).nullable().optional(),
  status: z.string().trim().max(120).nullable().optional(),
  description: z.string().max(20000).nullable().optional(),
  github: githubRepo.nullable().optional(),
  archived: z.boolean().optional(),
};

export const projectCreateBodySchema = z.object({ name: z.string().trim().min(1, 'name is required').max(200), ...projectFields }).strict();

export const projectPatchBodySchema = z.object({ name: z.string().trim().min(1).max(200).optional(), ...projectFields }).strict();

// ---- goals ----

const GOAL_STATUS_VALUES = ['on_track', 'at_risk', 'off_track', 'achieved', 'dropped'] as const;
const GOAL_PROGRESS_MODE_VALUES = ['manual', 'tasks'] as const;
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

const goalFields = {
  notes: z.string().optional(),
  parentId: z.string().nullable().optional(),
  periodLabel: z.string().nullable().optional(),
  startsOn: dateOnly.nullable().optional(),
  endsOn: dateOnly.nullable().optional(),
  status: z.enum(GOAL_STATUS_VALUES).optional(),
  statusNote: z.string().optional(),
  progressMode: z.enum(GOAL_PROGRESS_MODE_VALUES).optional(),
  currentValue: z.number().finite().nullable().optional(),
  targetValue: z.number().finite().nullable().optional(),
  unit: z.string().nullable().optional(),
};

export const goalCreateBodySchema = z.object({ title: z.string().trim().min(1, 'title is required'), ...goalFields }).strict();

export const goalPatchBodySchema = z.object({ title: z.string().trim().min(1).optional(), ...goalFields }).strict();

/** Exactly one of `project` (id or slug) or `taskId`. */
export const goalLinkBodySchema = z.object({
  project: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
}).strict().refine((v) => (v.project === undefined) !== (v.taskId === undefined), { message: 'give exactly one of project or taskId' });

export const restoreBodySchema = z.object({ eventId: z.number().int().positive() }).strict();

export const goalVisionBodySchema = z.object({ text: z.string().max(4000) }).strict();

// ---- threads (docs/agent-threads-proposal.md) ----

export const threadCreateBodySchema = z.object({ title: z.string().max(200).nullable().optional() }).strict();

// A post is a live write with no op identity: there is no thread op kind in the outbox, by
// choice (the proposal, section 9), so the dashboard disables the form offline instead.
export const postBodySchema = z.object({
  type: z.enum(POST_TYPES),
  body: z.string().min(1, 'body is required').max(20000),
  confidence: z.enum(CONFIDENCES).nullable().optional(),
  refs: z.array(z.string().min(1).max(64)).max(50).optional(),
  parentPostId: z.string().min(1).max(64).nullable().optional(),
}).strict();

// The owner's stage 2 controls. None has an op identity either: a verdict, a pin, a close, or a
// fork is a live click, like an inbox decision.
export const threadPatchBodySchema = z.object({
  pinnedPostId: z.string().min(1).max(64).nullable().optional(),
  authorHidden: z.boolean().optional(),
  dailyCap: z.number().int().positive().max(10000).nullable().optional(),
}).strict().refine((v) => Object.keys(v).length > 0, { message: 'nothing to change' });

export const threadForkBodySchema = z.object({ title: z.string().min(1, 'title is required').max(200) }).strict();

export const postStatusBodySchema = z.object({ status: z.enum(POST_STATUSES) }).strict();

// Shape only; normalizeAgentName (core/agentName.ts) is what actually accepts or rejects the value.
export const agentSettingsBodySchema = z.object({ defaultAgentName: z.string() }).strict();

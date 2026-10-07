// Pure parser for bulk task import: pasted lines (plain, bulleted, checkbox, nested) or CSV/TSV
// with a header row. No store access; importer/taskImport.ts resolves projects and writes tasks.
import { PRIORITIES, TASK_STATUSES } from '../core/types.ts';
import type { Priority, TaskStatus } from '../core/types.ts';

export const MAX_IMPORT_ROWS = 1000;

export type ImportFormat = 'auto' | 'csv' | 'lines';

export interface ImportRow {
  /** 1-based line in the source text where the row starts. */
  line: number;
  title: string;
  notes?: string;
  status?: TaskStatus;
  priority?: Priority;
  dueAt?: string;
  startAt?: string;
  estimateMinutes?: number;
  assignee?: string;
  /** Raw project reference (id, slug, or name), resolved later. */
  project?: string;
  /** Section name or id, resolved later. */
  section?: string;
  /** Index into the rows array of the parent, for nested lines. */
  parentIndex: number | null;
}

export interface ImportError {
  /** 1-based source line, or 0 when the problem is not tied to a line. */
  line: number;
  message: string;
}

export interface ParsedTaskText {
  format: 'csv' | 'lines';
  rows: ImportRow[];
  errors: ImportError[];
  ignoredColumns: string[];
}

type Field = 'title' | 'notes' | 'status' | 'priority' | 'dueAt' | 'startAt' | 'estimateMinutes' | 'assignee' | 'project' | 'section';

const ALIASES: Record<string, Field> = {
  title: 'title', name: 'title', task: 'title', content: 'title', summary: 'title',
  notes: 'notes', description: 'notes', details: 'notes', body: 'notes',
  status: 'status', priority: 'priority',
  due: 'dueAt', duedate: 'dueAt', dueat: 'dueAt', deadline: 'dueAt', date: 'dueAt',
  start: 'startAt', startdate: 'startAt', startat: 'startAt',
  estimate: 'estimateMinutes', estimateminutes: 'estimateMinutes', minutes: 'estimateMinutes',
  assignee: 'assignee', owner: 'assignee', assignedto: 'assignee',
  project: 'project', section: 'section',
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function headerKey(raw: string): string {
  return raw.replace(/^﻿/, '').toLowerCase().replace(/[\s_-]+/g, '');
}

const DELIMITERS = [',', ';', '\t'] as const;

/** Count a delimiter outside double quotes on one line. */
function countDelimiter(line: string, d: string): number {
  let inQuotes = false;
  let n = 0;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === d && !inQuotes) n++;
  }
  return n;
}

function detectDelimiter(headerLine: string): string {
  let best = ',';
  let bestCount = 0;
  for (const d of DELIMITERS) {
    const n = countDelimiter(headerLine, d);
    if (n > bestCount) { best = d; bestCount = n; }
  }
  return best;
}

interface CsvRecord { cells: string[]; line: number }

interface SplitRecords {
  records: CsvRecord[];
  /** Set when the text ends inside a quoted field; the partial record is not in `records`. */
  error: ImportError | null;
}

/** RFC 4180 records. `line` is the 1-based line each record starts on. */
function splitRecords(text: string, delimiter: string): SplitRecords {
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  // The line a quoted field opened on, for the error when it never closes.
  let quoteLine = 1;
  let line = 1;
  let recordLine = 1;
  let i = 0;
  const endRecord = (): void => {
    cells.push(field);
    records.push({ cells, line: recordLine });
    cells = [];
    field = '';
  };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false;
        i++;
        continue;
      }
      if (ch === '\r' && text[i + 1] === '\n') { field += '\n'; line++; i += 2; continue; }
      if (ch === '\n' || ch === '\r') line++;
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') { inQuotes = true; quoteLine = line; i++; continue; }
    if (ch === delimiter) { cells.push(field); field = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      i++;
      endRecord();
      line++;
      recordLine = line;
      continue;
    }
    field += ch;
    i++;
  }
  if (inQuotes) {
    // Everything after the opening quote was swallowed into one field, so it is not a record.
    return { records, error: { line: quoteLine, message: 'a quoted field is never closed (missing closing ")' } };
  }
  if (field !== '' || cells.length > 0) endRecord();
  return { records, error: null };
}

function parseStatus(raw: string): TaskStatus | null {
  const v = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const mapped = v === 'todo' || v === 'to_do' ? 'open' : v === 'completed' || v === 'complete' ? 'done' : v === 'inprogress' ? 'in_progress' : v;
  return (TASK_STATUSES as readonly string[]).includes(mapped) ? (mapped as TaskStatus) : null;
}

function parsePriority(raw: string): Priority | null {
  const v = raw.trim().toLowerCase();
  const p: Record<string, Priority> = { p1: 'urgent', p2: 'high', p3: 'medium', p4: 'low' };
  if (p[v]) return p[v];
  return (PRIORITIES as readonly string[]).includes(v) ? (v as Priority) : null;
}

function parseDate(raw: string): string | null {
  const v = raw.trim();
  if (!DATE_RE.test(v)) return null;
  return Number.isNaN(Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v)) ? null : v;
}

function parseEstimate(raw: string): number | null {
  const v = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (/^\d+$/.test(v)) return Number(v);
  let m = /^(\d+(?:\.\d+)?)h(?:ours?|rs?)?$/.exec(v);
  if (m) return Math.round(Number(m[1]) * 60);
  m = /^(\d+)m(?:ins?|inutes?)?$/.exec(v);
  if (m) return Number(m[1]);
  m = /^(\d+)h(?:ours?|rs?)?(\d+)m?(?:ins?|inutes?)?$/.exec(v);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  return null;
}

function resolveHeaders(cells: string[]): { fields: (Field | null)[]; ignored: string[] } {
  const fields: (Field | null)[] = [];
  const ignored: string[] = [];
  const seen = new Set<Field>();
  for (const raw of cells) {
    const label = raw.replace(/^﻿/, '').trim();
    const f = ALIASES[headerKey(raw)];
    if (f && !seen.has(f)) { seen.add(f); fields.push(f); } else { fields.push(null); if (label) ignored.push(label); }
  }
  return { fields, ignored };
}

function parseCsv(text: string, delimiter: string): ParsedTaskText {
  const result: ParsedTaskText = { format: 'csv', rows: [], errors: [], ignoredColumns: [] };
  const { records, error: unterminated } = splitRecords(text, delimiter);
  if (unterminated) { result.errors.push(unterminated); return result; }
  const headerAt = records.findIndex((r) => r.cells.some((c) => c.trim() !== ''));
  if (headerAt < 0) { result.errors.push({ line: 0, message: 'no header row found' }); return result; }
  const { fields, ignored } = resolveHeaders(records[headerAt].cells);
  result.ignoredColumns = ignored;
  if (!fields.includes('title')) {
    result.errors.push({ line: records[headerAt].line, message: 'header row needs a title column (title, name, task, content, or summary)' });
    return result;
  }
  for (const rec of records.slice(headerAt + 1)) {
    if (rec.cells.every((c) => c.trim() === '')) continue;
    if (result.rows.length >= MAX_IMPORT_ROWS) {
      result.errors.push({ line: rec.line, message: `more than ${MAX_IMPORT_ROWS} rows` });
      break;
    }
    const row: ImportRow = { line: rec.line, title: '', parentIndex: null };
    let bad = false;
    const fail = (message: string): void => { bad = true; result.errors.push({ line: rec.line, message }); };
    fields.forEach((f, i) => {
      if (!f) return;
      const raw = rec.cells[i] ?? '';
      const v = raw.trim();
      if (f === 'notes') { if (raw.trim()) row.notes = raw.replace(/\s+$/, ''); return; }
      if (v === '') return;
      switch (f) {
        case 'title': row.title = v; break;
        case 'status': { const s = parseStatus(v); if (s) row.status = s; else fail(`invalid status "${v}"`); break; }
        case 'priority': { const p = parsePriority(v); if (p) row.priority = p; else fail(`invalid priority "${v}"`); break; }
        case 'dueAt': { const d = parseDate(v); if (d) row.dueAt = d; else fail(`invalid due date "${v}" (use YYYY-MM-DD)`); break; }
        case 'startAt': { const d = parseDate(v); if (d) row.startAt = d; else fail(`invalid start date "${v}" (use YYYY-MM-DD)`); break; }
        case 'estimateMinutes': { const e = parseEstimate(v); if (e !== null) row.estimateMinutes = e; else fail(`invalid estimate "${v}" (use minutes, 90m, 1h30m, or 1.5h)`); break; }
        case 'assignee': if (v.length > 200) fail('assignee must be 200 characters or fewer'); else row.assignee = v; break;
        case 'project': row.project = v; break;
        case 'section': row.section = v; break;
      }
    });
    if (!row.title) fail('title is empty');
    if (!bad) result.rows.push(row);
  }
  return result;
}

function indentWidth(line: string): number {
  return (/^[ \t]*/.exec(line)?.[0] ?? '').replace(/\t/g, '    ').length;
}

function parseLines(text: string): ParsedTaskText {
  const result: ParsedTaskText = { format: 'lines', rows: [], errors: [], ignoredColumns: [] };
  const stack: { indent: number; index: number }[] = [];
  let fence: string | null = null;
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    const trimmed = raw.trim();
    if (fence) { if (trimmed.startsWith(fence)) fence = null; continue; }
    const opened = /^(```|~~~)/.exec(trimmed);
    if (opened) { fence = opened[1]; continue; }
    if (!trimmed || /^#{1,6}\s/.test(trimmed) || /^#{1,6}$/.test(trimmed)) continue;
    const indent = indentWidth(raw);
    let rest = trimmed.replace(/^(?:[-*+]|\d+[.)])\s+/, '');
    let checked = false;
    const box = /^\[([ xX]?)\](?:\s+|$)/.exec(rest);
    if (box) { checked = box[1].toLowerCase() === 'x'; rest = rest.slice(box[0].length); }
    const title = rest.trim();
    if (!title || /^[-*+]$/.test(title)) { result.errors.push({ line: n + 1, message: 'title is empty' }); continue; }
    if (result.rows.length >= MAX_IMPORT_ROWS) {
      result.errors.push({ line: n + 1, message: `more than ${MAX_IMPORT_ROWS} rows` });
      break;
    }
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parentIndex = stack.length ? stack[stack.length - 1].index : null;
    const row: ImportRow = { line: n + 1, title, parentIndex };
    if (checked) row.status = 'done';
    result.rows.push(row);
    stack.push({ indent, index: result.rows.length - 1 });
  }
  return result;
}

export function parseTaskText(text: string, format: ImportFormat = 'auto'): ParsedTaskText {
  const body = text.replace(/^﻿/, '');
  const firstLine = body.split(/\r\n|\r|\n/).find((l) => l.trim() !== '') ?? '';
  const delimiter = detectDelimiter(firstLine);
  if (format === 'lines') return parseLines(body);
  if (format === 'csv') return parseCsv(body, delimiter);
  const cells = splitRecords(firstLine, delimiter).records[0]?.cells ?? [];
  const looksCsv = cells.length >= 2 && cells.some((c) => ALIASES[headerKey(c)] === 'title');
  return looksCsv ? parseCsv(body, delimiter) : parseLines(body);
}

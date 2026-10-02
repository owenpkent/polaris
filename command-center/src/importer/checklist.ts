// Pure markdown -> checklist parsing, plus the stable-id and content-hash helpers used to
// turn parsed checkboxes into ingestible source items. Behavioral spec: the retired scripts/sync_status.py
// (extract_todos / count_completed): a checkbox line is `- [ ]` / `- [x]` (or `*`), case
// insensitive for the x.
//
// Lines indented under a checkbox are that item's description, the way a task description works
// in Asana: they become the task's notes and are written back on export. That is also what makes
// a Next Steps body fully generated -- there is no longer any loose prose in it to preserve,
// because prose about a step now belongs to the step.

import { createHash } from 'node:crypto';

export interface ChecklistItem {
  text: string;
  /** Indented continuation lines under the checkbox, dedented. Empty when there are none. */
  notes: string;
  checked: boolean;
  /** Nesting depth from indentation, 0 for a top-level item. */
  depth: number;
  /** Nearest enclosing ## / ### headings, outermost first. */
  headingPath: string[];
  /** 1-based line number in the source text. */
  line: number;
  /** Index into the same array of this item's immediate parent, or null at depth 0. */
  parentIndex: number | null;
}

const CHECKBOX_RE = /^(\s*)[-*]\s*\[([ xX]?)\]\s*(.*?)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

/** Tabs count as four columns, matching the indent arithmetic used for nesting. */
function indentWidth(text: string): number {
  return (/^\s*/.exec(text)?.[0] ?? '').replace(/\t/g, '    ').length;
}

/** Strip the shallowest indent shared by every non-blank line, so notes read flush. */
function dedent(lines: string[]): string {
  const widths = lines.filter((l) => l.trim()).map(indentWidth);
  const common = widths.length ? Math.min(...widths) : 0;
  return lines.map((l) => (l.trim() ? l.slice(common) : '')).join('\n').replace(/\s+$/, '');
}

/**
 * Split markdown into lines, blanking any inside a fenced code block but keeping the line count
 * so reported line numbers stay right.
 *
 * A checkbox inside a fence is an example, not a task. This parser runs over every project README,
 * CLAUDE.md and docs file as well as its TODO.md, where documenting the checkbox syntax is common,
 * so without this those examples became real tasks and the exporter then rewrote the fence away.
 */
function linesOutsideFences(markdown: string): string[] {
  let fence: string | null = null;
  return markdown.split(/\r\n|\r|\n/).map((line) => {
    const trimmed = line.trim();
    if (fence) {
      if (trimmed.startsWith(fence)) fence = null;
      return '';
    }
    const opened = /^(```|~~~)/.exec(trimmed);
    if (opened) {
      fence = opened[1];
      return '';
    }
    return line;
  });
}

/** Turn markdown into a flat, ordered list of checklist items with structure metadata. */
export function parseChecklist(markdown: string): ChecklistItem[] {
  const lines = linesOutsideFences(markdown);
  const items: ChecklistItem[] = [];
  const headingStack: { level: number; text: string }[] = [];
  const indentStack: { indent: number; index: number }[] = [];
  // The checkbox whose description we are currently collecting, if any.
  let open: { index: number; indent: number; noteLines: string[] } | null = null;

  const closeNotes = (): void => {
    if (!open) return;
    const notes = dedent(open.noteLines);
    if (notes) items[open.index].notes = notes;
    open = null;
  };

  lines.forEach((raw, i) => {
    const h = HEADING_RE.exec(raw);
    if (h) {
      closeNotes();
      const level = h[1].length;
      while (headingStack.length && headingStack[headingStack.length - 1].level >= level) headingStack.pop();
      headingStack.push({ level, text: h[2] });
      return;
    }
    const m = CHECKBOX_RE.exec(raw);
    if (m && (m[2] === '' || m[2] === ' ' || m[2].toLowerCase() === 'x')) {
      closeNotes();
      const indent = indentWidth(m[1]);
      while (indentStack.length && indentStack[indentStack.length - 1].indent >= indent) indentStack.pop();
      const parentIndex = indentStack.length ? indentStack[indentStack.length - 1].index : null;
      const depth = indentStack.length;
      const idx = items.length;
      items.push({
        text: m[3],
        notes: '',
        checked: m[2].toLowerCase() === 'x',
        depth,
        headingPath: headingStack.filter((hh) => hh.level === 2 || hh.level === 3).map((hh) => hh.text),
        line: i + 1,
        parentIndex,
      });
      indentStack.push({ indent, index: idx });
      open = { index: idx, indent, noteLines: [] };
      return;
    }
    if (!open) return;
    // A blank line is held rather than ending the description, so a note can have paragraphs.
    // Trailing blanks are trimmed by dedent, so one that turns out to be the last line is free.
    if (!raw.trim()) { open.noteLines.push(''); return; }
    // Indented past the checkbox means it belongs to that item. Anything at or left of the
    // checkbox is the section speaking again, not the step.
    if (indentWidth(raw) > open.indent) { open.noteLines.push(raw); return; }
    closeNotes();
  });

  closeNotes();
  return items;
}

/** Collapse incidental whitespace so a reflowed but otherwise identical line still matches. */
export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** sourceId = `${projectSlug}:${relativeFile}:${sha1(normalizedText + ':' + occurrenceIndex)}` (12 hex). */
export function makeSourceId(projectSlug: string, relativeFile: string, normalizedText: string, occurrenceIndex: number): string {
  const hash = createHash('sha1').update(`${normalizedText}:${occurrenceIndex}`).digest('hex').slice(0, 12);
  return `${projectSlug}:${relativeFile}:${hash}`;
}

/**
 * contentHash covers text, checked, parent, heading and the description: any of those changing
 * invalidates the hash. The description has to be in here, or upsertFromSource short-circuits on
 * an unchanged hash and an edited note never reaches the task.
 */
export function contentHashOf(
  text: string, checked: boolean, parentSourceId: string | null, headingPath: string[], notes = '',
): string {
  return createHash('sha1').update(JSON.stringify([text, checked, parentSourceId, headingPath, notes])).digest('hex');
}

export interface ChecklistSourceItem {
  sourceId: string;
  parentSourceId: string | null;
  text: string;
  /** The item's description: lines indented under its checkbox. Empty when there are none. */
  notes: string;
  checked: boolean;
  depth: number;
  headingPath: string[];
  line: number;
  contentHash: string;
}

/**
 * Parse markdown and compute stable source ids, parent links (by source id) and content
 * hashes for every checkbox. Occurrence index disambiguates repeated identical text within
 * the same file so re-imports keep assigning the same id to the same line.
 */
export function checklistToSourceItems(markdown: string, projectSlug: string, relativeFile: string): ChecklistSourceItem[] {
  const items = parseChecklist(markdown);
  const seen = new Map<string, number>();
  const sourceIds: string[] = [];
  const out: ChecklistSourceItem[] = [];
  for (const item of items) {
    const norm = normalizeText(item.text);
    const occurrence = seen.get(norm) ?? 0;
    seen.set(norm, occurrence + 1);
    const sourceId = makeSourceId(projectSlug, relativeFile, norm, occurrence);
    sourceIds.push(sourceId);
    const parentSourceId = item.parentIndex != null ? sourceIds[item.parentIndex] : null;
    out.push({
      sourceId,
      parentSourceId,
      text: item.text,
      notes: item.notes,
      checked: item.checked,
      depth: item.depth,
      headingPath: item.headingPath,
      line: item.line,
      contentHash: contentHashOf(item.text, item.checked, parentSourceId, item.headingPath, item.notes),
    });
  }
  return out;
}

/** Source ids that were active before this run but are absent from `currentIds` now. */
export function goneSourceIds(previouslyActive: readonly string[], currentIds: ReadonlySet<string>): string[] {
  return previouslyActive.filter((id) => !currentIds.has(id));
}

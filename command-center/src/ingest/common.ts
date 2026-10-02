// Tiny shared helpers for ingestion sources. Kept intentionally small: a content-hash
// helper, a sync report shape every `sync <source>` command can print, and a dry-run
// preview helper since sources must not call Store's mutating upsert path in --dry-run.

import { createHash } from 'node:crypto';
import type { SourceItem, Store, UpsertResult } from '../core/index.ts';

/** Stable hash over an ordered list of fields. Field order matters; callers own it. */
export function contentHash(...fields: (string | number | boolean | null | undefined)[]): string {
  const h = createHash('sha256');
  for (const f of fields) h.update(String(f ?? '') + '\u0000');
  return h.digest('hex');
}

export interface SyncReport {
  source: string;
  scanned: number;
  created: number;
  updated: number;
  unchanged: number;
  suppressed: number;
  goneCompleted: number;
  errors: string[];
  /** True if the sync stopped early (error, rate limit) and disappearance handling was skipped. */
  partial: boolean;
  apiCalls: number;
  /**
   * How many things the source examined, when that differs from the items it produced
   * (repo-files checks every tracked repo but only reports the checklist items it found).
   */
  checked?: { count: number; noun: string; foundNoun: string };
  /**
   * Things the source could not look at and therefore left exactly as they were (a repo the
   * GitHub App cannot read). Not an error: nothing failed, and nothing was retired.
   */
  skipped?: string[];
}

export function emptyReport(source: string): SyncReport {
  return { source, scanned: 0, created: 0, updated: 0, unchanged: 0, suppressed: 0, goneCompleted: 0, errors: [], partial: false, apiCalls: 0 };
}

export function tallyUpsert(report: SyncReport, action: UpsertResult['action']): void {
  report.scanned++;
  report[action]++;
}

/**
 * Approximate what upsertFromSource would do, without writing. Store keeps the previous
 * source snapshot privately (source_items.snapshot), so this cannot perfectly reproduce the
 * three-way merge or the 'rejected' -> 'suppressed' path; it compares the incoming snapshot
 * to the task's current fields instead. Good enough for a --dry-run preview.
 */
export function previewUpsert(store: Store, item: SourceItem): 'created' | 'updated' | 'unchanged' {
  const existing = store.getTaskBySource(item.sourceType, item.sourceId);
  if (!existing) return 'created';
  const snapshot = { title: item.title.trim(), notes: item.notes ?? '', dueAt: item.dueAt ?? null, priority: item.priority ?? 'none' };
  const same = existing.title === snapshot.title && existing.notes === snapshot.notes
    && existing.dueAt === snapshot.dueAt && existing.priority === snapshot.priority;
  return same ? 'unchanged' : 'updated';
}

function countOf(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

export function formatReport(report: SyncReport): string {
  const counts = `created=${report.created} updated=${report.updated} unchanged=${report.unchanged} ` +
    `suppressed=${report.suppressed} goneCompleted=${report.goneCompleted} apiCalls=${report.apiCalls}`;
  const { checked } = report;
  const lines = [
    checked
      ? `sync ${report.source}: checked ${countOf(checked.count, checked.noun)}, found ${countOf(report.scanned, checked.foundNoun)} (${counts})`
      : `sync ${report.source}: scanned=${report.scanned} ${counts}`,
  ];
  if (report.partial) lines.push('  PARTIAL SYNC: disappearance detection was skipped. See errors below.');
  for (const k of report.skipped ?? []) lines.push(`  skipped: ${k}`);
  for (const e of report.errors) lines.push(`  error: ${e}`);
  return lines.join('\n');
}

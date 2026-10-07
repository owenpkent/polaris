// Bulk task import from pasted text or CSV (owner input, so tasks start open and are never
// flagged untrusted). All or nothing: any error means nothing is created.
import type { ActorInput, Project, Section, Store, Task } from '../core/index.ts';
import { parseTaskText } from './taskText.ts';
import type { ImportError, ImportFormat, ImportRow } from './taskText.ts';

export interface ImportOptions {
  format?: ImportFormat;
  /** Default project reference (id, slug, or name); a row's own project column overrides it. */
  project?: string;
  dryRun?: boolean;
}

export interface ImportPreviewRow extends ImportRow {
  projectSlug: string | null;
  projectName: string | null;
  sectionName: string | null;
}

export interface ImportResult {
  format: 'csv' | 'lines';
  rows: ImportPreviewRow[];
  created: Task[];
  errors: ImportError[];
  ignoredColumns: string[];
}

function findSection(sections: Section[], ref: string): Section | undefined {
  return sections.find((s) => s.id === ref) ?? sections.find((s) => s.name.toLowerCase() === ref.toLowerCase());
}

export function importTasks(store: Store, text: string, opts: ImportOptions = {}, actor: ActorInput = 'human'): ImportResult {
  const parsed = parseTaskText(text, opts.format ?? 'auto');
  const errors: ImportError[] = [...parsed.errors];
  const projects = new Map<string, Project | null>();
  const lookup = (ref: string, line: number): Project | null => {
    if (!projects.has(ref)) {
      const p = store.findProject(ref);
      projects.set(ref, p ?? null);
    }
    const p = projects.get(ref) ?? null;
    if (!p) errors.push({ line, message: `project not found: ${ref}` });
    return p;
  };
  // Existing sections per project; names that do not exist yet are created only on a real run.
  const sectionsOf = new Map<string, Section[]>();
  const knownSections = (projectId: string): Section[] => {
    if (!sectionsOf.has(projectId)) sectionsOf.set(projectId, store.listSections(projectId));
    return sectionsOf.get(projectId)!;
  };

  const defaultRef = opts.project?.trim() || undefined;
  if (defaultRef && !store.findProject(defaultRef)) errors.push({ line: 0, message: `project not found: ${defaultRef}` });

  type Resolved = { projectId: string | null; projectSlug: string | null; projectName: string | null; sectionRef: string | null; sectionName: string | null };
  const resolved: Resolved[] = [];
  parsed.rows.forEach((row) => {
    const parent = row.parentIndex === null ? null : resolved[row.parentIndex];
    let project = null as Project | null;
    if (row.project) project = lookup(row.project, row.line);
    else if (parent) project = parent.projectId ? store.getProject(parent.projectId) ?? null : null;
    else if (defaultRef) project = store.findProject(defaultRef) ?? null;
    let sectionRef = row.section ?? null;
    if (!row.section && parent && !row.project) sectionRef = parent.sectionRef;
    if (row.section && !project) errors.push({ line: row.line, message: 'section requires a project' });
    let sectionName: string | null = null;
    if (sectionRef && project) sectionName = findSection(knownSections(project.id), sectionRef)?.name ?? sectionRef;
    resolved.push({ projectId: project?.id ?? null, projectSlug: project?.slug ?? null, projectName: project?.name ?? null, sectionRef: project ? sectionRef : null, sectionName });
  });

  const rows: ImportPreviewRow[] = parsed.rows.map((r, i) => ({
    ...r, projectSlug: resolved[i].projectSlug, projectName: resolved[i].projectName, sectionName: resolved[i].sectionName,
  }));
  errors.sort((a, b) => a.line - b.line);
  const result: ImportResult = { format: parsed.format, rows, created: [], errors, ignoredColumns: parsed.ignoredColumns };
  if (opts.dryRun || errors.length > 0 || parsed.rows.length === 0) {
    if (!opts.dryRun && errors.length === 0 && parsed.rows.length === 0) result.errors.push({ line: 0, message: 'no tasks found' });
    return result;
  }

  result.created = store.db.transaction(() => {
    const made: Task[] = [];
    parsed.rows.forEach((row, i) => {
      const r = resolved[i];
      let sectionId: string | null = null;
      if (r.sectionRef && r.projectId) {
        const sections = store.listSections(r.projectId);
        sectionId = (findSection(sections, r.sectionRef) ?? store.ensureSection(r.projectId, r.sectionRef)).id;
      }
      made.push(store.createTask({
        title: row.title, notes: row.notes, status: row.status ?? 'open', priority: row.priority, dueAt: row.dueAt, startAt: row.startAt,
        estimateMinutes: row.estimateMinutes, assignee: row.assignee, projectId: r.projectId, sectionId,
        parentId: row.parentIndex === null ? null : made[row.parentIndex].id, sourceType: 'manual',
      }, actor));
    });
    return made;
  });
  return result;
}

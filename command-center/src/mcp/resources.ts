// MCP resources: today's agenda, today's digest, and a per-project summary template.
import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { App } from '../app.ts';
import { buildDigest } from '../automation/index.ts';
import { ACTIVE_STATUSES, type Task } from '../core/index.ts';
import { agendaMarkdown, projectSummaryMarkdown } from './format.ts';
import { addDays } from './shared.ts';

export function registerResources(server: McpServer, app: App): void {
  server.registerResource(
    'agenda_today',
    'polaris://agenda/today',
    { description: "Today's agenda: tasks due today, overdue tasks, and the inbox count. Markdown.", mimeType: 'text/markdown' },
    (uri) => {
      const today = app.today();
      const dueToday = app.store.searchTasks({ status: [...ACTIVE_STATUSES], dueAfter: today, dueBefore: addDays(today, 1), orderBy: 'due' });
      const overdue = app.store.searchTasks({ status: [...ACTIVE_STATUSES], dueBefore: today, orderBy: 'due' });
      const inboxCount = app.store.countTasks({ status: ['inbox'] });
      const text = agendaMarkdown(today, dueToday, overdue, inboxCount);
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
    },
  );

  server.registerResource(
    'digest_today',
    'polaris://digest/today',
    { description: "Today's automated digest, rendered by the rules engine (Phase 4). Markdown.", mimeType: 'text/markdown' },
    (uri) => {
      const digest = buildDigest(app.store, { today: app.today() });
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: digest.markdown }] };
    },
  );

  const projectTemplate = new ResourceTemplate('polaris://projects/{slug}', {
    list: () => ({
      resources: app.store.listProjects().map((p) => ({ uri: `polaris://projects/${p.slug}`, name: p.name, mimeType: 'text/markdown' })),
    }),
  });

  server.registerResource(
    'project_summary',
    projectTemplate,
    { description: 'Project summary: fields, sections, open tasks grouped by section, and recent completions. {slug} may be a project id, slug, or name. Markdown.' },
    (uri, variables) => {
      const ref = Array.isArray(variables.slug) ? variables.slug[0] : variables.slug;
      const project = app.store.findProject(ref);
      if (!project) throw new Error(`project not found: ${ref}`);
      const sections = app.store.listSections(project.id);
      const open = app.store.searchTasks({ projectId: project.id, status: [...ACTIVE_STATUSES], limit: 1000 });
      const bySection = new Map<string | null, Task[]>();
      for (const t of open) {
        const list = bySection.get(t.sectionId) ?? [];
        list.push(t);
        bySection.set(t.sectionId, list);
      }
      const sectionGroups = sections.map((section) => ({ section, tasks: bySection.get(section.id) ?? [] }));
      const unsectioned = bySection.get(null) ?? [];
      const recentlyCompleted = app.store.searchTasks({ projectId: project.id, status: ['done'], orderBy: 'updated', limit: 5 });
      const text = projectSummaryMarkdown(project, sectionGroups, unsectioned, recentlyCompleted);
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
    },
  );
}

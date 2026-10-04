// The one MCP write tool for projects, so an agent asked to plan some work can make the project
// its tasks go in. It uses actor 'agent', the same trust level the task tools have, and is only
// registered on the write endpoint. Agents cannot rename, edit, or archive a project: the owner decided
// on 2026-09-20 that those stay in the dashboard. `path`, `todoFile`, and `meta` belong to the importers.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { App } from '../app.ts';
import type { ActorInput } from '../core/index.ts';
import { parseBody, projectCreateBodySchema } from '../http/schemas.ts';
import { TOOL_CATALOG } from './catalog.ts';
import { guard, ok } from './shared.ts';


const desc = (name: string): string => TOOL_CATALOG.find((t) => t.name === name)?.description ?? name;

export function registerProjectWriteTools(server: McpServer, app: App, actor: ActorInput): void {
  server.registerTool('create_project', {
    description: desc('create_project'),
    inputSchema: {
      name: z.string().min(1),
      type: z.string().optional().describe('Free text, for example "Software / Desktop app".'),
      status: z.string().optional().describe('Free text, for example "Active" or "On hold".'),
      description: z.string().optional().describe('Markdown.'),
      github: z.string().optional().describe('owner/repo or a github.com URL. Leave it out for a project with no repo.'),
      category: z.string().optional(),
    },
  }, (args) => guard(() => {
    const project = app.store.createProject(parseBody(projectCreateBodySchema, args), actor);
    return ok(`Created project ${project.slug}: ${project.name}. Add tasks to it with create_task.`, { project });
  }));
}

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from '../cli-types.ts';
import { parseFlags } from '../cli-types.ts';
import { renderStatusDoc } from '../export/status-doc.ts';
import { hasInitiatives, importInitiativeFiles, initiativesDir } from './initiatives.ts';

const importCommand: Command = {
  name: 'import',
  summary: 'Import the initiatives/*.md files into the task graph, for a repo that keeps plans in that shape; a checkout without initiatives/ has nothing to import. Repos become projects on the dashboard\'s GitHub page, and their checklists come from `sync repo-files`.',
  run(_args, { openApp, stdout }) {
    const app = openApp();
    try {
      if (!hasInitiatives(app.config.repoRoot)) {
        stdout(`Nothing to import: no initiatives folder at ${initiativesDir(app.config.repoRoot)}. The importer is for a repo that keeps plans as initiatives/*.md; set CC_REPO_ROOT to point at one.`);
        return 0;
      }
      const initiativeFiles = importInitiativeFiles(app.store, app.config.repoRoot);

      stdout('Command Center import summary');
      stdout('==============================');
      stdout(
        `initiatives/*.md: created ${initiativeFiles.created}, updated ${initiativeFiles.updated}, unchanged ${initiativeFiles.unchanged}` +
          ` | tasks created ${initiativeFiles.tasks.created}, updated ${initiativeFiles.tasks.updated}, unchanged ${initiativeFiles.tasks.unchanged}, gone ${initiativeFiles.tasks.gone}`,
      );

      stdout('');
      stdout(`Projects in DB: ${app.store.listProjects({ includeArchived: true }).length}`);
      return 0;
    } finally {
      app.close();
    }
  },
};

interface WriteOpts {
  check: boolean;
  dryRun: boolean;
}

function normalizeForCompare(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

function writeOrCheck(
  path: string,
  content: string,
  opts: WriteOpts,
  stdout: (s: string) => void,
  stderr: (s: string) => void,
  label: string,
): { differs: boolean } {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const differs = existing === null || normalizeForCompare(existing) !== normalizeForCompare(content);

  if (opts.dryRun) {
    stdout(`----- ${label} (${path}) -----`);
    stdout(content);
    return { differs };
  }
  if (opts.check) {
    if (differs) stderr(`${label} differs from ${path}`);
    else stdout(`${label} matches ${path}`);
    return { differs };
  }
  if (differs) {
    writeFileSync(path, content, 'utf8');
    stdout(`Wrote ${label} -> ${path}`);
  } else {
    stdout(`${label} unchanged, not written`);
  }
  return { differs };
}

const exportCommand: Command = {
  name: 'export',
  summary: 'Regenerate PROJECT_STATUS.md from the task graph.',
  usage: '[--check] [--dry-run]',
  run(args, { openApp, stdout, stderr }) {
    const flags = parseFlags(args);
    const opts: WriteOpts = { check: Boolean(flags.check), dryRun: Boolean(flags['dry-run']) };

    const app = openApp();
    try {
      const path = join(app.config.repoRoot, 'PROJECT_STATUS.md');
      const { differs } = writeOrCheck(path, renderStatusDoc(app.store), opts, stdout, stderr, 'PROJECT_STATUS.md');
      return opts.check && differs ? 1 : 0;
    } finally {
      app.close();
    }
  },
};

export const commands: Command[] = [importCommand, exportCommand];

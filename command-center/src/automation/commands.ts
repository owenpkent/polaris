import { basename, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Command } from '../cli-types.ts';
import { parseFlags } from '../cli-types.ts';
import { buildDigest, markDigestDelivered } from './digest.ts';
import { listNotifications, runRules, validateRuleDefinition } from './rules.ts';
import { builtinViews, runView } from './views.ts';

function formatTaskLine(t: { id: string; title: string; status: string; priority: string; dueAt: string | null }): string {
  const due = t.dueAt ? ` due ${t.dueAt}` : '';
  const pri = t.priority !== 'none' ? ` [${t.priority}]` : '';
  return `  ${t.id}  ${t.status.padEnd(11)} ${t.title}${due}${pri}`;
}

const viewCmd: Command = {
  name: 'view',
  summary: 'Show tasks in a built-in or saved view.',
  usage: 'cc view <name> [--json]',
  run(args, { openApp, stdout, stderr }) {
    const flags = parseFlags(args);
    const name = flags._[0];
    if (!name) { stderr('usage: cc view <name> [--json]'); return 1; }
    const app = openApp();
    try {
      const { view, tasks } = runView(app.store, name, app.today());
      if (flags.json) {
        stdout(JSON.stringify({ view: view.name, description: view.description, tasks }, null, 2));
      } else {
        stdout(`${view.name} - ${view.description} (${tasks.length})`);
        for (const t of tasks) stdout(formatTaskLine(t));
      }
      return 0;
    } catch (e) {
      stderr(e instanceof Error ? e.message : String(e));
      return 1;
    } finally {
      app.close();
    }
  },
};

const viewsCmd: Command = {
  name: 'views',
  summary: 'List built-in and saved views.',
  run(_args, { openApp, stdout }) {
    const app = openApp();
    try {
      stdout('Built-in:');
      for (const v of builtinViews(app.today())) stdout(`  ${v.name.padEnd(20)} ${v.description}`);
      const saved = app.store.listViews();
      stdout('Saved:');
      if (!saved.length) stdout('  (none)');
      for (const v of saved) stdout(`  ${v.name} (${v.id})`);
      return 0;
    } finally {
      app.close();
    }
  },
};

const digestCmd: Command = {
  name: 'digest',
  summary: 'Print the daily digest, or write it to disk with --write.',
  usage: 'cc digest [--write]',
  run(args, { openApp, stdout }) {
    const flags = parseFlags(args);
    const app = openApp();
    try {
      const digest = buildDigest(app.store, { today: app.today() });
      if (flags.write) {
        const dir = join(app.config.repoRoot, 'command-center', 'data', 'digests');
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${digest.date}.md`);
        writeFileSync(file, digest.markdown, 'utf8');
        markDigestDelivered(app.store, new Date().toISOString());
        stdout(`wrote ${file}`);
      } else {
        stdout(digest.markdown);
      }
      return 0;
    } finally {
      app.close();
    }
  },
};

const rulesListCmd: Command = {
  name: 'rules list',
  summary: 'List rules.',
  run(_args, { openApp, stdout }) {
    const app = openApp();
    try {
      const rules = app.store.listRules();
      if (!rules.length) { stdout('(no rules)'); return 0; }
      for (const r of rules) stdout(`${r.id}  ${r.enabled ? 'on ' : 'off'}  ${r.name}`);
      return 0;
    } finally {
      app.close();
    }
  },
};

const rulesAddCmd: Command = {
  name: 'rules add',
  summary: 'Add a rule from a JSON definition file.',
  usage: 'cc rules add --file <path> [--name <name>] [--enable]',
  run(args, { openApp, stdout, stderr }) {
    const flags = parseFlags(args);
    const file = flags.file;
    if (typeof file !== 'string') { stderr('usage: cc rules add --file <path> [--name <name>] [--enable]'); return 1; }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      stderr(`could not read/parse ${file}: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }

    // The file may carry an optional top-level "name" alongside the rule definition
    // (trigger/conditions/actions); strip it before validating the definition itself.
    const isObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
    const fileName = isObject ? (parsed as { name?: unknown }).name : undefined;
    const definitionCandidate = isObject ? { ...(parsed as Record<string, unknown>) } : parsed;
    if (isObject) delete (definitionCandidate as Record<string, unknown>).name;

    const validation = validateRuleDefinition(definitionCandidate);
    if (!validation.ok || !validation.normalized) {
      stderr('invalid rule definition:');
      for (const err of validation.errors) stderr(`  - ${err}`);
      return 1;
    }

    const providedName = flags.name;
    const name = typeof providedName === 'string' ? providedName : typeof fileName === 'string' ? fileName : basename(file).replace(/\.json$/i, '');

    const app = openApp();
    try {
      const rule = app.store.saveRule({ name, enabled: Boolean(flags.enable), definition: validation.normalized });
      stdout(`created rule ${rule.id} (${rule.enabled ? 'enabled' : 'disabled'}): ${rule.name}`);
      return 0;
    } finally {
      app.close();
    }
  },
};

function setEnabled(enabled: boolean): Command['run'] {
  return (args, { openApp, stdout, stderr }) => {
    const target = args[0];
    if (!target) { stderr(`usage: cc rules ${enabled ? 'enable' : 'disable'} <id-or-name>`); return 1; }
    const app = openApp();
    try {
      const rule = app.store.getRule(target);
      if (!rule) { stderr(`rule '${target}' not found`); return 1; }
      app.store.saveRule({ id: rule.id, name: rule.name, enabled, definition: rule.definition });
      stdout(`${enabled ? 'enabled' : 'disabled'} ${rule.id} (${rule.name})`);
      return 0;
    } finally {
      app.close();
    }
  };
}

const rulesEnableCmd: Command = {
  name: 'rules enable',
  summary: 'Enable a rule.',
  usage: 'cc rules enable <id-or-name>',
  run: setEnabled(true),
};

const rulesDisableCmd: Command = {
  name: 'rules disable',
  summary: 'Disable a rule.',
  usage: 'cc rules disable <id-or-name>',
  run: setEnabled(false),
};

const rulesDeleteCmd: Command = {
  name: 'rules delete',
  summary: 'Delete a rule.',
  usage: 'cc rules delete <id-or-name>',
  run(args, { openApp, stdout, stderr }) {
    const id = args[0];
    if (!id) { stderr('usage: cc rules delete <id-or-name>'); return 1; }
    const app = openApp();
    try {
      const rule = app.store.getRule(id);
      if (!rule) { stderr(`rule '${id}' not found`); return 1; }
      app.store.deleteRule(rule.id);
      stdout(`deleted ${rule.id} (${rule.name})`);
      return 0;
    } finally {
      app.close();
    }
  },
};

const rulesRunCmd: Command = {
  name: 'rules run',
  summary: 'Evaluate rules against new events and scheduled conditions.',
  usage: 'cc rules run [--rule <id-or-name>] [--dry-run]',
  run(args, { openApp, stdout }) {
    const flags = parseFlags(args);
    const app = openApp();
    try {
      const report = runRules(app.store, {
        today: app.today(),
        ruleId: typeof flags.rule === 'string' ? flags.rule : undefined,
        dryRun: Boolean(flags['dry-run']),
      });
      stdout(JSON.stringify(report, null, 2));
      return report.errors.length ? 1 : 0;
    } finally {
      app.close();
    }
  },
};

const notificationsCmd: Command = {
  name: 'notifications',
  summary: 'List notifications recorded by rule "notify" actions.',
  usage: 'cc notifications [--since <iso>]',
  run(args, { openApp, stdout }) {
    const flags = parseFlags(args);
    const app = openApp();
    try {
      const items = listNotifications(app.store, typeof flags.since === 'string' ? flags.since : undefined);
      if (!items.length) { stdout('(none)'); return 0; }
      for (const n of items) stdout(`${n.at}  ${n.ruleName}  ${n.message}${n.taskId ? `  (${n.taskId})` : ''}`);
      return 0;
    } finally {
      app.close();
    }
  },
};

export const commands: Command[] = [
  viewCmd, viewsCmd, digestCmd,
  rulesListCmd, rulesAddCmd, rulesEnableCmd, rulesDisableCmd, rulesDeleteCmd, rulesRunCmd,
  notificationsCmd,
];

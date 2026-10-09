import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Command } from '../../cli-types.ts';
import { parseFlags } from '../../cli-types.ts';
import { formatReport } from '../common.ts';
import { defaultGithubSecretStore, clearUserToken, loadApp } from './app.ts';
import { describeGithubAuth, resolveGithubAuth } from './auth.ts';
import { fetchInstallationRepos, fetchUserInstallations } from './installations.ts';
import { getRepoSettings } from './repoSettings.ts';
import { syncGithubRepoFiles } from './repoFiles.ts';
import { syncGithub } from './sync.ts';
import { createWebhookHandler } from './webhook.ts';
import { warnIfNotLoopback } from '../../http/commands.ts';

const syncGithubCommand: Command = {
  name: 'sync github',
  summary: 'Pull assigned issues/PRs, review requests, and own-PR attention items from GitHub (read-only).',
  usage: '[--dry-run] [--verbose]',
  async run(args, { openApp, stdout, stderr }) {
    const flags = parseFlags(args);
    const app = openApp();
    try {
      const report = await syncGithub(app.store, {
        dryRun: Boolean(flags['dry-run']),
        log: flags.verbose ? (line: string) => stdout(line) : undefined,
      });
      stdout(formatReport(report));
      return report.partial ? 1 : 0;
    } catch (e) {
      stderr(e instanceof Error ? e.message : String(e));
      return 1;
    } finally {
      app.close();
    }
  },
};

const syncRepoFilesCommand: Command = {
  name: 'sync repo-files',
  summary: 'Fetch the TODO/README/CLAUDE/docs checklists of every project with a GitHub repo (read-only).',
  usage: '[--dry-run] [--verbose]',
  async run(args, { openApp, stdout, stderr }) {
    const flags = parseFlags(args);
    const app = openApp();
    try {
      const report = await syncGithubRepoFiles(app.store, {
        dryRun: Boolean(flags['dry-run']),
        log: flags.verbose ? (line: string) => stdout(line) : undefined,
      });
      stdout(formatReport(report));
      return report.partial ? 1 : 0;
    } catch (e) {
      stderr(e instanceof Error ? e.message : String(e));
      return 1;
    } finally {
      app.close();
    }
  },
};

const webhookCommand: Command = {
  name: 'github webhook',
  summary: 'Run a local HTTP server that receives GitHub webhook events and re-syncs the affected item.',
  usage: '[--port 8787] [--host 127.0.0.1] (secret comes from GITHUB_WEBHOOK_SECRET)',
  run(args, { openApp, stdout, stderr }) {
    const flags = parseFlags(args);
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      stderr('GITHUB_WEBHOOK_SECRET is not set; refusing to start the webhook receiver.');
      return 1;
    }
    const port = Number(flags.port ?? 8787);
    // Loopback like `serve`: GitHub reaches it through a tunnel or proxy on this machine.
    const host = typeof flags.host === 'string' ? flags.host : '127.0.0.1';
    warnIfNotLoopback(host, stderr);
    const app = openApp();
    const handler = createWebhookHandler(app, { secret, log: stdout });
    const server = createServer(handler);
    return new Promise<number>((resolvePromise) => {
      server.listen(port, host, () => {
        const bound = server.address() as AddressInfo;
        stdout(`github webhook listening on ${bound.address}:${bound.port}`);
      });
      const shutdown = () => {
        process.off('SIGINT', shutdown);
        process.off('SIGTERM', shutdown);
        server.close(() => { app.close(); resolvePromise(0); });
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
  },
};

const statusCommand: Command = {
  name: 'github status',
  summary: 'Show the GitHub App configuration, sign-in status, installations, and repo switches. Never prints secrets.',
  usage: '',
  async run(_args, { openApp, stdout, stderr }) {
    const app = openApp();
    try {
      const secrets = defaultGithubSecretStore();
      const appConfig = await loadApp(secrets);
      stdout(appConfig ? `GitHub App: ${appConfig.slug} (${appConfig.name})` : 'GitHub App: not configured');
      const status = await describeGithubAuth({ secrets });
      stdout(`Auth mode: ${status.mode}`);
      if (status.mode === 'app' && status.login) stdout(`Signed in as: ${status.login}`);
      if (status.mode !== 'app') return 0;
      try {
        const token = await resolveGithubAuth({ secrets });
        const installations = await fetchUserInstallations(token);
        if (!installations.length) stdout('Installations: none');
        let syncOn = 0;
        let checklistsOn = 0;
        let total = 0;
        for (const installation of installations) {
          stdout(`Installation: ${installation.account.login} (${installation.repository_selection} repos)`);
          const repos = await fetchInstallationRepos(token, installation.id);
          for (const repo of repos) {
            total++;
            const settings = getRepoSettings(app.store, repo.full_name);
            if (settings.syncIssues) syncOn++;
            if (settings.readChecklists) checklistsOn++;
          }
        }
        stdout(`Repos: ${total} total, ${syncOn} with sync issues on, ${checklistsOn} with read checklists on`);
      } catch (e) {
        stderr(`Could not list installations: ${e instanceof Error ? e.message : String(e)}`);
      }
      return 0;
    } finally {
      app.close();
    }
  },
};

const logoutCommand: Command = {
  name: 'github logout',
  summary: 'Clear the stored GitHub App user token (keeps the app registration).',
  usage: '',
  async run(_args, { stdout, stderr }) {
    try {
      await clearUserToken(defaultGithubSecretStore());
      stdout('Signed out of GitHub.');
      return 0;
    } catch (e) {
      stderr(e instanceof Error ? e.message : String(e));
      return 1;
    }
  },
};

export const commands: Command[] = [syncGithubCommand, syncRepoFilesCommand, webhookCommand, statusCommand, logoutCommand];

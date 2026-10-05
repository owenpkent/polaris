// Long-running process: schedules every job, serves the HTTP API and MCP endpoint, and shuts down cleanly.

import { dirname } from 'node:path';
import type { App } from '../app.ts';
import { createScheduler } from '../automation/index.ts';
import { corsOriginsFromEnv, resolveDashboardDir, startHttp, tailscaleIdentityLine, tailscaleLoginFromEnv, type RunningHttp } from '../http/commands.ts';
import { resolveTokens } from '../http/token.ts';
import type { JobStatus } from '../http/types.ts';
import { dueAtStartup, JOBS, runJob } from './jobs.ts';

export interface DaemonOptions {
  http: boolean;
  port: number;
  host: string;
  readonlyMcp: boolean;
  only: string[];
  skip: string[];
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  /** Resolves when the daemon should stop. Defaults to SIGINT or SIGTERM. */
  until?: Promise<void>;
}

export async function runDaemon(app: App, opts: DaemonOptions): Promise<number> {
  const jobs = JOBS.filter((j) => (!opts.only.length || opts.only.includes(j.name)) && !opts.skip.includes(j.name));
  const running = new Set<string>();
  const stamp = () => new Date().toISOString().slice(11, 19);
  const log = (s: string) => opts.stdout(`${stamp()} ${s}`);

  const scheduler = createScheduler({
    timezone: app.config.timezone,
    jobs: jobs.map((job) => ({
      name: job.name,
      everyMs: job.everyMs,
      dailyAt: job.dailyAt,
      run: async () => {
        running.add(job.name);
        try {
          const outcome = await runJob(app, job, (line) => opts.stderr(`${stamp()} [${job.name}] ${line}`));
          // Rules run every minute; only log them when something happened.
          if (job.name !== 'rules' || !/ 0 fired$/.test(outcome.message)) log(outcome.message);
          if (!outcome.ok) throw new Error(outcome.message);
        } finally {
          running.delete(job.name);
        }
      },
    })),
  });

  const getJobStatus = (): Record<string, JobStatus> => Object.fromEntries(jobs.map((j) => [j.name, {
    lastRunAt: app.store.getKv<string>(`sync.${j.name}.lastAt`) ?? null,
    lastError: app.store.getKv<string | null>(`sync.${j.name}.lastError`) ?? null,
    running: running.has(j.name),
  }]));

  let http: RunningHttp | null = null;
  if (opts.http) {
    try {
      const dashboardDir = resolveDashboardDir(app.config, opts.stderr);
      const tailscaleLogin = tailscaleLoginFromEnv();
      http = await startHttp(app, {
        port: opts.port,
        host: opts.host,
        tokens: resolveTokens(app.config.dbPath),
        corsOrigins: corsOriginsFromEnv(),
        tailscaleLogin,
        readonlyMcp: opts.readonlyMcp,
        webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
        dashboardDir,
        jobs: Object.fromEntries(jobs.map((j) => [j.name, () => scheduler.runNow(j.name)])),
        getJobStatus,
      });
      log(`HTTP API and MCP endpoint at ${http.url} (tokens: api-token, mcp-token, mcp-readonly-token in ${dirname(app.config.dbPath)})`);
      if (dashboardDir) log(`Dashboard at ${http.url}/`);
      if (tailscaleLogin) log(tailscaleIdentityLine(tailscaleLogin));
    } catch (e) {
      scheduler.stop();
      opts.stderr(`Could not start HTTP server: ${e instanceof Error ? e.message : String(e)}`);
      app.close();
      return 1;
    }
  }

  log(`Scheduled ${jobs.map((j) => `${j.name}(${j.everyMs ? `${j.everyMs / 60_000}m` : j.dailyAt})`).join(', ')}`);

  // Initial pass so the graph is fresh at startup; the scheduler otherwise waits one interval.
  let stopping = false;
  const initial = (async () => {
    for (const j of jobs) {
      if (stopping) break;
      if (!dueAtStartup(app, j)) continue;
      await scheduler.runNow(j.name).catch(() => {});
    }
  })();

  await (opts.until ?? new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  }));

  stopping = true;
  log('Shutting down...');
  scheduler.stop();
  await http?.close();
  await initial;
  app.close();
  return 0;
}

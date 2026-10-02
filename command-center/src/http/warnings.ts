// What the dashboard should tell the owner about the jobs without being asked: one that is failing,
// and a backup that has gone quiet. Pure, so it can be tested without a daemon.
import type { JobStatus } from './types.ts';

export interface JobWarning { job: string; message: string }

/** A nightly backup that is this old has missed a night and its catch-up. */
export const BACKUP_STALE_MS = 36 * 60 * 60_000;

export function jobWarnings(jobs: Record<string, JobStatus>, now: Date = new Date()): JobWarning[] {
  const warnings: JobWarning[] = [];
  for (const [job, status] of Object.entries(jobs)) {
    if (status.lastError) warnings.push({ job, message: `The ${job} job is failing: ${status.lastError.split('\n')[0]}` });
  }
  const backup = jobs.backup;
  // A failing backup is already listed above, and one that is running is about to answer for itself.
  if (backup && !backup.lastError && !backup.running) {
    if (!backup.lastRunAt) {
      warnings.push({ job: 'backup', message: 'The database has never been backed up.' });
    } else {
      const age = now.getTime() - Date.parse(backup.lastRunAt);
      if (age > BACKUP_STALE_MS) warnings.push({ job: 'backup', message: `The last database backup is ${Math.floor(age / (24 * 60 * 60_000))} day(s) old.` });
    }
  }
  return warnings;
}

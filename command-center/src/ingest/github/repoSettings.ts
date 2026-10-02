// Per-repo switches for the two things Polaris reads from GitHub: issues/PRs/checks, and
// the checklist files read by `sync repo-files`. Stored as one kv row keyed by lowercased
// "owner/repo" (GitHub's own casing is preserved everywhere else; only the lookup key is folded).
// Both switches default to true when a repo has no stored entry -- the app's own repo selection
// on GitHub already narrows access, so Polaris starts from "sync everything it can see".
import type { Json, Store } from '../../core/index.ts';

const KV_KEY = 'github:repo-settings';

export interface RepoSettings {
  syncIssues: boolean;
  readChecklists: boolean;
}

const DEFAULTS: RepoSettings = { syncIssues: true, readChecklists: true };

type StoredSettings = Record<string, Partial<RepoSettings>>;

function readAll(store: Store): StoredSettings {
  const raw = store.getKv<Json>(KV_KEY);
  return (raw ?? {}) as unknown as StoredSettings;
}

function writeAll(store: Store, value: StoredSettings): void {
  store.setKv(KV_KEY, value as unknown as Json);
}

export function getRepoSettings(store: Store, fullName: string): RepoSettings {
  const entry = readAll(store)[fullName.toLowerCase()];
  return { ...DEFAULTS, ...entry };
}

export function isSyncIssuesEnabled(store: Store, fullName: string): boolean {
  return getRepoSettings(store, fullName).syncIssues;
}

export function isReadChecklistsEnabled(store: Store, fullName: string): boolean {
  return getRepoSettings(store, fullName).readChecklists;
}

export function setRepoSettings(store: Store, fullName: string, patch: Partial<RepoSettings>): RepoSettings {
  const all = readAll(store);
  const key = fullName.toLowerCase();
  const merged: RepoSettings = { ...DEFAULTS, ...all[key], ...patch };
  writeAll(store, { ...all, [key]: merged });
  return merged;
}

export * from './types.ts';
export * from './agentName.ts';
export * from './store.ts';
export * from './outbox.ts';
export * from './restore.ts';
export * from './dueAt.ts';
export * from './recurrenceCount.ts';
export { openNodeDriver, migrate, countRows, inspectDatabaseFile, type SqlDriver, type SqlValue, type DatabaseCounts, type DatabaseInspection } from './db.ts';

import { openNodeDriver } from './db.ts';
import { Store, type StoreOptions } from './store.ts';

export function openStore(path: string, opts: StoreOptions = {}): Store {
  return new Store(openNodeDriver(path, { timezone: opts.timezone }), opts);
}

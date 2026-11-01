// Which exceptions are the code's documented answer to bad input, and so not findings. Everything
// else (a TypeError, a RangeError, a stack overflow, a hang, running out of memory) propagates to
// Jazzer.js and is reported as a crash.
import { PatternError } from '../../src/automation/pattern.ts';
import { BackupDecryptError } from '../../src/daemon/backupCrypto.ts';

/** recurrence.ts refuses a rule or a date with an Error whose message starts with "invalid ". */
export function isInvalidRuleError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('invalid ');
}

/** dueAt.ts refuses a typed time of day out of range with one message. */
export function isDueInputError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('not a time of day');
}

/** pattern.ts refuses a pattern it does not accept with its own error class. */
export function isPatternError(err: unknown): boolean {
  return err instanceof PatternError;
}

/** backupCrypto.ts refuses a damaged file, a wrong passphrase, or a foreign file with one class. */
export function isBackupDecryptError(err: unknown): boolean {
  return err instanceof BackupDecryptError;
}

/** JSON.parse on text that is not JSON. The targets that read JSON skip such an input. */
export function isJsonSyntaxError(err: unknown): boolean {
  return err instanceof SyntaxError;
}

/** Rethrows `err` unless `expected` says the code raised it on purpose. */
export function rethrowUnless(err: unknown, expected: (err: unknown) => boolean): void {
  if (!expected(err)) throw err;
}

/** The passphrase the backup seed is encrypted with (fuzz/make-seeds.mjs) and the target decrypts with. */
export const BACKUP_PASSPHRASE = 'fuzz corpus passphrase 2026';

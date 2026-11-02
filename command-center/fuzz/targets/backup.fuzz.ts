import { decryptBytes } from '../../src/daemon/backupCrypto.ts';
import { BACKUP_PASSPHRASE, isBackupDecryptError, rethrowUnless } from './expected.ts';

// The encrypted backup container (format at the top of backupCrypto.ts): a file that came back
// from a NAS, a synced folder, or a bucket, and so may be damaged or forged. A header can ask for
// up to 2^20 scrypt work, which is deliberate for a real restore and far too slow and large for a
// fuzzer, so the log2(N) byte is capped at 12 before the bytes are read; values under 10 still
// reach the refusal. Any outcome but the plaintext or BackupDecryptError is a finding. The seed is a
// real container encrypted with BACKUP_PASSPHRASE, so the authenticated path is reached too.
export function fuzz(data: Buffer): void {
  const bytes = Buffer.from(data);
  if (bytes.length > 5 && bytes[5] > 12) bytes[5] = 12;
  try {
    decryptBytes(bytes, BACKUP_PASSPHRASE, 'fuzz input');
  } catch (err) {
    rethrowUnless(err, isBackupDecryptError);
  }
}

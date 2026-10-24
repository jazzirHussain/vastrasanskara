import { istDate, istTime } from '@vs/shared/fy.js';
import { clock } from '../../clock.js';
import { emitToAllBranches } from '../notify/emit.js';

/** mongodump/YYYY/MM/DD/HHmm.archive.gz, in IST. */
export function backupKey(now) {
  return `mongodump/${istDate(now).replaceAll('-', '/')}/${istTime(now).replace(':', '')}.archive.gz`;
}

/**
 * Streams a database dump into the backups bucket. On failure every branch's owners are
 * alerted and the error is rethrown (so the job is also recorded as failed).
 */
export async function runBackup({ now = clock.now(), dump, storage }) {
  const key = backupKey(now);
  try {
    const body = await dump();
    await storage.putObject({ key, body, contentType: 'application/gzip' });
    return { key };
  } catch (err) {
    await emitToAllBranches('system.backup_failed', { refId: key, vars: { error: err.message } });
    throw err;
  }
}

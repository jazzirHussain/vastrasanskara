import mongoose from 'mongoose';
import { istDate, istTime } from '@vs/shared/fy.js';
import { clock } from '../../clock.js';
import { emitToAllBranches } from '../notify/emit.js';

const LAST_BACKUP_ID = 'last-backup';
const system = () => mongoose.connection.collection('system');

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
    await system().updateOne({ _id: LAST_BACKUP_ID }, { $set: { at: now, key } }, { upsert: true });
    return { key };
  } catch (err) {
    await emitToAllBranches('system.backup_failed', { refId: key, vars: { error: err.message } });
    throw err;
  }
}

/** The last successful backup: { at, key }, or null before the first one. */
export async function lastBackup() {
  const doc = await system().findOne({ _id: LAST_BACKUP_ID });
  return doc ? { at: doc.at, key: doc.key } : null;
}

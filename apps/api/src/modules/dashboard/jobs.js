import { istDate, istTime } from '@vs/shared/fy.js';
import { clock } from '../../clock.js';
import { defineJob } from '../../core/jobs/registry.js';
import { listBranchIds } from '../branches/service.js';
import { hasSnapshot, takeSnapshot } from './snapshots.js';

export const SNAPSHOT_AFTER = '23:30';

/** Snapshots each branch once its IST time is 23:30 or later and today's snapshot is missing. Idempotent. */
export async function runDashboardSnapshots({ now = clock.now() } = {}) {
  if (istTime(now) < SNAPSHOT_AFTER) return;
  const date = istDate(now);
  for (const branchId of await listBranchIds()) {
    if (!(await hasSnapshot(branchId, date))) await takeSnapshot(branchId, date);
  }
}

// Every 30 minutes; only the runs at or after 23:30 IST take the day's snapshot.
defineJob('dashboard-snapshot', { schedule: '*/30 * * * *', handler: () => runDashboardSnapshots() });

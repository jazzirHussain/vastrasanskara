import { istDate } from '@vs/shared/fy.js';
import { clock } from '../../clock.js';
import { emitToAllBranches } from '../notify/emit.js';

export const WARN_RATIO = 0.7;
const MB = 1024 * 1024;

/**
 * Warns the owners (at most once per IST day) when the database uses 70% or more of the
 * plan's storage quota.
 */
export async function checkStorage({ usedBytes, quotaBytes = 536870912, now = clock.now() }) {
  const ratio = usedBytes / quotaBytes;
  if (ratio < WARN_RATIO) return { ratio, warned: false };
  await emitToAllBranches('system.storage_warning', {
    refId: istDate(now),
    vars: {
      usedMb: Math.round(usedBytes / MB),
      quotaMb: Math.round(quotaBytes / MB),
      percent: Math.round(ratio * 100),
    },
  });
  return { ratio, warned: true };
}

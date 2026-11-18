// The monthly GST pack: from 09:00 IST on the 2nd, one scheduled run per branch for the month
// before. The unique `schedule_unique` index makes asking again harmless.
import { istDate, istTime } from '@vs/shared/fy.js';
import { clock } from '../../clock.js';
import { listBranchIds } from '../branches/service.js';
import { ReportRun } from './model.js';

export const PACK_DAY = 2;
export const PACK_TIME = '09:00';

/** 'YYYY-MM' of the month before `ymd`'s. */
export function previousMonth(ymd) {
  const [y, m] = ymd.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** Queues last month's pack for each branch that has none yet; `{ queued }` new runs. */
export async function queueMonthlyPacks({ now = clock.now() } = {}) {
  const date = istDate(now);
  const day = Number(date.slice(8, 10));
  if (day < PACK_DAY || (day === PACK_DAY && istTime(now) < PACK_TIME)) return { queued: 0 };
  const month = previousMonth(date);
  let queued = 0;
  for (const branchId of await listBranchIds()) {
    try {
      await ReportRun.create({ branchId, kind: 'gst_pack', format: 'xlsx', params: { month }, source: 'schedule', requestedBy: null });
      queued += 1;
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }
  return { queued };
}

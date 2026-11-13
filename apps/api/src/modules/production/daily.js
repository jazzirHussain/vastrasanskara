// The daily production checks: late digest, pickup risk, vendor overdue and uncollected
// garments. Run every 15 minutes by the worker; each branch is checked once its IST clock has
// reached settings.dailyJobTime, and the outbox dedupe keys (one per day) keep every message to
// once a day however often it runs.
import { addDaysYmd, istDate, istTime } from '@vs/shared/fy.js';
import { isGarmentLate, isPickupAtRisk, workingStage } from '@vs/shared/production.js';
import { STAGES } from '@vs/shared/stages.js';
import { clock } from '../../clock.js';
import { withTransaction } from '../../core/db.js';
import { emit } from '../../core/notify/emit.js';
import { listBranchIds } from '../branches/service.js';
import { listOpenGarments } from '../orders/service.js';
import { readSettings } from '../settings/service.js';
import { getVendorNames } from '../vendors/service.js';
import './notifications.js';

const stageLabel = (key) => STAGES.find((s) => s.key === key)?.label ?? key;
const line = (g, detail) => `${g.garmentNo} ${g.description} — ${stageLabel(workingStage(g))}, ${detail}`;
const dueOf = ({ garment, order }) => garment.dueDate ?? order.pickupDate;
const groupBy = (items, key) => Map.groupBy(items, key);

function lateDetail({ garment, order }, day) {
  const planned = garment.stagePlan.find((s) => s.stage === workingStage(garment));
  if (planned?.plannedDate && !planned.skipped && planned.plannedDate < day) return `planned ${planned.plannedDate}`;
  return `due ${dueOf({ garment, order })}`;
}

async function checkBranch(branchId, settings, day) {
  const { items } = await listOpenGarments(branchId, null);
  const send = (event, args) => withTransaction((session) => emit(event, { branchId, ...args }, { session }));
  const designerOf = ({ order }) => String(order.designerId);
  let queued = 0;

  const late = items.filter(({ garment, order }) => isGarmentLate(garment, order, day));
  for (const [designerId, rows] of groupBy(late, designerOf)) {
    queued += await send('stage.late_digest', {
      refId: `${designerId}:${day}`,
      data: { designerId },
      vars: { count: rows.length, list: rows.map((r) => line(r.garment, lateDetail(r, day))).join('\n'), link: '/production' },
    });
  }

  // Pickup in three days or fewer (spec: the order's pickup, whatever a garment's own due date).
  const atRisk = items.filter((r) => isPickupAtRisk(r, day));
  for (const rows of groupBy(atRisk, (r) => String(r.order._id)).values()) {
    const { order, customerName } = rows[0];
    queued += await send('pickup.at_risk', {
      refId: `${order._id}:${day}`,
      data: { designerId: String(order.designerId) },
      vars: {
        orderNo: order.orderNo,
        customerName,
        pickupDate: order.pickupDate,
        list: rows.map((r) => line(r.garment, `due ${dueOf(r)}`)).join('\n'),
        link: `/orders/${order._id}`,
      },
    });
  }

  const overdue = items.filter((r) => r.garment.stageState === 'with_vendor' && r.garment.vendorWork?.dueBackDate < day);
  const vendors = await getVendorNames(branchId, overdue.map((r) => r.garment.vendorWork.vendorId));
  for (const [designerId, rows] of groupBy(overdue, designerOf)) {
    const detail = ({ vendorWork: v }) => `with ${vendors.get(String(v.vendorId)) ?? 'a vendor'}, due back ${v.dueBackDate}`;
    queued += await send('vendor.overdue', {
      refId: `${designerId}:${day}`,
      data: { designerId },
      vars: { count: rows.length, list: rows.map((r) => line(r.garment, detail(r.garment))).join('\n'), link: '/production' },
    });
  }

  // Ready for more than uncollectedFlagDays days.
  const flagBefore = addDaysYmd(day, -settings.uncollectedFlagDays);
  const uncollected = items.filter((r) => r.garment.status === 'ready' && r.garment.readyDate && r.garment.readyDate < flagBefore);
  if (uncollected.length) {
    queued += await send('garment.uncollected', {
      refId: `uncollected:${day}`,
      vars: {
        count: uncollected.length,
        days: settings.uncollectedFlagDays,
        list: uncollected.map((r) => line(r.garment, `ready since ${r.garment.readyDate}`)).join('\n'),
        link: '/production',
      },
    });
  }
  return queued;
}

/** Runs the checks for every branch whose daily job time has come. Returns { branches, queued }. */
export async function runDailyProductionChecks({ now = clock.now() } = {}) {
  let branches = 0;
  let queued = 0;
  for (const branchId of await listBranchIds()) {
    const settings = await readSettings(branchId);
    if (istTime(now) < settings.dailyJobTime) continue;
    branches += 1;
    queued += await checkBranch(branchId, settings, istDate(now));
  }
  return { branches, queued };
}

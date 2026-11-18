// Daily snapshots of the whole-branch point-in-time key numbers, and the one nearest a past day.
import mongoose from 'mongoose';
import { addDaysYmd } from '@vs/shared/fy.js';
import { PERMISSIONS } from '@vs/shared/permissions.js';
import { buildContext } from './filters.js';
import { metricDef } from './metrics/index.js';
import { DashboardSnapshot } from './model.js';
import './metrics/attention.js';
import './metrics/keyNumbers.js';
import './metrics/money.js';

/** Point-in-time metrics that are snapshotted, and the snapshot field each is kept in. */
export const SNAPSHOT_FIELDS = Object.freeze({
  active_orders: 'activeOrders',
  late_garments: 'lateGarments',
  outstanding: 'outstanding',
  overdue_amount: 'overdueAmount',
  advances_held: 'advancesHeld',
});
const NEAR_DAYS = 7;

const oid = (id) => new mongoose.Types.ObjectId(String(id));
const systemUser = (branchId) => ({
  id: 'system',
  branchId: String(branchId),
  permissions: new Set([PERMISSIONS.ORDERS_READ_ALL, 'orders.read.own', PERMISSIONS.MONEY_VIEW]),
});

/** Stores (or replaces) the branch's snapshot for `date` from the unfiltered whole-branch figures. */
export async function takeSnapshot(branchId, date) {
  const ctx = await buildContext(systemUser(branchId), { preset: 'month' }, { today: date });
  const figures = {};
  for (const [id, field] of Object.entries(SNAPSHOT_FIELDS)) {
    const f = await metricDef(id).figure(ctx);
    figures[field] = f.amount ?? f.count;
  }
  await DashboardSnapshot.updateOne({ branchId: oid(branchId), date }, { $set: { figures } }, { upsert: true });
  return figures;
}

/** Whether the branch already has a snapshot for `date`. */
export async function hasSnapshot(branchId, date) {
  return Boolean(await DashboardSnapshot.exists({ branchId: oid(branchId), date }));
}

/** The figures of the latest snapshot on or before `date` and at most seven days before it, or null. */
export async function snapshotNear(branchId, date) {
  const snap = await DashboardSnapshot.findOne({ branchId: oid(branchId), date: { $lte: date, $gte: addDaysYmd(date, -NEAR_DAYS) } })
    .sort({ date: -1 })
    .lean();
  return snap?.figures ?? null;
}

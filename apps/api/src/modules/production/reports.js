// Production figures for the M8 dashboard and reports. Read-only; re-exported by service.js.
import mongoose from 'mongoose';
import { istDate, istDayBounds } from '@vs/shared/fy.js';
import { listOpenGarments } from '../orders/service.js';
import { getVendorNames } from '../vendors/service.js';
import { StageEvent } from './model.js';

const oid = (id) => new mongoose.Types.ObjectId(String(id));
export const QC_FAILURE_CAP = 200;

/** QC failures since the IST day `since` (`branchId, action, at`; exported for the index test). */
export function qcFailureFilter(branchId, { since }) {
  return { branchId: oid(branchId), action: 'qc_fail', at: { $gte: istDayBounds(since).start } };
}

/** Vendor returns on IST days [from, to] (`branchId, action, at`; exported for the index test). */
export function vendorReturnFilter(branchId, { from, to }) {
  return { branchId: oid(branchId), action: 'returned_from_vendor', at: { $gte: istDayBounds(from).start, $lte: istDayBounds(to).end } };
}

/** Sends to a vendor of the given garments (`garmentId, at`; exported for the index test). */
export function vendorSentFilter(garmentIds) {
  return { garmentId: { $in: garmentIds.map(oid) }, action: 'sent_to_vendor' };
}

/**
 * The latest QC failure since `since` of each garment still open in the user's scope, newest
 * first, at most 200 (Decision 8: the dashboard asks for the last seven days).
 */
export async function qcFailures(branchId, user, { since }) {
  const [events, open] = await Promise.all([
    StageEvent.find(qcFailureFilter(branchId, { since }), { garmentId: 1, orderId: 1, stage: 1, at: 1, reason: 1, remarks: 1 }).sort({ at: -1 }).lean(),
    listOpenGarments(branchId, user),
  ]);
  const garments = new Map(open.items.map(({ garment }) => [String(garment._id), garment]));
  const seen = new Set();
  const rows = [];
  for (const e of events) {
    const id = String(e.garmentId);
    if (seen.has(id) || !garments.has(id)) continue;
    seen.add(id);
    rows.push({ garmentId: id, garmentNo: garments.get(id).garmentNo, orderId: String(e.orderId), stage: e.stage, at: e.at, reason: e.reason || e.remarks || '' });
    if (rows.length === QC_FAILURE_CAP) break;
  }
  return rows;
}

/**
 * Per vendor, garments returned on IST days [from, to] and how many came back on time: each
 * return is matched to the latest earlier send of that garment and stage, and is on time when
 * its IST date is on or before that send's due-back date. By vendor name.
 */
export async function vendorOnTime(branchId, { from, to }) {
  const returns = await StageEvent.find(vendorReturnFilter(branchId, { from, to }), { garmentId: 1, stage: 1, at: 1 }).lean();
  if (!returns.length) return [];
  const sends = await StageEvent.find(vendorSentFilter([...new Set(returns.map((r) => String(r.garmentId)))]), {
    garmentId: 1, stage: 1, at: 1, vendorId: 1, dueBackDate: 1,
  }).sort({ at: 1 }).lean();
  const byVendor = new Map();
  for (const r of returns) {
    const sent = sends.filter((s) => String(s.garmentId) === String(r.garmentId) && s.stage === r.stage && s.at <= r.at).at(-1);
    if (!sent?.vendorId) continue;
    const v = byVendor.get(String(sent.vendorId)) ?? { vendorId: String(sent.vendorId), returned: 0, onTime: 0 };
    v.returned += 1;
    if (sent.dueBackDate && istDate(r.at) <= sent.dueBackDate) v.onTime += 1;
    byVendor.set(v.vendorId, v);
  }
  const names = await getVendorNames(branchId, [...byVendor.keys()]);
  return [...byVendor.values()]
    .map((v) => ({ vendorId: v.vendorId, name: names.get(v.vendorId) ?? '', returned: v.returned, onTime: v.onTime }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.vendorId.localeCompare(b.vendorId));
}

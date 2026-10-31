import mongoose from 'mongoose';
import { istDate } from '@vs/shared/fy.js';
import { clock } from '../../clock.js';
import { paginate } from '../../core/pagination.js';
import { isPeriodLocked } from '../periods/service.js';
import { readSettings } from '../settings/service.js';
import { listVendors } from '../vendors/service.js';
import { categoryOf } from './json.js';
import { Expense } from './model.js';

/*
 * Data for M8 (all by the (branchId, date) index; a month is the range [YYYY-MM-01, YYYY-MM-31]):
 *  - dashboard tile 10 = expenseTotalsByCategory for the dashboard's range;
 *  - the expense register = listExpenses({ from, to }) (by date);
 *  - GSTR-3B 4(A)(5) "all other ITC" = inputTaxSummary().itc;
 *  - profit and loss = expenseCostTotal (cost, and the part that is stock purchases).
 * Locked months give the same figures every time, because writes in them are refused.
 */

const { ObjectId } = mongoose.Types;
const oid = (id) => new ObjectId(String(id));
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const monthRange = (month) => ({ $gte: `${month}-01`, $lte: `${month}-31` });
const rangeOf = ({ from, to }) => ({ ...(from && { $gte: from }), ...(to && { $lte: to }) });

function previousMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** An expense with a GST bill but no photo of it. */
const NO_BILL = { gst: { $ne: null }, 'attachments.0': { $exists: false } };

/** The find filter of listExpenses (exported for the index test). */
export function expenseListFilter(branchId, { month, from, to, category, vendorId, orderId, status = 'active', noBill, q } = {}) {
  const filter = { branchId: oid(branchId) };
  if (month) filter.date = monthRange(month);
  else if (from || to) filter.date = rangeOf({ from, to });
  else filter.date = monthRange(istDate(clock.now()).slice(0, 7));
  if (status !== 'all') filter.status = status;
  if (category) filter.category = category;
  if (vendorId) filter['payee.vendorId'] = oid(vendorId);
  if (orderId) filter['link.orderId'] = oid(orderId);
  if (noBill) Object.assign(filter, NO_BILL);
  const text = q?.trim();
  if (text) {
    if (/^\d+$/.test(text)) filter.number = new RegExp(`/${text.padStart(4, '0')}$`);
    else filter['payee.searchName'] = new RegExp(`^${escapeRegex(text.toLowerCase())}`);
  }
  return filter;
}

/** One page of expenses, newest first. Defaults to this month's active expenses. */
export function listExpenses(branchId, { cursor, limit, ...filters } = {}) {
  return paginate(Expense, expenseListFilter(branchId, filters), { sort: ['date', -1], limit, cursor });
}

// Sums over expenses that have a GST bill; `itc` is what can be claimed, `ineligible` what cannot.
const sumIf = (cond, field) => ({ $sum: { $cond: [cond, field, 0] } });
const eligible = { $eq: ['$gst.itcEligible', true] };
const GST_GROUP = {
  count: { $sum: 1 },
  taxable: { $sum: '$gst.taxable' },
  cgst: { $sum: '$gst.cgst' },
  sgst: { $sum: '$gst.sgst' },
  igst: { $sum: '$gst.igst' },
  itcCgst: sumIf(eligible, '$gst.cgst'),
  itcSgst: sumIf(eligible, '$gst.sgst'),
  itcIgst: sumIf(eligible, '$gst.igst'),
};

function gstSummaryOf(row) {
  const n = (k) => row?.[k] ?? 0;
  return {
    count: n('count'),
    taxable: n('taxable'),
    cgst: n('cgst'),
    sgst: n('sgst'),
    igst: n('igst'),
    itc: { cgst: n('itcCgst'), sgst: n('itcSgst'), igst: n('itcIgst') },
    ineligible: { cgst: n('cgst') - n('itcCgst'), sgst: n('sgst') - n('itcSgst'), igst: n('igst') - n('itcIgst') },
  };
}

const activeMatch = (branchId, range) => ({ branchId: oid(branchId), date: rangeOf(range), status: 'active' });

/** Spend per category in a date range, biggest first: [{ category, total, count }]. */
export async function expenseTotalsByCategory(branchId, { from, to }) {
  const rows = await Expense.aggregate([
    { $match: activeMatch(branchId, { from, to }) },
    { $group: { _id: '$category', total: { $sum: '$total' }, count: { $sum: 1 } } },
    { $sort: { total: -1, _id: 1 } },
  ]);
  return rows.map((r) => ({ category: r._id, total: r.total, count: r.count }));
}

/** The GST on bills in a date range, with what can be claimed back as input tax. */
export async function inputTaxSummary(branchId, { from, to }) {
  const [row] = await Expense.aggregate([
    { $match: { ...activeMatch(branchId, { from, to }), gst: { $ne: null } } },
    { $group: { _id: null, ...GST_GROUP } },
  ]);
  return gstSummaryOf(row);
}

/**
 * What the expenses of a date range add to cost (the before-GST amount plus GST that cannot be
 * claimed; the whole amount when there is no GST bill), and the part of it from stock purchases.
 */
export async function expenseCostTotal(branchId, { from, to }) {
  const unclaimable = { $add: ['$gst.cgst', '$gst.sgst', '$gst.igst'] };
  const cost = {
    $cond: [
      { $eq: [{ $ifNull: ['$gst', null] }, null] },
      '$total',
      { $add: ['$gst.taxable', { $cond: [eligible, 0, unclaimable] }] },
    ],
  };
  const [row] = await Expense.aggregate([
    { $match: activeMatch(branchId, { from, to }) },
    { $group: { _id: null, cost: { $sum: cost }, purchaseCost: sumIf({ $eq: ['$source', 'purchase'] }, cost) } },
  ]);
  return { cost: row?.cost ?? 0, purchaseCost: row?.purchaseCost ?? 0 };
}

/** The month's total by category and way of paying, last month's total, GST and bills missing photos. */
export async function monthSummary(branchId, month) {
  const previous = previousMonth(month);
  const [[facets], [before], settings, locked] = await Promise.all([
    Expense.aggregate([
      { $match: activeMatch(branchId, { from: `${month}-01`, to: `${month}-31` }) },
      {
        $facet: {
          overall: [{ $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 } } }],
          byCategory: [{ $group: { _id: '$category', total: { $sum: '$total' }, count: { $sum: 1 } } }, { $sort: { total: -1, _id: 1 } }],
          byMode: [{ $group: { _id: '$mode', total: { $sum: '$total' } } }, { $sort: { total: -1, _id: 1 } }],
          gst: [{ $match: { gst: { $ne: null } } }, { $group: { _id: null, ...GST_GROUP } }],
          missingBill: [{ $match: NO_BILL }, { $count: 'n' }],
        },
      },
    ]),
    Expense.aggregate([
      { $match: activeMatch(branchId, { from: `${previous}-01`, to: `${previous}-31` }) },
      { $group: { _id: null, total: { $sum: '$total' } } },
    ]),
    readSettings(branchId),
    isPeriodLocked(branchId, month),
  ]);
  return {
    month,
    total: facets.overall[0]?.total ?? 0,
    count: facets.overall[0]?.count ?? 0,
    previousMonthTotal: before?.total ?? 0,
    byCategory: facets.byCategory.map((r) => ({
      category: categoryOf(r._id, settings.expenseCategories),
      total: r.total,
      count: r.count,
    })),
    byMode: facets.byMode.map((r) => ({ mode: r._id, total: r.total })),
    gst: gstSummaryOf(facets.gst[0]),
    missingBill: facets.missingBill[0]?.n ?? 0,
    locked,
  };
}

/**
 * Suggestions for the "who was paid" field: active vendors (names starting with `q` first, then
 * containing it; at most 20) and free-text payees from the newest 200 expenses without a vendor
 * (newest first, at most 10, matching `q` the same way).
 */
export async function recentPayees(branchId, { q } = {}) {
  const needle = q?.trim().toLowerCase() ?? '';
  const matches = (name) => name.includes(needle);

  const vendors = (await listVendors(branchId, { active: true })).filter((v) => matches(v.name.toLowerCase()));
  const startsWith = (v) => Number(v.name.toLowerCase().startsWith(needle));
  vendors.sort((a, b) => startsWith(b) - startsWith(a));

  const newest = await Expense.find({ branchId: oid(branchId), status: 'active', 'payee.vendorId': null }, { payee: 1 })
    .sort({ date: -1, _id: -1 })
    .limit(200)
    .lean();
  const seen = new Set();
  const recent = [];
  for (const { payee } of newest) {
    const key = payee.searchName || payee.name.toLowerCase();
    if (seen.has(key) || !matches(key)) continue;
    seen.add(key);
    recent.push({ name: payee.name, gstin: payee.gstin ?? null, stateCode: payee.stateCode ?? null });
    if (recent.length === 10) break;
  }
  return {
    vendors: vendors.slice(0, 20).map((v) => ({ id: String(v._id), name: v.name, gstin: v.gstin ?? null, stateCode: v.stateCode ?? null })),
    recent,
  };
}

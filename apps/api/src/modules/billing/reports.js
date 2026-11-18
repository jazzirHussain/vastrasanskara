// Billing figures and document views for the dashboard and reports (M8). These functions are only
// for the dashboard and reports: they are read-only and go by document date (`date`, IST), never
// by when a document was written. Each query names the index it uses; the exported filters are
// what the explain test checks.
import mongoose from 'mongoose';
import { addDaysYmd, istDate } from '@vs/shared/fy.js';
import { daysBetween } from '@vs/shared/billing.js';
import { allocateProRata, mulDivRound } from '@vs/shared/money.js';
import { clock } from '../../clock.js';
import { decodeCursor, paginate } from '../../core/pagination.js';
import { getCustomerNames } from '../customers/service.js';
import { receivablesFilter } from './ledger.js';
import { Allocation, BillingDocument } from './model.js';

const oid = (id) => new mongoose.Types.ObjectId(String(id));
const todayIst = () => istDate(clock.now());
const encodeCursor = (v, id) => Buffer.from(JSON.stringify({ v, id: String(id) })).toString('base64url');

const MONEY_TYPES = ['invoice', 'credit_note', 'receipt', 'refund'];
const SERIES_TYPES = ['invoice', 'credit_note', 'receipt_voucher', 'refund'];
const HEADS = ['taxable', 'cgst', 'sgst', 'igst'];
export const MAX_ORDER_STATUS_IDS = 200;
const BATCH = 200;

/** `{ in } | { notIn } | undefined` (customer ids) → a customerId condition. */
function customerMatch(customerFilter) {
  if (customerFilter?.in) return { customerId: { $in: customerFilter.in.map(oid) } };
  if (customerFilter?.notIn) return { customerId: { $nin: customerFilter.notIn.map(oid) } };
  return {};
}

const dateRange = (from, to) => ({ $gte: from, $lte: to });

// --- Filters (each uses the index named) ----------------------------------------------------------

/** Issued money documents dated in [from, to] (`register`). */
export function periodMatch(branchId, { from, to, customerFilter, types = MONEY_TYPES }) {
  // Opening advances are not money collected in the period.
  return {
    branchId: oid(branchId),
    type: { $in: types },
    status: 'issued',
    date: dateRange(from, to),
    opening: { $ne: true },
    ...customerMatch(customerFilter),
  };
}

/** Bills still owed (`receivables`). */
export function receivablesMatch(branchId, { customerFilter, bucket } = {}, today = todayIst()) {
  return { ...receivablesFilter(branchId, { bucket }, today), ...customerMatch(customerFilter) };
}

/** Every issued receipt of the branch (`register`). */
export function receiptsHeldMatch(branchId) {
  return { branchId: oid(branchId), type: 'receipt', status: 'issued' };
}

/** Every allocation of the branch (`branchId, customerId, date`). */
export function allocationsMatch(branchId) {
  return { branchId: oid(branchId) };
}

/** Issued bills and receipts of the given orders (`order_docs`). */
export function orderDocsFilter(branchId, orderIds) {
  return { orderId: { $in: orderIds.map(oid) }, type: { $in: ['invoice', 'receipt'] }, status: 'issued', branchId: oid(branchId) };
}

/** Issued bills with an order, dated in [from, to] (`register`). */
export function invoicedOrdersMatch(branchId, { from, to }) {
  return { branchId: oid(branchId), type: 'invoice', status: 'issued', date: dateRange(from, to), orderId: { $type: 'objectId' } };
}

/** Issued and cancelled documents of `types` dated in [from, to] (`register`). */
export function documentsFilter(branchId, { types, from, to }) {
  return {
    branchId: oid(branchId),
    type: { $in: types },
    status: { $in: ['issued', 'cancelled'] },
    date: dateRange(from, to),
    // Opening advances belong to the old books: no register, day book or GST file shows them.
    opening: { $ne: true },
  };
}

/** Numbered GST documents dated in [from, to], for the document summary (`register`). */
export function seriesMatch(branchId, { from, to }) {
  return documentsFilter(branchId, { types: SERIES_TYPES, from, to });
}

// --- Period figures -------------------------------------------------------------------------------

/**
 * Issued documents dated in [from, to], gross (Decision 5): `billed` is the bills' total, with
 * `credited` (and its taxable part) beside it; `collected` is receipts, with `refunded` beside it.
 * `invoices` and `receipts` are counts; `taxable` is the bills' taxable value.
 */
export async function periodMoney(branchId, { from, to, customerFilter }) {
  const byType = await BillingDocument.aggregate([
    { $match: periodMatch(branchId, { from, to, customerFilter }) },
    {
      $group: {
        _id: '$type',
        count: { $sum: 1 },
        total: { $sum: { $ifNull: ['$totals.total', '$amount'] } },
        taxable: { $sum: { $ifNull: ['$totals.taxable', 0] } },
      },
    },
  ]);
  const of = (type) => byType.find((t) => t._id === type) ?? { count: 0, total: 0, taxable: 0 };
  return {
    billed: of('invoice').total,
    invoices: of('invoice').count,
    credited: of('credit_note').total,
    creditedTaxable: of('credit_note').taxable,
    taxable: of('invoice').taxable,
    collected: of('receipt').total,
    receipts: of('receipt').count,
    refunded: of('refund').total,
  };
}

function monthsBetween(from, to) {
  const months = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const last = to.slice(0, 7);
  for (;;) {
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    if (ym > last) break;
    months.push(ym);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return months;
}

/** Gross billed and collected per month in [from, to]; months with nothing show 0. */
export async function monthlyMoney(branchId, { from, to, customerFilter }) {
  const rows = await BillingDocument.aggregate([
    { $match: periodMatch(branchId, { from, to, customerFilter, types: ['invoice', 'receipt'] }) },
    { $group: { _id: { month: '$month', type: '$type' }, total: { $sum: { $ifNull: ['$totals.total', '$amount'] } } } },
  ]);
  const total = (month, type) => rows.find((r) => r._id.month === month && r._id.type === type)?.total ?? 0;
  return monthsBetween(from, to).map((month) => ({ month, billed: total(month, 'invoice'), collected: total(month, 'receipt') }));
}

// --- Money owed -----------------------------------------------------------------------------------

/** Totals (with how many bills are overdue), ageing buckets (as `ageingBucket` draws them) and the customers owing most; one `$facet`. */
export async function receivablesAgeing(branchId, { customerFilter, top = 5 } = {}) {
  const today = todayIst();
  const ago = (n) => addDaysYmd(today, -n);
  const [facets] = await BillingDocument.aggregate([
    { $match: receivablesMatch(branchId, { customerFilter }, today) },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              outstanding: { $sum: '$settlement.balance' },
              overdue: { $sum: { $cond: [{ $lt: ['$dueDate', today] }, '$settlement.balance', 0] } },
              overdueCount: { $sum: { $cond: [{ $lt: ['$dueDate', today] }, 1, 0] } },
            },
          },
        ],
        buckets: [
          {
            $group: {
              _id: {
                $switch: {
                  branches: [
                    { case: { $gte: ['$dueDate', today] }, then: 'not_due' },
                    { case: { $gte: ['$dueDate', ago(30)] }, then: 'd0_30' },
                    { case: { $gte: ['$dueDate', ago(60)] }, then: 'd31_60' },
                    { case: { $gte: ['$dueDate', ago(90)] }, then: 'd61_90' },
                  ],
                  default: 'd90_plus',
                },
              },
              amount: { $sum: '$settlement.balance' },
            },
          },
        ],
        customers: [
          { $group: { _id: '$customerId', balance: { $sum: '$settlement.balance' }, oldest: { $min: '$dueDate' } } },
          { $sort: { balance: -1, _id: 1 } },
          { $limit: top },
        ],
      },
    },
  ]);
  const t = facets.totals[0];
  const buckets = { not_due: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  for (const b of facets.buckets) buckets[b._id] = b.amount;
  const names = await getCustomerNames(branchId, facets.customers.map((c) => c._id));
  return {
    count: t?.count ?? 0,
    outstanding: t?.outstanding ?? 0,
    overdueAmount: t?.overdue ?? 0,
    overdueCount: t?.overdueCount ?? 0,
    buckets,
    topCustomers: facets.customers.map((c) => ({
      id: String(c._id),
      name: names.get(String(c._id)) ?? '',
      balance: c.balance,
      oldestDays: Math.max(0, daysBetween(c.oldest, today)),
    })),
  };
}

// --- Advances held --------------------------------------------------------------------------------

/** [{ customerId, received, allocated, held }] for customers holding money: Σ issued receipts − Σ allocations. */
async function advancesPerCustomer(branchId, customerFilter) {
  const [received, allocated] = await Promise.all([
    BillingDocument.aggregate([{ $match: receiptsHeldMatch(branchId) }, { $group: { _id: '$customerId', total: { $sum: '$amount' } } }]),
    Allocation.aggregate([{ $match: allocationsMatch(branchId) }, { $group: { _id: '$customerId', total: { $sum: '$amount' } } }]),
  ]);
  const used = new Map(allocated.map((a) => [String(a._id), a.total]));
  return received
    .map((r) => {
      const a = used.get(String(r._id)) ?? 0;
      return { customerId: String(r._id), received: r.total, allocated: a, held: r.total - a };
    })
    .filter((r) => r.held > 0 && keepsCustomer(customerFilter, r.customerId));
}

function keepsCustomer(customerFilter, customerId) {
  if (customerFilter?.in) return customerFilter.in.some((id) => String(id) === customerId);
  if (customerFilter?.notIn) return !customerFilter.notIn.some((id) => String(id) === customerId);
  return true;
}

/** Money held for customers (advances not yet used on bills or refunded), and how many customers hold some. */
export async function advancesHeld(branchId, { customerFilter } = {}) {
  const rows = await advancesPerCustomer(branchId, customerFilter);
  return { advancesHeld: rows.reduce((s, r) => s + r.held, 0), customers: rows.length };
}

/** One page of the customers holding money, largest first. */
export async function advancesByCustomer(branchId, { cursor, limit = 25, customerFilter } = {}) {
  const size = Math.min(Math.max(1, Number(limit) || 25), 100);
  let rows = (await advancesPerCustomer(branchId, customerFilter)).sort((a, b) => b.held - a.held || a.customerId.localeCompare(b.customerId));
  if (cursor) {
    const { v, id } = decodeCursor(cursor);
    const at = String(id);
    rows = rows.filter((r) => r.held < v || (r.held === v && r.customerId > at));
  }
  const page = rows.slice(0, size);
  const names = await getCustomerNames(branchId, page.map((r) => r.customerId));
  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      customer: { id: r.customerId, name: names.get(r.customerId) ?? '' },
      received: r.received,
      allocated: r.allocated,
      advancesHeld: r.held,
    })),
    nextCursor: rows.length > size ? encodeCursor(last.held, last.customerId) : null,
  };
}

// --- Orders ---------------------------------------------------------------------------------------

/**
 * Map orderId → { status, balance, advancesHeld } for at most 200 orders. With issued bills the
 * status is paid / part_paid / unpaid by what is still owed; without, advance_only when money is
 * held for the order, else nothing_yet.
 */
export async function orderPaymentStatuses(branchId, orderIds) {
  if (orderIds.length > MAX_ORDER_STATUS_IDS) throw new RangeError(`At most ${MAX_ORDER_STATUS_IDS} orders at a time`);
  const docs = orderIds.length
    ? await BillingDocument.find(orderDocsFilter(branchId, orderIds), { type: 1, orderId: 1, 'totals.total': 1, 'settlement.balance': 1, amount: 1 }).lean()
    : [];
  const receiptIds = docs.filter((d) => d.type === 'receipt').map((d) => d._id);
  const allocated = receiptIds.length
    ? await Allocation.aggregate([{ $match: { receiptId: { $in: receiptIds } } }, { $group: { _id: '$receiptId', total: { $sum: '$amount' } } }])
    : [];
  const usedOf = new Map(allocated.map((a) => [String(a._id), a.total]));

  const acc = new Map(orderIds.map((id) => [String(id), { bills: 0, billed: 0, balance: 0, held: 0 }]));
  for (const d of docs) {
    const a = acc.get(String(d.orderId));
    if (!a) continue;
    if (d.type === 'invoice') {
      a.bills += 1;
      a.billed += d.totals?.total ?? 0;
      a.balance += d.settlement?.balance ?? 0;
    } else {
      a.held += d.amount - (usedOf.get(String(d._id)) ?? 0);
    }
  }
  const out = new Map();
  for (const [id, a] of acc) {
    let status;
    if (a.bills) status = a.balance <= 0 ? 'paid' : a.balance < a.billed ? 'part_paid' : 'unpaid';
    else status = a.held > 0 ? 'advance_only' : 'nothing_yet';
    out.set(id, { status, balance: Math.max(0, a.balance), advancesHeld: Math.max(0, a.held) });
  }
  return out;
}

/** Orders with an issued bill dated in [from, to], most recently billed first, once each; `{ ids, nextCursor }`. */
export async function invoicedOrderIds(branchId, { from, to, limit = 100, cursor } = {}) {
  const size = Math.min(Math.max(1, Number(limit) || 100), 100);
  const pipeline = [
    { $match: invoicedOrdersMatch(branchId, { from, to }) },
    { $group: { _id: '$orderId', lastDate: { $max: '$date' } } },
  ];
  if (cursor) {
    const { v, id } = decodeCursor(cursor);
    pipeline.push({ $match: { $or: [{ lastDate: { $lt: v } }, { lastDate: v, _id: { $lt: id } }] } });
  }
  pipeline.push({ $sort: { lastDate: -1, _id: -1 } }, { $limit: size + 1 });
  const rows = await BillingDocument.aggregate(pipeline);
  const more = rows.length > size;
  if (more) rows.pop();
  const last = rows.at(-1);
  return { ids: rows.map((r) => String(r._id)), nextCursor: more ? encodeCursor(last.lastDate, last._id) : null };
}

// --- Document views -------------------------------------------------------------------------------

/**
 * Splits tax figures `{ taxable, cgst, sgst, igst }` over a receipt voucher's lines in proportion
 * to each line's gross (largest remainder, so every head adds up to the paisa). Returns parts
 * `{ stateCode, gstRateBp, taxable, cgst, sgst, igst }`, one per rate.
 */
export function splitByVoucherLines(amounts, rv) {
  return splitAcross(amounts, rv.lines.map((l) => ({ stateCode: rv.stateCode, gstRateBp: l.rateBp ?? l.gstRateBp, weight: l.gross ?? 0 })));
}

function splitAcross(amounts, weighted) {
  const live = weighted.filter((w) => w.weight > 0);
  if (!live.length) return [];
  const shares = Object.fromEntries(HEADS.map((h) => [h, allocateProRata(amounts[h] ?? 0, live.map((w) => w.weight))]));
  const merged = new Map();
  live.forEach((w, i) => {
    const key = `${w.stateCode}|${w.gstRateBp}`;
    const p = merged.get(key) ?? { stateCode: w.stateCode, gstRateBp: w.gstRateBp, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    for (const h of HEADS) p[h] += shares[h][i];
    merged.set(key, p);
  });
  return [...merged.values()];
}

const VIEW_PROJECTION = {
  type: 1, status: 1, number: 1, date: 1, customerId: 1, invoiceId: 1, amount: 1, mode: 1, totals: 1,
  advanceAdjustments: 1, rvReversal: 1,
  'snapshot.customer': 1, 'snapshot.placeOfSupply': 1, 'snapshot.lines': 1, 'snapshot.totals': 1,
};

const customerView = (doc) => {
  const c = doc.snapshot?.customer ?? {};
  return {
    id: c.id ?? String(doc.customerId),
    name: c.name ?? '',
    gstin: c.gstin ?? null,
    stateCode: c.stateCode ?? null,
    registered: Boolean(c.registered ?? c.gstin),
  };
};
const placeView = (doc) => {
  const p = doc.snapshot?.placeOfSupply;
  return p ? { stateCode: p.stateCode, interState: Boolean(p.interState) } : null;
};
const totalsView = (t) => ({
  taxable: t.taxable ?? 0, cgst: t.cgst ?? 0, sgst: t.sgst ?? 0, igst: t.igst ?? 0, tax: t.tax ?? 0, roundOff: t.roundOff ?? 0, total: t.total ?? 0,
});
const lineFigures = (l) => ({ gstRateBp: l.gstRateBp ?? l.rateBp, taxable: l.taxable ?? 0, cgst: l.cgst ?? 0, sgst: l.sgst ?? 0, igst: l.igst ?? 0 });
const invoiceLineView = (l) => ({
  hsnSac: l.item?.hsnSac ?? l.hsnSac ?? null,
  description: l.description ?? '',
  supplyType: l.item?.supplyType ?? null,
  unit: l.item?.unit ?? null,
  quantity: l.quantity ?? 0,
  ...lineFigures(l),
});
const voucherOf = (rv) => ({ stateCode: rv.snapshot?.placeOfSupply?.stateCode ?? null, lines: rv.snapshot?.lines ?? [] });
const headsOf = (x) => Object.fromEntries(HEADS.map((h) => [h, x?.[h] ?? 0]));

/** What a batch of documents needs from other documents, fetched once per batch. */
async function batchContext(docs) {
  const notes = docs.filter((d) => d.type === 'credit_note');
  const refunds = docs.filter((d) => d.type === 'refund' && d.rvReversal);
  const rvIds = new Set(docs.flatMap((d) => (d.advanceAdjustments ?? []).map((a) => String(a.receiptVoucherId))));

  const [originals, refundRows] = await Promise.all([
    notes.length
      ? BillingDocument.find(
          { _id: { $in: notes.map((n) => n.invoiceId) } },
          { number: 1, date: 1, 'totals.total': 1, 'snapshot.customer': 1, 'snapshot.placeOfSupply': 1, 'snapshot.lines': 1 },
        ).lean()
      : [],
    refunds.length ? Allocation.find({ refundId: { $in: refunds.map((r) => r._id) } }, { refundId: 1, receiptId: 1, amount: 1 }).lean() : [],
  ]);
  const receipts = refundRows.length
    ? await BillingDocument.find({ _id: { $in: refundRows.map((a) => a.receiptId) } }, { receiptVoucherId: 1 }).lean()
    : [];
  const voucherOfReceipt = new Map(receipts.filter((r) => r.receiptVoucherId).map((r) => [String(r._id), String(r.receiptVoucherId)]));
  for (const id of voucherOfReceipt.values()) rvIds.add(id);
  const rvs = rvIds.size
    ? await BillingDocument.find({ _id: { $in: [...rvIds].map(oid) } }, { 'snapshot.placeOfSupply': 1, 'snapshot.lines': 1 }).lean()
    : [];
  return {
    originals: new Map(originals.map((o) => [String(o._id), o])),
    rvs: new Map(rvs.map((r) => [String(r._id), voucherOf(r)])),
    refundSources: refundRows.reduce((m, a) => {
      const list = m.get(String(a.refundId)) ?? [];
      list.push({ voucherId: voucherOfReceipt.get(String(a.receiptId)), amount: Math.abs(a.amount) });
      return m.set(String(a.refundId), list);
    }, new Map()),
  };
}

function toView(doc, ctx) {
  const base = {
    id: String(doc._id),
    type: doc.type,
    status: doc.status,
    number: doc.number,
    date: doc.date,
    customer: customerView(doc),
    placeOfSupply: null,
    totals: null,
    lines: [],
    original: null,
    advanceAdjustments: [],
    rvReversal: null,
    rvReversalParts: [],
  };
  if (doc.type === 'invoice') {
    return {
      ...base,
      placeOfSupply: placeView(doc),
      totals: totalsView(doc.totals ?? {}),
      lines: (doc.snapshot?.lines ?? []).map(invoiceLineView),
      advanceAdjustments: (doc.advanceAdjustments ?? []).flatMap((a) => {
        const rv = ctx.rvs.get(String(a.receiptVoucherId));
        const fallback = [{ stateCode: placeView(doc)?.stateCode ?? null, gstRateBp: null, ...headsOf(a) }];
        const parts = rv ? splitByVoucherLines(headsOf(a), rv) : [];
        return parts.length ? parts : fallback;
      }),
    };
  }
  if (doc.type === 'credit_note') {
    const o = ctx.originals.get(String(doc.invoiceId));
    const originalLines = new Map((o?.snapshot?.lines ?? []).map((l) => [l.key, l]));
    return {
      ...base,
      placeOfSupply: placeView(doc),
      totals: totalsView(doc.totals ?? {}),
      lines: (doc.snapshot?.lines ?? []).map((l) => {
        const ol = originalLines.get(l.key);
        return {
          hsnSac: l.hsnSac ?? ol?.item?.hsnSac ?? null,
          description: l.description ?? ol?.description ?? '',
          supplyType: ol?.item?.supplyType ?? null,
          unit: ol?.item?.unit ?? null,
          quantity: 0,
          ...lineFigures(l),
        };
      }),
      original: o
        ? {
            id: String(o._id),
            number: o.number,
            date: o.date,
            total: o.totals?.total ?? 0,
            registered: Boolean(o.snapshot?.customer?.registered ?? o.snapshot?.customer?.gstin),
            interState: Boolean(o.snapshot?.placeOfSupply?.interState),
          }
        : null,
    };
  }
  if (doc.type === 'receipt_voucher') {
    const t = doc.snapshot?.totals ?? {};
    return {
      ...base,
      placeOfSupply: placeView(doc),
      totals: { ...totalsView(t), total: t.gross ?? 0 },
      lines: (doc.snapshot?.lines ?? []).map((l) => ({
        hsnSac: l.hsnSac ?? null, description: '', supplyType: 'service', unit: null, quantity: 0, ...lineFigures(l),
      })),
    };
  }
  // Receipts and refunds: money, not supplies.
  const view = { ...base, amount: doc.amount, mode: doc.mode };
  if (doc.type === 'refund' && doc.rvReversal) {
    const sources = ctx.refundSources.get(String(doc._id)) ?? [];
    const weighted = sources.flatMap(({ voucherId, amount }) => {
      const rv = voucherId && ctx.rvs.get(voucherId);
      if (!rv) return [];
      const whole = rv.lines.reduce((s, l) => s + (l.gross ?? 0), 0);
      return rv.lines.map((l) => ({
        stateCode: rv.stateCode,
        gstRateBp: l.rateBp ?? l.gstRateBp,
        weight: whole > 0 ? mulDivRound(amount, l.gross ?? 0, whole) : 0,
      }));
    });
    const heads = headsOf(doc.rvReversal);
    const parts = splitAcross(heads, weighted);
    view.rvReversalParts = parts;
    view.rvReversal = {
      ...heads,
      gstRateBp: parts.length === 1 ? parts[0].gstRateBp : null,
      stateCode: parts.length === 1 ? parts[0].stateCode : null,
    };
  }
  return view;
}

/**
 * Issued and cancelled documents of `types` dated in [from, to] as billing document views (the
 * shape the GSTR and register builders take), streamed by a cursor with a fixed projection.
 * Credit notes carry their bill (`original`); bill advance adjustments and refund reversals carry
 * the state and rate of the receipt voucher they came from. Not in date order: builders sort.
 */
export async function* billingDocumentsInRange(branchId, { types, from, to }) {
  const cursor = BillingDocument.find(documentsFilter(branchId, { types, from, to }), VIEW_PROJECTION).lean().cursor({ batchSize: BATCH });
  let batch = [];
  const flush = async function* flush() {
    const ctx = await batchContext(batch);
    for (const doc of batch) yield toView(doc, ctx);
    batch = [];
  };
  for await (const doc of cursor) {
    batch.push(doc);
    if (batch.length >= BATCH) yield* flush();
  }
  if (batch.length) yield* flush();
}

/**
 * The document summary: per type and number prefix, the first and last number (by sequence),
 * how many were numbered and how many of those are cancelled. Numbers read 'PREFIX/FY/NNNN'.
 */
export async function documentSeries(branchId, { from, to }) {
  const rows = await BillingDocument.aggregate([
    { $match: seriesMatch(branchId, { from, to }) },
    { $project: { type: 1, status: 1, number: 1, parts: { $split: ['$number', '/'] } } },
    {
      $project: {
        type: 1,
        status: 1,
        number: 1,
        seq: { $toInt: { $arrayElemAt: ['$parts', -1] } },
        prefix: {
          $reduce: {
            input: { $slice: ['$parts', { $subtract: [{ $size: '$parts' }, 1] }] },
            initialValue: '',
            in: { $cond: [{ $eq: ['$$value', ''] }, '$$this', { $concat: ['$$value', '/', '$$this'] }] },
          },
        },
      },
    },
    {
      $group: {
        _id: { type: '$type', prefix: '$prefix' },
        first: { $min: { seq: '$seq', number: '$number' } },
        last: { $max: { seq: '$seq', number: '$number' } },
        total: { $sum: 1 },
        cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
      },
    },
  ]);
  return rows
    .map((r) => ({ nature: r._id.type, prefix: r._id.prefix, from: r.first.number, to: r.last.number, total: r.total, cancelled: r.cancelled }))
    .sort((a, b) => SERIES_TYPES.indexOf(a.nature) - SERIES_TYPES.indexOf(b.nature) || a.prefix.localeCompare(b.prefix));
}

// --- Drill-down rows ------------------------------------------------------------------------------

const MONEY_ROW_METRICS = ['billed', 'collected', 'overdue_bills', 'outstanding'];

/**
 * One page of the documents behind a money figure, with the same filter as the figure:
 * `billed` (bills by date), `collected` (receipts by date), `outstanding` and `overdue_bills`
 * (bills owed, oldest due first; `bucket` narrows them to one ageing bucket). Rows: { id, type, number, date, customer, amount }.
 */
export async function moneyRows(branchId, metric, { from, to, customerFilter, bucket, cursor, limit } = {}) {
  if (!MONEY_ROW_METRICS.includes(metric)) throw new RangeError(`No money rows for ${metric}`);
  const today = todayIst();
  let page;
  let amountOf;
  if (metric === 'billed' || metric === 'collected') {
    const type = metric === 'billed' ? 'invoice' : 'receipt';
    page = await paginate(BillingDocument, periodMatch(branchId, { from, to, customerFilter, types: [type] }), { sort: ['date', -1], cursor, limit });
    amountOf = (d) => (type === 'invoice' ? d.totals.total : d.amount);
  } else {
    const filter = receivablesMatch(branchId, { customerFilter, bucket }, today);
    if (metric === 'overdue_bills') filter.dueDate = { $lt: today };
    page = await paginate(BillingDocument, filter, { sort: ['dueDate', 1], cursor, limit });
    amountOf = (d) => d.settlement.balance;
  }
  const names = await getCustomerNames(branchId, [...new Set(page.items.map((d) => String(d.customerId)))]);
  return {
    items: page.items.map((d) => ({
      id: String(d._id),
      type: d.type,
      number: d.number,
      date: d.date,
      customer: { id: String(d.customerId), name: names.get(String(d.customerId)) ?? '' },
      amount: amountOf(d),
    })),
    nextCursor: page.nextCursor,
  };
}

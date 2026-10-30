// Money questions answered from documents and allocations; nothing here keeps a running balance.
// No HTTP concerns: the M8 admin dashboard reuses these functions.
//
// M8 note (queries the dashboard should run, with the index each one uses):
//   billed       = Σ invoice totals − Σ credit-note totals, by `date`         (`register` index)
//   collected    = Σ receipts − Σ refunds, by `date`                          (`register` index)
//   outstanding / overdue / ageing = Σ settlement.balance of issued invoices   (`receivables` partial index)
//   advances held = Σ receipts − Σ allocations                                 (`allocations (branchId, customerId, date)`)
//   customer ledger / summary                                                  (`ledger` index)
//   bill and payment lists                                                     (`bills_by_date`, `drafts_by_update`)
import mongoose from 'mongoose';
import { ageingBucket, daysBetween } from '@vs/shared/billing.js';
import { addDaysYmd, istDate } from '@vs/shared/fy.js';
import { mulDivRound } from '@vs/shared/money.js';
import { clock } from '../../clock.js';
import { paginate } from '../../core/pagination.js';
import { getCustomer, getCustomerNames } from '../customers/service.js';
import { getOrderForBilling, getOrderNumbers } from '../orders/service.js';
import { readSettings } from '../settings/service.js';
import { suggestedRefund } from './corrections.js';
import { proposeLines } from './invoices.js';
import { Allocation, BillingDocument, Invoice, Receipt } from './model.js';
import { orderEstimate } from './payments.js';

const ledgerTypes = ['invoice', 'credit_note', 'receipt', 'refund'];
const ledgerStatuses = ['issued', 'cancelled'];
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const todayIst = () => istDate(clock.now());
const oid = (id) => new mongoose.Types.ObjectId(String(id));

const LABELS = { invoice: 'Bill', credit_note: 'Credit note', receipt: 'Payment received', refund: 'Refund paid' };

// --- Customer ledger -----------------------------------------------------------------------------

/** The find filter for a customer's ledger entries (the `ledger` index). */
export function ledgerFilter(branchId, customerId) {
  return { branchId: oid(branchId), customerId: oid(customerId), type: { $in: ledgerTypes }, status: { $in: ledgerStatuses } };
}

const amountOf = (doc) => (doc.type === 'invoice' || doc.type === 'credit_note' ? doc.totals.total : doc.amount);

/** debit / credit of a ledger document: cancelled documents count for nothing. */
function sides(doc) {
  if (doc.status === 'cancelled') return { debit: 0, credit: 0 };
  const amount = amountOf(doc);
  return doc.type === 'invoice' || doc.type === 'refund' ? { debit: amount, credit: 0 } : { debit: 0, credit: amount };
}

// The same rule as `sides`, as an aggregation expression giving debit − credit.
const SIGNED = {
  $cond: [
    { $eq: ['$status', 'issued'] },
    {
      $switch: {
        branches: [
          { case: { $eq: ['$type', 'invoice'] }, then: '$totals.total' },
          { case: { $eq: ['$type', 'refund'] }, then: '$amount' },
          { case: { $eq: ['$type', 'credit_note'] }, then: { $multiply: ['$totals.total', -1] } },
          { case: { $eq: ['$type', 'receipt'] }, then: { $multiply: ['$amount', -1] } },
        ],
        default: 0,
      },
    },
    0,
  ],
};

function labelOf(doc) {
  const base = doc.type === 'receipt' || doc.type === 'refund' ? `${LABELS[doc.type]} (${doc.mode})` : LABELS[doc.type];
  return doc.status === 'cancelled' ? `${base}, cancelled` : base;
}

/**
 * One page of the customer's ledger, newest first by (date, id). `balance` is the running
 * balance after each entry: one aggregate for the page's newest entry, then walking back.
 */
export async function customerLedger(branchId, customerId, { cursor, limit } = {}) {
  await getCustomer(branchId, customerId);
  const filter = ledgerFilter(branchId, customerId);
  const page = await paginate(BillingDocument, filter, { sort: ['date', -1], cursor, limit });
  if (!page.items.length) return { items: [], nextCursor: null };

  const newest = page.items[0];
  const [{ balance: newestBalance } = { balance: 0 }] = await BillingDocument.aggregate([
    { $match: { ...filter, $or: [{ date: { $lt: newest.date } }, { date: newest.date, _id: { $lte: newest._id } }] } },
    { $group: { _id: null, balance: { $sum: SIGNED } } },
  ]);

  let balance = newestBalance;
  const items = page.items.map((doc) => {
    const { debit, credit } = sides(doc);
    const item = {
      id: String(doc._id),
      type: doc.type,
      number: doc.number,
      date: doc.date,
      label: labelOf(doc),
      debit,
      credit,
      balance,
      status: doc.status,
    };
    balance -= debit - credit;
    return item;
  });
  return { items, nextCursor: page.nextCursor };
}

/**
 * { billed, received, credited, refunded, outstanding, overdue, advanceHeld } for a customer.
 * Totals count issued documents only; outstanding and overdue come from the bills' settlement
 * (the `receivables` index); advanceHeld = Σ receipts − Σ allocations.
 */
export async function customerMoneySummary(branchId, customerId) {
  await getCustomer(branchId, customerId);
  const base = { branchId: oid(branchId), customerId: oid(customerId) };
  const today = todayIst();
  const [byType, [owed], [allocated]] = await Promise.all([
    BillingDocument.aggregate([
      { $match: { ...base, type: { $in: ledgerTypes }, status: 'issued' } },
      { $group: { _id: '$type', total: { $sum: { $ifNull: ['$totals.total', '$amount'] } } } },
    ]),
    Invoice.aggregate([
      { $match: { ...base, status: 'issued', 'settlement.balance': { $gt: 0 } } },
      {
        $group: {
          _id: null,
          outstanding: { $sum: '$settlement.balance' },
          overdue: { $sum: { $cond: [{ $lt: ['$dueDate', today] }, '$settlement.balance', 0] } },
        },
      },
    ]),
    Allocation.aggregate([{ $match: base }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
  ]);
  const total = (type) => byType.find((t) => t._id === type)?.total ?? 0;
  const received = total('receipt');
  return {
    billed: total('invoice'),
    received,
    credited: total('credit_note'),
    refunded: total('refund'),
    outstanding: owed?.outstanding ?? 0,
    overdue: owed?.overdue ?? 0,
    advanceHeld: received - (allocated?.total ?? 0),
  };
}

// --- Money owed ----------------------------------------------------------------------------------

/** The `dueDate` condition of an ageing bucket (days past the due date). */
function bucketRange(bucket, today) {
  const ago = (n) => addDaysYmd(today, -n);
  switch (bucket) {
    case 'overdue': return { $lt: today };
    case 'not_due': return { $gte: today };
    case 'd0_30': return { $gte: ago(30), $lt: today };
    case 'd31_60': return { $gte: ago(60), $lte: ago(31) };
    case 'd61_90': return { $gte: ago(90), $lte: ago(61) };
    case 'd90_plus': return { $lte: ago(91) };
    default: return null;
  }
}

/** The find filter for money owed: issued bills with a balance (the `receivables` index). */
export function receivablesFilter(branchId, { bucket, customerId } = {}, today = todayIst()) {
  const filter = { branchId: oid(branchId), type: 'invoice', status: 'issued', 'settlement.balance': { $gt: 0 } };
  if (customerId) filter.customerId = oid(customerId);
  const range = bucketRange(bucket, today);
  if (range) filter.dueDate = range;
  return filter;
}

/** Bills still owed, oldest due first, with days overdue, ageing bucket and totals for the whole filter. */
export async function listReceivables(branchId, { bucket, customerId, cursor, limit } = {}) {
  const today = todayIst();
  const filter = receivablesFilter(branchId, { bucket, customerId }, today);
  const [page, [sum]] = await Promise.all([
    paginate(Invoice, filter, { sort: ['dueDate', 1], cursor, limit }),
    Invoice.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          balance: { $sum: '$settlement.balance' },
          overdue: { $sum: { $cond: [{ $lt: ['$dueDate', today] }, '$settlement.balance', 0] } },
        },
      },
    ]),
  ]);
  const names = await getCustomerNames(branchId, [...new Set(page.items.map((i) => String(i.customerId)))]);
  return {
    items: page.items.map((i) => ({
      invoice: { id: String(i._id), number: i.number, date: i.date, dueDate: i.dueDate, total: i.totals.total, balance: i.settlement.balance },
      customer: { id: String(i.customerId), name: names.get(String(i.customerId)) ?? '' },
      daysOverdue: Math.max(0, daysBetween(i.dueDate, today)),
      bucket: ageingBucket(i.dueDate, today),
    })),
    totals: { count: sum?.count ?? 0, balance: sum?.balance ?? 0, overdue: sum?.overdue ?? 0 },
    nextCursor: page.nextCursor,
  };
}

// --- Order money ---------------------------------------------------------------------------------

/**
 * What an order is worth, what is due as advance (advancePercent of the order value less the
 * receipts taken), what is held unallocated, what is billed and still owed on its bills.
 */
export async function orderMoney(branchId, orderId) {
  const { order, garments } = await getOrderForBilling(branchId, orderId);
  const [settings, estimate, bills, receipts] = await Promise.all([
    readSettings(branchId),
    orderEstimate(branchId, order, garments),
    Invoice.find({ orderId: order._id }, { number: 1, status: 1, date: 1, totals: 1, settlement: 1 }).sort({ date: 1, _id: 1 }).lean(),
    Receipt.find({ orderId: order._id }, { number: 1, status: 1, date: 1, amount: 1 }).sort({ date: 1, _id: 1 }).lean(),
  ]);
  const issuedReceipts = receipts.filter((r) => r.status === 'issued');
  const received = issuedReceipts.reduce((s, r) => s + r.amount, 0);
  const [allocated] = issuedReceipts.length
    ? await Allocation.aggregate([
        { $match: { receiptId: { $in: issuedReceipts.map((r) => r._id) } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ])
    : [];
  const issuedBills = bills.filter((b) => b.status === 'issued');
  return {
    orderValue: estimate.orderValue,
    estimatedTotal: estimate.estimatedTotal,
    advanceDue: Math.max(0, mulDivRound(estimate.orderValue, settings.advancePercent, 100) - received),
    advanceHeld: received - (allocated?.total ?? 0),
    billed: issuedBills.reduce((s, b) => s + b.totals.total, 0),
    balanceDue: issuedBills.reduce((s, b) => s + b.settlement.balance, 0),
    // Whether a new bill would have anything on it (garments, charges or a rush fee not yet billed).
    hasUnbilled: (await proposeLines(branchId, order, garments)).length > 0,
    draftInvoiceId: bills.find((b) => b.status === 'draft')?._id.toString() ?? null,
    invoices: bills
      .filter((b) => b.status !== 'draft')
      .map((b) => ({ id: String(b._id), number: b.number, status: b.status, total: b.totals.total, balance: b.settlement.balance })),
    receipts: receipts.map((r) => ({ id: String(r._id), number: r.number, date: r.date, amount: r.amount, status: r.status })),
    refundSuggestion: await suggestedRefund(branchId, order._id),
  };
}

// --- Lists ---------------------------------------------------------------------------------------

const dateRange = (from, to) => (from || to ? { ...(from && { $gte: from }), ...(to && { $lte: to }) } : null);

/** Rows { doc, customer, order } for a page of documents (names and order numbers looked up once per page). */
async function withContext(branchId, docs) {
  const [names, orders] = await Promise.all([
    getCustomerNames(branchId, [...new Set(docs.map((d) => String(d.customerId)))]),
    getOrderNumbers(branchId, [...new Set(docs.filter((d) => d.orderId).map((d) => String(d.orderId)))]),
  ]);
  return docs.map((doc) => ({
    doc,
    customer: { id: String(doc.customerId), name: names.get(String(doc.customerId)) ?? '' },
    order: doc.orderId ? { id: String(doc.orderId), orderNo: orders.get(String(doc.orderId)) ?? null } : null,
  }));
}

/**
 * Bills as rows { doc, customer, order }. Issued and cancelled bills come by date, newest first
 * (`bills_by_date`); with no status that is the default, and drafts are listed only for
 * `status: 'draft'`, by last change (`drafts_by_update`).
 */
export async function listInvoices(branchId, { status, customerId, orderId, payStatus, overdue, from, to, q, cursor, limit } = {}) {
  const today = todayIst();
  const filter = { branchId: oid(branchId), type: 'invoice', status: status ?? { $in: ledgerStatuses } };
  if (customerId) filter.customerId = oid(customerId);
  if (orderId) filter.orderId = oid(orderId);
  const range = dateRange(from, to);
  if (range) filter.date = range;
  const term = q?.trim();
  if (term) filter.number = { $regex: `${escapeRegex(term)}$`, $options: 'i' };

  // Paying and overdue only mean something for issued bills.
  const and = [];
  if (payStatus || overdue !== undefined) filter.status = 'issued';
  if (payStatus === 'paid') filter['settlement.balance'] = { $lte: 0 };
  if (payStatus === 'unpaid') {
    filter['settlement.balance'] = { $gt: 0 };
    and.push({ $expr: { $gte: ['$settlement.balance', '$totals.total'] } });
  }
  if (payStatus === 'part_paid') {
    filter['settlement.balance'] = { $gt: 0 };
    and.push({ $expr: { $lt: ['$settlement.balance', '$totals.total'] } });
  }
  if (overdue === true) {
    filter['settlement.balance'] = { $gt: 0 };
    filter.dueDate = { $lt: today };
  } else if (overdue === false) {
    and.push({ $or: [{ 'settlement.balance': { $lte: 0 } }, { dueDate: { $gte: today } }] });
  }
  if (and.length) filter.$and = and;

  const sortField = filter.status === 'draft' ? 'updatedAt' : 'date';
  const page = await paginate(Invoice, filter, { sort: [sortField, -1], cursor, limit });
  return { items: await withContext(branchId, page.items), nextCursor: page.nextCursor };
}

/** Receipts as rows { doc, customer, order }, newest date first (`bills_by_date`). */
export async function listReceipts(branchId, { customerId, from, to, mode, cursor, limit } = {}) {
  const filter = { branchId: oid(branchId), type: 'receipt', status: { $in: ledgerStatuses } };
  if (customerId) filter.customerId = oid(customerId);
  const range = dateRange(from, to);
  if (range) filter.date = range;
  if (mode) filter.mode = mode;
  const page = await paginate(Receipt, filter, { sort: ['date', -1], cursor, limit });
  return { items: await withContext(branchId, page.items), nextCursor: page.nextCursor };
}

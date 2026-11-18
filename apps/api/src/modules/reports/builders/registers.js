// Register builders: billing registers over document views (Task 2 row builders), advances,
// expenses (with input GST by category) and stock. Lists are read page by page.
import {
  REGISTER_COLUMNS, collectionsByMode, creditNoteRows, salesRegisterRows, voucherRows,
} from '@vs/shared/reports/registers.js';
import { advancesByCustomer, billingDocumentsInRange } from '../../billing/service.js';
import { expenseTotalsByCategory, listExpenses } from '../../expenses/service.js';
import { readSettings } from '../../settings/service.js';
import { listMovementsByDate, stockValuation } from '../../stock/service.js';
import { checkRowLimit } from '../writers.js';
import { allPages, registerBuilder } from './index.js';

const col = (key, label, kind = 'text') => ({ key, label, kind });
const sheetFile = (name, columns, rows) => ({ files: [{ sheets: [{ name, columns, rows }] }] });

/** Every view of `types` in [from, to], refusing more than `maxRows` as they stream in. */
export async function viewsInRange(branchId, { types, from, to }, maxRows) {
  const views = [];
  for await (const view of billingDocumentsInRange(branchId, { types, from, to })) {
    views.push(view);
    checkRowLimit(views.length, maxRows);
  }
  return views;
}

registerBuilder('sales_register', async (branchId, { from, to }, { maxRows }) => {
  const views = await viewsInRange(branchId, { types: ['invoice'], from, to }, maxRows);
  return sheetFile('Sales register', REGISTER_COLUMNS.sales, salesRegisterRows(views));
});

registerBuilder('credit_note_register', async (branchId, { from, to }, { maxRows }) => {
  const views = await viewsInRange(branchId, { types: ['credit_note'], from, to }, maxRows);
  return sheetFile('Credit notes', REGISTER_COLUMNS.creditNotes, creditNoteRows(views));
});

registerBuilder('receipt_voucher_register', async (branchId, { from, to }, { maxRows }) => {
  const views = await viewsInRange(branchId, { types: ['receipt_voucher'], from, to }, maxRows);
  return sheetFile('Receipt vouchers', REGISTER_COLUMNS.receiptVouchers, voucherRows(views, 'receipt_voucher'));
});

registerBuilder('refund_register', async (branchId, { from, to }, { maxRows }) => {
  const views = await viewsInRange(branchId, { types: ['refund'], from, to }, maxRows);
  return sheetFile('Refunds', REGISTER_COLUMNS.refunds, voucherRows(views, 'refund'));
});

registerBuilder('collections_by_mode', async (branchId, { from, to }, { maxRows }) => {
  const views = await viewsInRange(branchId, { types: ['receipt', 'refund'], from, to }, maxRows);
  return sheetFile('Collections by mode', REGISTER_COLUMNS.collections, collectionsByMode(views));
});

const ADVANCE_COLUMNS = [
  col('customer', 'Customer'),
  col('received', 'Received', 'money'),
  col('allocated', 'Used on bills or refunded', 'money'),
  col('held', 'Held now', 'money'),
];

registerBuilder('advances_held', async (branchId, params, { maxRows }) => {
  const items = await allPages((page) => advancesByCustomer(branchId, page), maxRows, checkRowLimit);
  const rows = items.map((r) => ({ customer: r.customer.name, received: r.received, allocated: r.allocated, held: r.advancesHeld }));
  return sheetFile('Advances held', ADVANCE_COLUMNS, rows);
});

const MODE_LABELS = { cash: 'Cash', upi: 'UPI', card: 'Card', bank_transfer: 'Bank transfer' };

const EXPENSE_COLUMNS = [
  col('number', 'Expense number'),
  col('date', 'Date', 'date'),
  col('category', 'Category'),
  col('payee', 'Paid to'),
  col('gstin', 'GSTIN'),
  col('billNo', 'Bill number'),
  col('taxable', 'Before GST', 'money'),
  col('cgst', 'CGST', 'money'),
  col('sgst', 'SGST', 'money'),
  col('igst', 'IGST', 'money'),
  col('total', 'Total', 'money'),
  col('itc', 'GST claimable'),
  col('mode', 'Paid by'),
  col('status', 'Status'),
];

const BY_CATEGORY_COLUMNS = [
  col('category', 'Category'),
  col('count', 'Expenses', 'number'),
  col('total', 'Total', 'money'),
  col('cgst', 'CGST', 'money'),
  col('sgst', 'SGST', 'money'),
  col('igst', 'IGST', 'money'),
  col('itc', 'GST you can claim', 'money'),
];

/** One register row; a voided expense stays listed at zero value (like a cancelled bill). */
function expenseRow(e, labels) {
  const live = e.status !== 'voided';
  const g = e.gst;
  const zero = (v) => (live ? (v ?? 0) : 0);
  return {
    number: e.number,
    date: e.date,
    category: labels.get(e.category) ?? e.category,
    payee: e.payee?.name ?? '',
    gstin: e.payee?.gstin ?? '',
    billNo: g?.billNo ?? '',
    taxable: zero(g ? g.taxable : e.total),
    cgst: zero(g?.cgst),
    sgst: zero(g?.sgst),
    igst: zero(g?.igst),
    total: zero(e.total),
    itc: g ? (g.itcEligible ? 'Yes' : 'No') : '',
    mode: MODE_LABELS[e.mode] ?? e.mode,
    status: live ? 'Active' : 'Voided',
  };
}

registerBuilder('expense_register', async (branchId, { from, to }, { maxRows }) => {
  const [items, settings, totals] = await Promise.all([
    allPages((page) => listExpenses(branchId, { from, to, status: 'all', ...page }), maxRows, checkRowLimit),
    readSettings(branchId),
    expenseTotalsByCategory(branchId, { from, to }),
  ]);
  const labels = new Map(settings.expenseCategories.map((c) => [c.key, c.label]));
  const sorted = [...items].sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number, 'en', { numeric: true }));
  // Input GST per category from the active expenses; totals and counts from the expenses summary.
  const gst = new Map();
  for (const e of items) {
    if (e.status === 'voided' || !e.gst) continue;
    const t = gst.get(e.category) ?? { cgst: 0, sgst: 0, igst: 0, itc: 0 };
    t.cgst += e.gst.cgst;
    t.sgst += e.gst.sgst;
    t.igst += e.gst.igst;
    if (e.gst.itcEligible) t.itc += e.gst.cgst + e.gst.sgst + e.gst.igst;
    gst.set(e.category, t);
  }
  const byCategory = totals.map((t) => ({
    category: labels.get(t.category) ?? t.category,
    count: t.count,
    total: t.total,
    ...(gst.get(t.category) ?? { cgst: 0, sgst: 0, igst: 0, itc: 0 }),
  }));
  return {
    files: [{
      sheets: [
        { name: 'Expenses', columns: EXPENSE_COLUMNS, rows: sorted.map((e) => expenseRow(e, labels)) },
        { name: 'By category', columns: BY_CATEGORY_COLUMNS, rows: byCategory },
      ],
    }],
  };
});

const MOVEMENT_LABELS = {
  opening: 'Opening stock',
  purchase_in: 'Bought',
  reserve: 'Set aside for an order',
  release: 'Released from an order',
  consume: 'Used on a garment',
  adjust: 'Count adjustment',
  sale: 'Sold on a bill',
};
const qty = (milli) => milli / 1000;

const MOVEMENT_COLUMNS = [
  col('date', 'Date', 'date'),
  col('type', 'Movement'),
  col('item', 'Item'),
  col('unit', 'Unit'),
  col('quantity', 'Quantity', 'number'),
  col('valueChange', 'Value change', 'money'),
  col('garmentNo', 'Garment'),
  col('reason', 'Reason'),
];

registerBuilder('stock_movements', async (branchId, { from, to }, { maxRows }) => {
  const items = await allPages((page) => listMovementsByDate(branchId, { from, to, ...page }), maxRows, checkRowLimit);
  const rows = items
    .map((m) => ({
      date: m.date,
      type: MOVEMENT_LABELS[m.type] ?? m.type,
      item: m.item.name,
      unit: m.item.usageUnit ?? '',
      quantity: qty(m.quantity),
      valueChange: m.valueChange,
      garmentNo: m.reference.garmentNo ?? '',
      reason: m.reason,
    }))
    .reverse();
  return sheetFile('Stock movements', MOVEMENT_COLUMNS, rows);
});

const VALUATION_COLUMNS = [
  col('item', 'Item'),
  col('unit', 'Unit'),
  col('onHand', 'On hand', 'number'),
  col('reserved', 'Set aside', 'number'),
  col('value', 'Value', 'money'),
  col('reservedValue', 'Value set aside', 'money'),
];

registerBuilder('stock_valuation', async (branchId) => {
  const v = await stockValuation(branchId);
  const rows = v.items.map((i) => ({
    item: i.name, unit: i.usageUnit, onHand: qty(i.onHand), reserved: qty(i.reserved), value: i.value, reservedValue: i.reservedValue,
  }));
  return sheetFile('Stock valuation', VALUATION_COLUMNS, rows);
});

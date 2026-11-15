// Ledger builders: the customer statement (Excel or PDF), who owes what per customer, the day book.
import { dayBookRows, REGISTER_COLUMNS } from '@vs/shared/reports/registers.js';
import { displayDate } from '@vs/shared/fy.js';
import { formatINR } from '@vs/shared/money.js';
import { customerLedger, listReceivables } from '../../billing/service.js';
import { getBranch } from '../../branches/service.js';
import { getCustomer } from '../../customers/service.js';
import { listExpenses } from '../../expenses/service.js';
import { checkRowLimit, toPdf } from '../writers.js';
import { allPages, registerBuilder } from './index.js';
import { viewsInRange } from './registers.js';

const col = (key, label, kind = 'text') => ({ key, label, kind });

const STATEMENT_COLUMNS = [
  col('date', 'Date', 'date'),
  col('label', 'Entry'),
  col('number', 'Number'),
  col('debit', 'Billed / refunded', 'money'),
  col('credit', 'Paid / credited', 'money'),
  col('balance', 'Balance', 'money'),
];

/**
 * The statement's rows: the opening balance (the ledger balance after the last entry before
 * `from`), each entry in [from, to] oldest first, then the closing balance. The whole ledger is
 * read page by page (C16).
 */
export async function statementRows(branchId, { customerId, from, to }, maxRows) {
  const entries = await allPages((page) => customerLedger(branchId, customerId, page), maxRows, checkRowLimit);
  const oldestFirst = [...entries].reverse();
  const before = oldestFirst.filter((e) => e.date < from);
  const opening = before.length ? before.at(-1).balance : 0;
  const inRange = oldestFirst.filter((e) => e.date >= from && e.date <= to);
  const closing = inRange.length ? inRange.at(-1).balance : opening;
  return [
    { date: from, label: 'Opening balance', number: '', debit: null, credit: null, balance: opening },
    ...inRange.map((e) => ({ date: e.date, label: e.label, number: e.number, debit: e.debit, credit: e.credit, balance: e.balance })),
    { date: to, label: 'Closing balance', number: '', debit: null, credit: null, balance: closing },
  ];
}

const rupees = (paise) => (paise === null || paise === undefined ? '' : formatINR(paise));

/** A pdfmake document for the statement: the shop, the customer, the period and the entries. */
function statementDoc({ branch, customer, from, to, rows }) {
  const address = [branch.address?.line1, branch.address?.line2, branch.address?.city, branch.address?.pincode].filter(Boolean).join(', ');
  return {
    content: [
      { text: branch.legalName ?? branch.name, bold: true, fontSize: 14 },
      { text: [address, branch.gstin ? `GSTIN ${branch.gstin}` : ''].filter(Boolean).join(' · '), margin: [0, 2, 0, 10] },
      { text: `Statement for ${customer.name}`, bold: true, fontSize: 12 },
      { text: `${displayDate(from)} to ${displayDate(to)}`, margin: [0, 2, 0, 10] },
      {
        table: {
          headerRows: 1,
          widths: ['auto', '*', 'auto', 'auto', 'auto', 'auto'],
          body: [
            STATEMENT_COLUMNS.map((c) => ({ text: c.label, bold: true })),
            ...rows.map((r) => [displayDate(r.date), r.label, r.number, rupees(r.debit), rupees(r.credit), rupees(r.balance)]),
          ],
        },
        layout: 'lightHorizontalLines',
      },
    ],
  };
}

registerBuilder('customer_statement', async (branchId, params, { maxRows, format }) => {
  const rows = await statementRows(branchId, params, maxRows);
  const sheets = [{ name: 'Statement', columns: STATEMENT_COLUMNS, rows }];
  if (format !== 'pdf') return { files: [{ sheets }] };
  const [branch, customer] = await Promise.all([getBranch(branchId), getCustomer(branchId, params.customerId)]);
  return { files: [{ sheets, pdf: await toPdf(statementDoc({ branch, customer, from: params.from, to: params.to, rows })) }] };
});

const BUCKETS = ['not_due', 'd0_30', 'd31_60', 'd61_90', 'd90_plus'];
const AGEING_COLUMNS = [
  col('customer', 'Customer'),
  col('not_due', 'Not due yet', 'money'),
  col('d0_30', '1–30 days late', 'money'),
  col('d31_60', '31–60 days late', 'money'),
  col('d61_90', '61–90 days late', 'money'),
  col('d90_plus', 'Over 90 days late', 'money'),
  col('total', 'Total owed', 'money'),
];

registerBuilder('receivables_ageing', async (branchId, params, { maxRows }) => {
  const items = await allPages((page) => listReceivables(branchId, page), maxRows, checkRowLimit);
  const byCustomer = new Map();
  for (const i of items) {
    const row = byCustomer.get(i.customer.id) ?? { customer: i.customer.name, ...Object.fromEntries(BUCKETS.map((b) => [b, 0])), total: 0 };
    row[i.bucket] += i.invoice.balance;
    row.total += i.invoice.balance;
    byCustomer.set(i.customer.id, row);
  }
  const rows = [...byCustomer.values()].sort((a, b) => b.total - a.total || a.customer.localeCompare(b.customer));
  return { files: [{ sheets: [{ name: 'Who owes what', columns: AGEING_COLUMNS, rows }] }] };
});

registerBuilder('day_book', async (branchId, { from, to }, { maxRows }) => {
  const [billing, expenses] = await Promise.all([
    viewsInRange(branchId, { types: ['invoice', 'credit_note', 'receipt', 'refund'], from, to }, maxRows),
    allPages((page) => listExpenses(branchId, { from, to, ...page }), maxRows, checkRowLimit),
  ]);
  const rows = dayBookRows({
    billing,
    expenses: expenses.map((e) => ({ number: e.number, date: e.date, payee: { name: e.payee?.name ?? '' }, total: e.total, status: e.status })),
  });
  return { files: [{ sheets: [{ name: 'Day book', columns: REGISTER_COLUMNS.dayBook, rows }] }] };
});

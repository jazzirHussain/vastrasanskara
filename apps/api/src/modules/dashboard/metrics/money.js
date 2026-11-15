// Money key numbers (gross, Decision 5: credit notes and refunds as sub-lines), billed against
// collected by month, and who owes what.
import { addDaysYmd } from '@vs/shared/fy.js';
import { advancesByCustomer, advancesHeld, monthlyMoney, periodMoney } from '../../billing/service.js';
import { ageingOf, billRows } from './attention.js';
import { registerMetric } from './index.js';

export const periodOf = (ctx) => ctx.memo('period', () => periodMoney(ctx.branchId, { ...ctx.range, customerFilter: ctx.customerFilter }));

registerMetric({
  id: 'billed',
  async figure(ctx) {
    const m = await periodOf(ctx);
    return { amount: m.billed, count: m.invoices, credited: m.credited };
  },
  rows: (ctx, page) => billRows(ctx, 'billed', page),
});

registerMetric({
  id: 'collected',
  async figure(ctx) {
    const m = await periodOf(ctx);
    return { amount: m.collected, count: m.receipts, refunded: m.refunded };
  },
  rows: (ctx, page) => billRows(ctx, 'collected', page),
});

registerMetric({
  id: 'outstanding',
  async figure(ctx) {
    const a = await ageingOf(ctx);
    return { amount: a.outstanding, count: a.count };
  },
  rows: (ctx, page) => billRows(ctx, 'outstanding', page),
});

registerMetric({
  id: 'overdue_amount',
  async figure(ctx) {
    const a = await ageingOf(ctx);
    return { amount: a.overdueAmount, count: a.overdueCount };
  },
  rows: (ctx, page) => billRows(ctx, 'overdue_bills', page),
});

registerMetric({
  id: 'advances_held',
  async figure(ctx) {
    const a = await advancesHeld(ctx.branchId, { customerFilter: ctx.customerFilter });
    return { amount: a.advancesHeld, count: a.customers };
  },
  async rows(ctx, { cursor, limit } = {}) {
    const page = await advancesByCustomer(ctx.branchId, { cursor, limit, customerFilter: ctx.customerFilter });
    return {
      items: page.items.map((r) => ({
        id: r.customer.id,
        title: r.customer.name,
        subtitle: 'Advance not yet used on a bill',
        amount: r.advancesHeld,
        link: `/customers/${r.customer.id}`,
      })),
      nextCursor: page.nextCursor,
    };
  },
});

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym) => `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const monthEnd = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return addDaysYmd(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`, -1);
};
const monthsBefore = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) - n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};

/** The months the chart shows: the financial year's for preset `fy`, else the last six ending with the range's month. */
export function chartWindow(ctx) {
  const lastMonth = ctx.range.to.slice(0, 7);
  const first = ctx.preset === 'fy' ? ctx.range.from.slice(0, 7) : monthsBefore(lastMonth, 5);
  return { from: `${first}-01`, to: ctx.range.to };
}

registerMetric({
  id: 'month_money',
  async figure(ctx) {
    const months = await monthlyMoney(ctx.branchId, { ...chartWindow(ctx), customerFilter: ctx.customerFilter });
    return {
      amount: months.reduce((s, m) => s + m.billed, 0),
      breakdown: months.map((m) => ({ key: m.month, label: monthLabel(m.month), billed: m.billed, collected: m.collected })),
    };
  },
  rows(ctx, { key, ...page } = {}) {
    const window = chartWindow(ctx);
    const range = key ? { from: `${key}-01`, to: monthEnd(key) < window.to ? monthEnd(key) : window.to } : window;
    return billRows(ctx.atRange(range), 'billed', page);
  },
});

const BUCKET_LABELS = {
  not_due: 'Not due yet',
  d0_30: '1–30 days late',
  d31_60: '31–60 days late',
  d61_90: '61–90 days late',
  d90_plus: 'Over 90 days late',
};

registerMetric({
  id: 'receivables_ageing',
  async figure(ctx) {
    const a = await ageingOf(ctx);
    return {
      amount: a.outstanding,
      count: a.count,
      breakdown: Object.entries(BUCKET_LABELS).map(([key, label]) => ({ key, label, amount: a.buckets[key] })),
      top: a.topCustomers,
    };
  },
  rows: (ctx, { key, ...page } = {}) => billRows(ctx, 'outstanding', page, { bucket: key }),
});

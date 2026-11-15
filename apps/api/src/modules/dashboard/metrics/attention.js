// Needs attention today (Decision 8): late garments, pickups at risk, vendors running late,
// failed quality checks, fittings today, follow-up calls, low stock, orders on hold, overdue bills.
import { addDaysYmd } from '@vs/shared/fy.js';
import { isPickupAtRisk } from '@vs/shared/production.js';
import { appointmentsForDay } from '../../appointments/service.js';
import { moneyRows, receivablesAgeing } from '../../billing/service.js';
import { followUpsDue, listEnquiries } from '../../enquiries/service.js';
import { countOrdersByStatus, listOrdersByStatus } from '../../orders/service.js';
import { qcFailures } from '../../production/service.js';
import { listItems, lowStockItems } from '../../stock/service.js';
import { orderFilters } from '../filters.js';
import { pageArray, registerMetric } from './index.js';
import { compact, garmentRow, orderRow, stageLabel } from './rows.js';

export const QC_WINDOW_DAYS = 7;
export const LOW_STOCK_CAP = 500;

/** A count of open garments matching `test`, with rows of the same garments. */
function garmentMetric(id, test) {
  const matching = async (ctx) => {
    const { items, truncated } = await ctx.openGarments();
    return { items: items.filter((i) => test(i, ctx)), truncated };
  };
  registerMetric({
    id,
    async figure(ctx) {
      const { items, truncated } = await matching(ctx);
      return { count: items.length, truncated };
    },
    async rows(ctx, page) {
      const { items } = await matching(ctx);
      return pageArray(items.map(garmentRow), page);
    },
  });
}

garmentMetric('late_garments', (i) => i.late);
garmentMetric('pickups_at_risk', (i, ctx) => isPickupAtRisk(i, ctx.today));
garmentMetric(
  'vendor_overdue',
  (i, ctx) => i.garment.stageState === 'with_vendor' && Boolean(i.garment.vendorWork?.dueBackDate) && i.garment.vendorWork.dueBackDate < ctx.today,
);

/** QC failures of the last seven days on open garments that pass the filters. */
function qcRows(ctx) {
  return ctx.memo('qc', async () => {
    const [{ items, truncated }, failures] = await Promise.all([
      ctx.openGarments(),
      qcFailures(ctx.branchId, ctx.user, { since: addDaysYmd(ctx.today, -(QC_WINDOW_DAYS - 1)) }),
    ]);
    const open = new Map(items.map((i) => [String(i.garment._id), i]));
    return { rows: failures.filter((f) => open.has(f.garmentId)).map((f) => ({ failure: f, item: open.get(f.garmentId) })), truncated };
  });
}

registerMetric({
  id: 'qc_failed',
  async figure(ctx) {
    const { rows, truncated } = await qcRows(ctx);
    return { count: rows.length, truncated };
  },
  async rows(ctx, page) {
    const { rows } = await qcRows(ctx);
    return pageArray(
      rows.map(({ failure, item }) => {
        const row = garmentRow(item);
        return { ...row, subtitle: failure.reason || row.subtitle, badge: stageLabel(failure.stage) };
      }),
      page,
    );
  },
});

const fittingsOf = async (ctx) => {
  const day = await ctx.memo('day', () => appointmentsForDay(ctx.branchId, ctx.user, { date: ctx.today, designerId: ctx.designerId }));
  return day.designers
    .flatMap((d) => d.appointments)
    .filter((a) => a.type === 'fitting')
    .sort((a, b) => new Date(a.start) - new Date(b.start));
};

registerMetric({
  id: 'fittings_today',
  async figure(ctx) {
    return { count: (await fittingsOf(ctx)).length };
  },
  async rows(ctx, page) {
    const cards = await fittingsOf(ctx);
    return pageArray(
      cards.map((a) => ({
        id: a.id,
        title: a.customer?.name ?? a.enquiry?.name ?? '',
        subtitle: `${a.time} · ${a.designer?.name ?? ''}`,
        date: a.date,
        badge: a.status,
        link: `/appointments?date=${a.date}`,
      })),
      page,
    );
  },
});

registerMetric({
  id: 'follow_ups_due',
  async figure(ctx) {
    const { count, overdue } = await followUpsDue(ctx.branchId, ctx.today);
    return { count, overdue };
  },
  async rows(ctx, { cursor, limit } = {}) {
    const page = await listEnquiries(ctx.branchId, { view: 'follow_ups', cursor, limit }, { today: ctx.today });
    return {
      items: page.items.map((e) =>
        compact({
          id: String(e._id),
          title: e.name,
          subtitle: e.followUpDate ? `Call by ${e.followUpDate}` : '',
          date: e.followUpDate ?? undefined,
          badge: e.followUpDate && e.followUpDate < ctx.today ? 'Overdue' : undefined,
          link: `/enquiries/${e._id}`,
        }),
      ),
      nextCursor: page.nextCursor,
    };
  },
});

export const lowStockOf = (ctx) => ctx.memo('low', () => lowStockItems(ctx.branchId, { limit: LOW_STOCK_CAP + 1 }));

/** Low stock items as rows (name and category only: stock records carry money). */
export async function lowStockRows(ctx, { cursor, limit } = {}) {
  const page = await listItems(ctx.branchId, { low: true, cursor, limit });
  return {
    items: page.items.map((i) => ({ id: String(i._id), title: i.name, subtitle: i.category ?? '', badge: 'Low', link: `/stock/${i._id}` })),
    nextCursor: page.nextCursor,
  };
}

registerMetric({
  id: 'low_stock',
  async figure(ctx) {
    const items = await lowStockOf(ctx);
    return { count: Math.min(items.length, LOW_STOCK_CAP), truncated: items.length > LOW_STOCK_CAP };
  },
  rows: lowStockRows,
});

registerMetric({
  id: 'on_hold_orders',
  async figure(ctx) {
    return { count: await countOrdersByStatus(ctx.branchId, ctx.user, 'on_hold', orderFilters(ctx)) };
  },
  async rows(ctx, page) {
    const out = await listOrdersByStatus(ctx.branchId, ctx.user, 'on_hold', orderFilters(ctx), page);
    return { items: out.items.map(orderRow), nextCursor: out.nextCursor };
  },
});

export const ageingOf = (ctx) => ctx.memo('ageing', () => receivablesAgeing(ctx.branchId, { customerFilter: ctx.customerFilter }));

/** Task 3 money rows as drill-down rows. */
export async function billRows(ctx, metric, { cursor, limit } = {}) {
  const page = await moneyRows(ctx.branchId, metric, { ...ctx.range, customerFilter: ctx.customerFilter, cursor, limit });
  return {
    items: page.items.map((r) => ({
      id: r.id,
      title: r.number,
      subtitle: r.customer.name,
      amount: r.amount,
      date: r.date,
      link: r.type === 'receipt' ? `/payments/${r.id}` : `/bills/${r.id}`,
    })),
    nextCursor: page.nextCursor,
  };
}

registerMetric({
  id: 'overdue_bills',
  async figure(ctx) {
    const a = await ageingOf(ctx);
    return { count: a.overdueCount, amount: a.overdueAmount };
  },
  rows: (ctx, page) => billRows(ctx, 'overdue_bills', page),
});

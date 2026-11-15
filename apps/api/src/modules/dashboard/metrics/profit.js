// Profit (Decision 6): sales before GST less credit notes, less materials used (consumed on
// garments or sold on bills), less running costs (expenses without stock purchases, which reach
// cost only when the stock is used). Per-order profit of the latest invoiced orders.
import { invoicedOrderIds } from '../../billing/service.js';
import { orderProfits } from '../../costing/service.js';
import { expenseCostTotal } from '../../expenses/service.js';
import { orderNumbersMatching } from '../../orders/service.js';
import { materialCostTotal } from '../../stock/service.js';
import { orderFilters } from '../filters.js';
import { pageArray, registerMetric } from './index.js';
import { periodOf } from './money.js';

const EACH_END = 5;

async function profitOf(ctx) {
  return ctx.memo('profit', async () => {
    const [money, material, costs] = await Promise.all([
      periodOf(ctx),
      materialCostTotal(ctx.branchId, ctx.range),
      expenseCostTotal(ctx.branchId, ctx.range),
    ]);
    const revenue = money.taxable - money.creditedTaxable;
    const expenses = costs.cost - costs.purchaseCost;
    return { revenue, material, expenses, profit: revenue - material - expenses };
  });
}

registerMetric({
  id: 'profit',
  async figure(ctx) {
    const p = await profitOf(ctx);
    return { ...p, amount: p.profit };
  },
  // The parts the profit is made of; they add up to it.
  async rows(ctx, page) {
    const p = await profitOf(ctx);
    return pageArray(
      [
        { id: 'revenue', title: 'Sales before GST, less credit notes', amount: p.revenue, link: '/reports' },
        { id: 'material', title: 'Materials used', amount: -p.material, link: '/stock' },
        { id: 'expenses', title: 'Running costs (not stock purchases)', amount: -p.expenses, link: '/expenses' },
      ],
      page,
    );
  },
});

/** The latest invoiced orders of the range (one page of 100) that pass the filters, lowest profit first. */
async function orderList(ctx) {
  return ctx.memo('orderProfits', async () => {
    const { ids } = await invoicedOrderIds(ctx.branchId, { ...ctx.range, limit: 100 });
    const numbers = await orderNumbersMatching(ctx.branchId, ctx.user, ids, orderFilters(ctx));
    const kept = ids.filter((id) => numbers.has(id));
    const profits = await orderProfits(ctx.branchId, kept);
    return kept
      .map((id) => ({ orderId: id, orderNo: numbers.get(id), revenue: profits.get(id).revenue, profit: profits.get(id).profit }))
      .sort((a, b) => a.profit - b.profit || a.orderId.localeCompare(b.orderId));
  });
}

registerMetric({
  id: 'order_profits',
  async figure(ctx) {
    const list = await orderList(ctx);
    return { count: list.length, lowest: list.slice(0, EACH_END), highest: list.slice(-EACH_END).reverse() };
  },
  async rows(ctx, page) {
    return pageArray(
      (await orderList(ctx)).map((o) => ({ id: o.orderId, title: o.orderNo, subtitle: 'Profit on this order', amount: o.profit, link: `/orders/${o.orderId}` })),
      page,
    );
  },
});

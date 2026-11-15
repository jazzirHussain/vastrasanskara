// Stock tile: items running low, stock set aside for orders (money) and profit per item (money).
import { stockItemProfit, stockValuation } from '../../stock/service.js';
import { LOW_STOCK_CAP, lowStockOf, lowStockRows } from './attention.js';
import { pageArray, registerMetric } from './index.js';

const TOP_ITEMS = 5;

registerMetric({
  id: 'stock_low',
  async figure(ctx) {
    const items = await lowStockOf(ctx);
    return { count: Math.min(items.length, LOW_STOCK_CAP), truncated: items.length > LOW_STOCK_CAP };
  },
  rows: lowStockRows,
});

const valuationOf = (ctx) => ctx.memo('valuation', () => stockValuation(ctx.branchId));
const reservedItems = async (ctx) => (await valuationOf(ctx)).items.filter((i) => i.reserved > 0);

registerMetric({
  id: 'stock_reserved',
  async figure(ctx) {
    const v = await valuationOf(ctx);
    return { amount: v.reservedValue, count: v.items.filter((i) => i.reserved > 0).length };
  },
  async rows(ctx, page) {
    return pageArray(
      (await reservedItems(ctx)).map((i) => ({
        id: i.stockItemId,
        title: i.name,
        subtitle: `${i.reserved / 1000} ${i.usageUnit} set aside`,
        amount: i.reservedValue,
        link: `/stock/${i.stockItemId}`,
      })),
      page,
    );
  },
});

/** Items used or sold in the range, best profit first; items with no selling price last. */
const itemProfits = async (ctx) =>
  (await ctx.memo('itemProfit', () => stockItemProfit(ctx.branchId, ctx.range))).slice().sort((a, b) => {
    if (a.profit === null || b.profit === null) return a.profit === null ? (b.profit === null ? 0 : 1) : -1;
    return b.profit - a.profit || a.name.localeCompare(b.name);
  });

registerMetric({
  id: 'stock_item_profit',
  async figure(ctx) {
    const rows = await itemProfits(ctx);
    return {
      amount: rows.reduce((s, r) => s + (r.profit ?? 0), 0),
      count: rows.length,
      top: rows.slice(0, TOP_ITEMS).map((r) => ({
        key: r.stockItemId, label: r.name, cost: r.cost, sales: r.sales, profit: r.profit, noSellingPrice: r.profit === null,
      })),
    };
  },
  async rows(ctx, page) {
    return pageArray(
      (await itemProfits(ctx)).map((r) => {
        const row = { id: r.stockItemId, title: r.name, subtitle: r.profit === null ? 'No selling price' : 'Used or sold in this period', link: `/stock/${r.stockItemId}` };
        if (r.profit !== null) row.amount = r.profit;
        return row;
      }),
      page,
    );
  },
});

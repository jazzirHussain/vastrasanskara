// Spending by category in the period, with the branch's category labels.
import { expenseTotalsByCategory, listExpenses } from '../../expenses/service.js';
import { readSettings } from '../../settings/service.js';
import { registerMetric } from './index.js';

const labelsOf = (ctx) =>
  ctx.memo('categoryLabels', async () => new Map((await readSettings(ctx.branchId)).expenseCategories.map((c) => [c.key, c.label])));

registerMetric({
  id: 'expense_categories',
  async figure(ctx) {
    const [rows, labels] = await Promise.all([expenseTotalsByCategory(ctx.branchId, ctx.range), labelsOf(ctx)]);
    return {
      amount: rows.reduce((s, r) => s + r.total, 0),
      count: rows.reduce((s, r) => s + r.count, 0),
      breakdown: rows.map((r) => ({ key: r.category, label: labels.get(r.category) ?? r.category, amount: r.total, count: r.count })),
    };
  },
  async rows(ctx, { key, cursor, limit } = {}) {
    const [page, labels] = await Promise.all([listExpenses(ctx.branchId, { ...ctx.range, category: key, cursor, limit }), labelsOf(ctx)]);
    return {
      items: page.items.map((e) => ({
        id: String(e._id),
        title: e.payee?.name ?? '',
        subtitle: labels.get(e.category) ?? e.category,
        amount: e.total,
        date: e.date,
        link: `/expenses/${e._id}`,
      })),
      nextCursor: page.nextCursor,
    };
  },
});

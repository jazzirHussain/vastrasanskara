import { createItem, findStockItem } from '../../stock/service.js';
import { registerImportKind } from './index.js';

const labelOf = (d) => [d.name, d.brand, d.colour].filter(Boolean).join(' · ');

// Stock on the shelf comes in as the item's first movement (`opening`), at its cost, through the
// stock service, which audits the new item.
registerImportKind('stock', {
  context: async () => ({}),
  async check({ data }, ctx) {
    const existing = await findStockItem(ctx.branchId, data);
    return { status: existing ? 'exists' : 'ready', label: labelOf(data) };
  },
  async commit([row], ctx, actor) {
    if (await findStockItem(ctx.branchId, row.data)) return { status: 'skipped', entityId: null };
    const item = await createItem(ctx.branchId, row.data, actor);
    return { status: 'added', entityId: item._id };
  },
});

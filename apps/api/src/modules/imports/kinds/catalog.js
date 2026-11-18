import { createItem, findItemByName } from '../../catalog/service.js';
import { registerImportKind } from './index.js';

// Garment types were read against the branch's settings (parseRow); the catalog service still
// refuses a type another active item already bills (CATALOG_MAPPING_TAKEN → the row fails).
registerImportKind('catalog', {
  context: async () => ({}),
  async check({ data }, ctx) {
    const existing = await findItemByName(ctx.branchId, data.name);
    return { status: existing ? 'exists' : 'ready', label: data.name };
  },
  async commit([row], ctx, actor) {
    if (await findItemByName(ctx.branchId, row.data.name)) return { status: 'skipped', entityId: null };
    const item = await createItem(ctx.branchId, row.data, actor);
    return { status: 'added', entityId: item._id };
  },
});

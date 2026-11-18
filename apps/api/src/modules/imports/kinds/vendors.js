import { createVendor, findVendorByName } from '../../vendors/service.js';
import { registerImportKind } from './index.js';

registerImportKind('vendors', {
  context: async () => ({}),
  async check({ data }, ctx) {
    const existing = await findVendorByName(ctx.branchId, data.name);
    return { status: existing ? 'exists' : 'ready', label: data.name };
  },
  async commit([row], ctx, actor) {
    if (await findVendorByName(ctx.branchId, row.data.name)) return { status: 'skipped', entityId: null };
    const vendor = await createVendor(ctx.branchId, row.data, actor);
    return { status: 'added', entityId: vendor._id };
  },
});

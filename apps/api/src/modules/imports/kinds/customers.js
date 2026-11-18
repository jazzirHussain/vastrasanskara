import { createCustomer, findCustomerByPhone } from '../../customers/service.js';
import { registerImportKind } from './index.js';

// Customers are added quietly: creating one sends no message (consent is only recorded).
registerImportKind('customers', {
  context: async () => ({}),
  async check({ data }, ctx) {
    const existing = await findCustomerByPhone(ctx.branchId, data.phone);
    return { status: existing ? 'exists' : 'ready', label: data.name };
  },
  async commit([row], ctx, actor) {
    if (await findCustomerByPhone(ctx.branchId, row.data.phone)) return { status: 'skipped', entityId: null };
    try {
      const customer = await createCustomer(ctx.branchId, row.data, actor);
      return { status: 'added', entityId: customer._id };
    } catch (err) {
      // Added by someone else between the lookup and the save.
      if (err?.code === 'PHONE_TAKEN') return { status: 'skipped', entityId: null };
      throw err;
    }
  },
});

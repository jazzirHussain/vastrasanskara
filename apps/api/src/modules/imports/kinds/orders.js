import { findCustomerByPhone } from '../../customers/service.js';
import { findOrderByLegacyRef, importOrder } from '../../orders/service.js';
import { listDesignerContacts } from '../../users/service.js';
import { registerImportKind } from './index.js';

const tenDigits = (e164) => String(e164).replace(/^\+91/, '');

async function customerFor(ctx, phone) {
  if (!ctx.customers.has(phone)) ctx.customers.set(phone, await findCustomerByPhone(ctx.branchId, phone));
  return ctx.customers.get(phone);
}

// Open orders: one row per garment; rows sharing an old order number make one order, added
// whole (or not at all) through the orders service. Order fields come from the order's first row.
registerImportKind('orders', {
  async context(branchId) {
    return { designers: await listDesignerContacts(branchId), customers: new Map(), groups: new Map() };
  },
  group: (data) => data.legacyRef.trim().toLowerCase().replace(/\s+/g, ' '),
  async check({ data, rowNo, groupKey }, ctx) {
    const label = `Old no. ${data.legacyRef}`;
    const first = ctx.groups.get(groupKey);
    if (first) {
      if (first.customerPhone !== data.customerPhone) {
        return { status: 'error', label, errors: [{ column: 'Customer phone', message: `Row ${first.rowNo} of this order has another customer.` }] };
      }
      if (first.pickupDate !== data.pickupDate) {
        return { status: 'error', label, errors: [{ column: 'Pickup date', message: `Row ${first.rowNo} of this order has another pickup date.` }] };
      }
    } else {
      ctx.groups.set(groupKey, { rowNo, customerPhone: data.customerPhone, pickupDate: data.pickupDate });
    }
    if (!(await customerFor(ctx, data.customerPhone))) {
      const message = `No customer with phone ${tenDigits(data.customerPhone)} — bring in customers first.`;
      return { status: 'error', label, errors: [{ column: 'Customer phone', message }] };
    }
    const existing = await findOrderByLegacyRef(ctx.branchId, data.legacyRef);
    return { status: existing ? 'exists' : 'ready', label };
  },
  async commit(rows, ctx, actor) {
    const first = rows[0].data;
    const customer = await customerFor(ctx, first.customerPhone);
    if (!customer) return { status: 'failed', entityId: null, errors: [{ column: 'Customer phone', message: 'This customer is no longer in the system.' }] };
    try {
      const { order } = await importOrder(
        ctx.branchId,
        {
          legacyRef: first.legacyRef,
          customerId: String(customer._id),
          designerId: first.designerId,
          priority: first.priority,
          orderDate: first.orderDate,
          pickupDate: first.pickupDate,
          garments: rows.map((r) => ({ ...r.data.garment, stage: r.data.stage })),
        },
        actor,
      );
      return { status: 'added', entityId: order._id };
    } catch (err) {
      if (err?.code === 'ORDER_EXISTS') return { status: 'skipped', entityId: null };
      throw err;
    }
  },
});

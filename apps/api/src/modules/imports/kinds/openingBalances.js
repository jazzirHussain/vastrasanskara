import { hasOpeningBalance, recordOpeningBalance } from '../../billing/service.js';
import { findCustomerByPhone } from '../../customers/service.js';
import { findOrderByLegacyRef } from '../../orders/service.js';
import { registerImportKind } from './index.js';

const tenDigits = (e164) => String(e164).replace(/^\+91/, '');

async function lookups(ctx, data) {
  const customer = await findCustomerByPhone(ctx.branchId, data.customerPhone);
  const order = customer && data.legacyRef ? await findOrderByLegacyRef(ctx.branchId, data.legacyRef) : null;
  return { customer, order };
}

// Opening balances as of the run's cut-over date, through the billing service (outside GST).
registerImportKind('opening_balances', {
  context: async (branchId, run) => ({ asOf: run.asOf }),
  async check({ data }, ctx) {
    const { customer, order } = await lookups(ctx, data);
    const label = customer?.name ?? tenDigits(data.customerPhone);
    if (!customer) {
      return { status: 'error', label, errors: [{ column: 'Customer phone', message: `No customer with phone ${tenDigits(data.customerPhone)} — bring in customers first.` }] };
    }
    if (data.legacyRef && (!order || String(order.customerId) !== String(customer._id))) {
      return { status: 'error', label, errors: [{ column: 'Old order no.', message: `No open order ${data.legacyRef} for this customer — bring in open orders first.` }] };
    }
    return { status: (await hasOpeningBalance(ctx.branchId, customer._id)) ? 'exists' : 'ready', label };
  },
  async commit([row], ctx, actor) {
    const { customer, order } = await lookups(ctx, row.data);
    if (!customer) return { status: 'failed', entityId: null, errors: [{ column: 'Customer phone', message: 'This customer is no longer in the system.' }] };
    if (await hasOpeningBalance(ctx.branchId, customer._id)) return { status: 'skipped', entityId: null };
    try {
      const { openingBalance, receipt } = await recordOpeningBalance(
        ctx.branchId,
        {
          customerId: String(customer._id),
          owed: row.data.owed,
          advance: row.data.advance,
          asOf: ctx.asOf,
          note: row.data.note,
          orderId: order ? String(order._id) : null,
          legacyRef: row.data.legacyRef,
        },
        actor,
      );
      return { status: 'added', entityId: (openingBalance ?? receipt)._id };
    } catch (err) {
      if (err?.code === 'OPENING_EXISTS') return { status: 'skipped', entityId: null };
      throw err;
    }
  },
});

import { expect } from 'vitest';
import { addDaysYmd } from '@vs/shared';
import { Branch } from '../../src/modules/branches/model.js';
import { loginAs } from './app.js';
import { productionHelpers, today } from './production.js';

let keys = 0;
export const CLOTHING_SLABS = [{ upToUnitPrice: 100000, rateBp: 500 }, { upToUnitPrice: null, rateBp: 1200 }];

/**
 * Billing test helpers for `app`. `world()` is the production world plus an admin, the branch's
 * GSTIN and a small price list; `draftFor(order)` opens the order's draft bill; `issue` and
 * `pay` call the issue and payment routes and answer the raw response.
 */
export function billingHelpers(app) {
  const production = productionHelpers(app);
  let current = null;

  async function world() {
    const base = await production.world();
    current = base.ops;
    const admin = await loginAs(app, { roles: ['admin'] });
    await Branch.updateOne({}, { gstin: '29ABCDE1234F1Z5', stateCode: '29' });
    const addItem = async (body) => {
      const r = await admin.agent.post('/v1/catalog/items').send(body);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body;
    };
    const items = {
      blouse: await addItem({
        name: 'Blouse', kind: 'garment', supplyType: 'goods', hsnSac: '6206', gstSlabs: CLOTHING_SLABS, garmentTypes: ['blouse'],
      }),
      stitching: await addItem({
        name: 'Stitching', kind: 'stitching_service', supplyType: 'service', hsnSac: '998821', gstSlabs: [{ upToUnitPrice: null, rateBp: 500 }],
      }),
      alteration: await addItem({
        name: 'Alteration', kind: 'extra_charge', supplyType: 'service', hsnSac: '998821', defaultPrice: 20000,
        gstSlabs: [{ upToUnitPrice: null, rateBp: 1800 }], chargeFor: 'alteration',
      }),
      rework: await addItem({
        name: 'Rework', kind: 'extra_charge', supplyType: 'service', hsnSac: '998821', defaultPrice: 30000,
        gstSlabs: [{ upToUnitPrice: null, rateBp: 1800 }], chargeFor: 'rework',
      }),
    };
    /** Takes an order of one blouse line per price (agreed prices in paise). */
    const takeOrder = async ({ prices = [450000], priority = 'normal', designer = base.d1 } = {}) =>
      (await base.ops.agent.post('/v1/orders').set('Idempotency-Key', `b${++keys}`).send({
        customerId: base.customerId, designerId: String(designer.user._id), pickupDate: addDaysYmd(today(), 40), priority,
        garments: prices.map((agreedPrice) => ({ type: 'blouse', description: 'Blouse', agreedPrice, quantity: 1 })),
      })).body;
    return { ...base, admin, items, addItem, takeOrder };
  }

  /** The order's draft bill (created or reopened) by operations unless `who` is given, as the API answers. */
  async function draftFor(order, who = current) {
    const r = await who.agent.post('/v1/billing/invoices/from-order').send({ orderId: order.id });
    expect([200, 201], JSON.stringify(r.body)).toContain(r.status);
    return r.body.invoice;
  }

  const issue = (who, invoice) =>
    who.agent.post(`/v1/billing/invoices/${invoice.id}/issue`).set('Idempotency-Key', `i${++keys}`).send({ version: invoice.version });
  const pay = (who, body) => who.agent.post('/v1/billing/payments').set('Idempotency-Key', `p${++keys}`).send(body);

  return { ...production, world, draftFor, issue, pay };
}

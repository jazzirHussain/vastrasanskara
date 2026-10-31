import { expect } from 'vitest';
import mongoose from 'mongoose';
import { avgCostOf } from '@vs/shared/stock.js';
import { StockItem, StockMovement } from '../../src/modules/stock/model.js';
import { loginAs } from './app.js';

let keys = 0;

/** The smallest valid "add stock item" body: red silk by the metre, bought by the metre. */
export const itemBody = (fields = {}) => ({
  name: 'Red silk',
  usageUnit: 'm',
  purchaseUnit: 'm',
  factor: 1000,
  ...fields,
});

/**
 * Stock test helpers for `app`. `world()` makes an admin, operations and a designer and adds a
 * vendor; `item(agent, fields)` posts a stock item (fields over `itemBody`) with an Idempotency-Key
 * and answers the item JSON; `balancesFromMovements(itemId)` sums the item's movement changes;
 * `expectBalanced(itemId)` checks the cached balance equals that sum.
 */
export function stockHelpers(app) {
  async function world() {
    const admin = await loginAs(app, { roles: ['admin'] });
    const ops = await loginAs(app, { roles: ['operations'] });
    const designer = await loginAs(app, { roles: ['designer'] });
    const r = await admin.agent.post('/v1/vendors').send({ name: 'Bengaluru Silks', stateCode: '29' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { admin, ops, designer, vendor: r.body, branchId: String(admin.user.branchId) };
  }

  async function item(who, fields = {}) {
    const r = await who.agent.post('/v1/stock/items').set('Idempotency-Key', `s${++keys}`).send(itemBody(fields));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.item;
  }

  async function balancesFromMovements(itemId) {
    const [sum] = await StockMovement.aggregate([
      { $match: { stockItemId: new mongoose.Types.ObjectId(String(itemId)) } },
      {
        $group: {
          _id: null,
          onHand: { $sum: '$onHandChange' },
          reserved: { $sum: '$reservedChange' },
          value: { $sum: '$valueChange' },
        },
      },
    ]);
    return { onHand: sum?.onHand ?? 0, reserved: sum?.reserved ?? 0, value: sum?.value ?? 0 };
  }

  async function expectBalanced(itemId) {
    const cached = await StockItem.findById(itemId).lean();
    const summed = await balancesFromMovements(itemId);
    expect({ onHand: cached.onHand, reserved: cached.reserved, value: cached.value }).toEqual(summed);
    expect(cached.avgCost).toBe(avgCostOf(cached));
    return cached;
  }

  return { world, item, balancesFromMovements, expectBalanced };
}

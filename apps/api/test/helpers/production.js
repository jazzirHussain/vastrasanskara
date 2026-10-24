import { expect } from 'vitest';
import { addDaysYmd, istDate, workingStage, QC_STAGES } from '@vs/shared';
import { clock } from '../../src/clock.js';
import { loginAs } from './app.js';

let keys = 0;
export const today = () => istDate(clock.now());

/**
 * Production test helpers for `app`: `world()` makes operations, two designers (Meera, Nila),
 * a customer, a worker and a vendor, and `take()` takes an order for them.
 */
export function productionHelpers(app) {
  async function world() {
    const ops = await loginAs(app, { roles: ['operations'] });
    const d1 = await loginAs(app, { roles: ['designer'], name: 'Meera' });
    const d2 = await loginAs(app, { roles: ['designer'], name: 'Nila' });
    const customerId = (await ops.agent.post('/v1/customers').send({ name: 'Asha Rao', phone: '9876543210' })).body.id;
    const worker = (await ops.agent.post('/v1/workers').send({ name: 'Ravi' })).body;
    const vendor = (await ops.agent.post('/v1/vendors').send({ name: 'Zari works' })).body;
    const take = async ({ designer = d1, quantity = 1, days = 40, customer = customerId } = {}) =>
      (await ops.agent.post('/v1/orders').set('Idempotency-Key', `p${++keys}`).send({
        customerId: customer, designerId: String(designer.user._id), pickupDate: addDaysYmd(today(), days),
        garments: [{ type: 'blouse', description: 'Blouse', agreedPrice: 450000, quantity }],
      })).body;
    return { ops, d1, d2, customerId, worker, vendor, take };
  }

  const send = (who, garments, body) =>
    who.agent.post('/v1/production/actions').send({
      stage: workingStage(garments[0]),
      garments: garments.map((g) => ({ id: g.id, version: g.version })),
      ...body,
    });

  /** Acts on one garment and returns it as the API answers (fails the test on an error). */
  async function act(who, garment, body) {
    const r = await send(who, [garment], body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.garments[0];
  }

  /** Completes (or passes QC on) stages until the garment works on `stage`. */
  async function advanceTo(who, garment, stage) {
    let g = garment;
    while (workingStage(g) !== stage) {
      g = await act(who, g, { action: QC_STAGES.includes(workingStage(g)) ? 'qc_pass' : 'complete' });
    }
    return g;
  }

  /** Takes the garment all the way to Ready for pickup. */
  const makeReady = async (who, garment) => act(who, await advanceTo(who, garment, 'packaging'), { action: 'complete' });

  const history = async (who, garment) => (await who.agent.get(`/v1/production/garments/${garment.id}/events`)).body.items;

  return { world, send, act, advanceTo, makeReady, history };
}

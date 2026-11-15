import { expect, vi } from 'vitest';
import { addDaysYmd, atIstTime } from '@vs/shared';
import { clock } from '../../src/clock.js';
import { Branch } from '../../src/modules/branches/model.js';
import { Garment, Order } from '../../src/modules/orders/model.js';
import { billingHelpers } from './billing.js';
import { today } from './production.js';
import { stockHelpers } from './stock.js';
import { enquiryBody } from './frontOffice.js';

let keys = 0;
const ok = (r, status = 201) => expect(r.status, JSON.stringify(r.body)).toBe(status);
const noon = (ymd) => vi.spyOn(clock, 'now').mockReturnValue(new Date(`${ymd}T06:30:00.000Z`));

/**
 * Dashboard test helpers for `app`. `dashboardWorld()` builds one branch with everything the
 * Home tiles read, through the API and the existing billing, production and stock helpers:
 *  - users: admin, ops, designers d1 (Meera) and d2 (Nila); customers Asha (individual),
 *    Sri Silks (business) and Film Co (film_production);
 *  - d1: a late garment (and the vendor garment, late or not by its plan), a pickup at risk (pickup in 2 days), a garment with the vendor past its
 *    due-back date, a garment ready on time, an order on hold, a bill overdue since day −10 and a
 *    bill part paid today, a fitting today; one order placed on the 1st of last month (its garment and
 *    the overdue bill's are picked up);
 *  - d2: a business order whose garment failed QC today, a film order whose garment became ready
 *    after its original due date;
 *  - a low stock item and an enquiry due a call today.
 * Returns the logins, ids and the documents the tests check against.
 */
export function dashboardHelpers(app) {
  const billing = billingHelpers(app);
  const stock = stockHelpers(app);

  async function dashboardWorld() {
    const w = await billing.world();
    const branchId = String((await Branch.findOne().lean())._id);
    const TODAY = today();
    const ago = (n) => addDaysYmd(TODAY, -n);
    const customer = async (body) => {
      const r = await w.ops.agent.post('/v1/customers').send(body);
      ok(r);
      return r.body.id;
    };
    const biz = await customer({ name: 'Sri Silks', phone: '9876500001', type: 'business' });
    const film = await customer({ name: 'Film Co', phone: '9876500002', type: 'film_production' });
    const order = (designer, extra = {}) =>
      w.ops.agent.post('/v1/orders').set('Idempotency-Key', `dw${++keys}`).send({
        customerId: w.customerId, designerId: String(designer.user._id), pickupDate: addDaysYmd(today(), 40),
        garments: [{ type: 'blouse', description: 'Blouse', agreedPrice: 100000, quantity: 1 }], ...extra,
      }).then((r) => {
        ok(r);
        return r.body;
      });

    // Last month (the comparison period of "this month").
    const lastMonthFirst = `${addDaysYmd(`${TODAY.slice(0, 7)}-01`, -1).slice(0, 7)}-01`;
    noon(lastMonthFirst);
    const lastMonth = await order(w.d1);
    // The vendor garment: sent six days ago, due back two days ago.
    noon(ago(6));
    const vendorOrder = await order(w.d1);
    const atHandwork = await billing.advanceTo(w.d1, vendorOrder.garments[0], 'handwork');
    await billing.act(w.d1, atHandwork, { action: 'sent_to_vendor', vendorId: w.vendor.id, dueBackDate: ago(2) });
    // A bill dated ten days ago (due the same day), unpaid.
    noon(ago(10));
    const overdueOrder = await order(w.d1);
    const overdueBill = (await billing.issue(w.ops, await billing.draftFor(overdueOrder))).body.invoice;
    vi.restoreAllMocks();
    // Their stage plans are long past: picked up, so they stay out of the open-garment tiles.
    await Garment.updateMany({ _id: { $in: [lastMonth.garments[0].id, overdueOrder.garments[0].id] } }, { status: 'picked_up' });

    const late = await order(w.d1);
    await Garment.updateOne({ _id: late.garments[0].id }, { dueDate: ago(2) });
    const atRisk = await order(w.d1);
    await Order.updateOne({ _id: atRisk.id }, { pickupDate: addDaysYmd(TODAY, 2) });
    await Garment.updateOne({ _id: atRisk.garments[0].id }, { dueDate: addDaysYmd(TODAY, 2) });
    const ready = await order(w.d1);
    await billing.makeReady(w.d1, ready.garments[0]);
    const held = await order(w.d1);
    await Order.updateOne({ _id: held.id }, { status: 'on_hold' });
    const paidPart = await order(w.d1);
    const partBill = (await billing.issue(w.ops, await billing.draftFor(paidPart))).body.invoice;
    ok(await billing.pay(w.ops, { customerId: w.customerId, invoiceId: partBill.id, amount: 10000, mode: 'cash' }));

    const qc = await order(w.d2, { customerId: biz });
    const atQc = await billing.advanceTo(w.d2, qc.garments[0], 'quality_check');
    await billing.act(w.d2, atQc, { action: 'qc_fail', reworkStage: 'handwork', remarks: 'Loose beads' });
    const lateReady = await order(w.d2, { customerId: film });
    await billing.makeReady(w.d2, lateReady.garments[0]);
    await Garment.updateOne({ _id: lateReady.garments[0].id }, { originalDueDate: ago(1) });

    // A fitting today at 11:00 with d1, booked at 09:00.
    vi.spyOn(clock, 'now').mockReturnValue(new Date(atIstTime(TODAY, '09:00')));
    ok(await w.ops.agent.post('/v1/appointments').set('Idempotency-Key', `dwa${++keys}`).send({
      type: 'fitting', designerId: String(w.d1.user._id), customerId: w.customerId, date: TODAY, time: '11:00',
    }));
    vi.restoreAllMocks();

    const lowItem = await stock.item(w.ops, { name: 'Red silk', reorderLevel: 5000, opening: { quantity: 1000, unitCost: 25000 } });
    ok(await w.ops.agent.post('/v1/enquiries').set('Idempotency-Key', `dwe${++keys}`).send(enquiryBody({ followUpDate: TODAY })));

    return {
      ...w, branchId, TODAY, ago, biz, film,
      orders: { lastMonth, vendorOrder, overdueOrder, late, atRisk, ready, held, paidPart, qc, lateReady },
      bills: { overdueBill, partBill },
      lowItem,
    };
  }

  return { ...billing, dashboardWorld };
}

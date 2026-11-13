import { test, expect, vi, afterEach } from 'vitest';
import { addDaysYmd } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { frontOfficeHelpers } from './helpers/frontOffice.js';
import { today } from './helpers/production.js';
import { Customer } from '../src/modules/customers/model.js';
import { Order } from '../src/modules/orders/model.js';
import { Enquiry } from '../src/modules/enquiries/model.js';

useTestDb();
const app = buildTestApp();
const { world, addEnquiry } = frontOfficeHelpers(app);

afterEach(() => vi.restoreAllMocks());

const ok = (r, status = 200) => expect(r.status, JSON.stringify(r.body)).toBe(status);
let keys = 0;
const convert = (who, e, body = {}) => who.agent.post(`/v1/enquiries/${e.id}/convert`).send({ version: e.version, ...body });
const takeOrder = (who, { customerId, designerId, enquiryId, pickupDate = addDaysYmd(today(), 40) }) =>
  who.agent
    .post('/v1/orders')
    .set('Idempotency-Key', `o${++keys}`)
    .send({
      customerId,
      designerId,
      pickupDate,
      enquiryId,
      garments: [{ type: 'lehenga', description: 'Bridal lehenga', agreedPrice: 9000000 }],
    });

test('converting finds the customer by phone', async () => {
  const { ops, customer } = await world();
  const e = (await addEnquiry(ops, { name: 'Asha', phone: '98765 43210' })).body.enquiry;
  const r = await convert(ops, e);
  ok(r);
  expect(r.body.matched).toBe(true);
  expect(r.body.customer).toMatchObject({ id: customer.id, name: 'Asha Rao' });
  expect(r.body.enquiry).toMatchObject({
    status: 'new',
    isOpen: true,
    convertedCustomer: { id: customer.id, name: 'Asha Rao', phone: '+919876543210' },
    convertedOrder: null,
    version: 1,
  });
  expect(r.body.enquiry.log.at(-1)).toMatchObject({ kind: 'status', text: 'Customer ready' });
  expect(await Customer.countDocuments()).toBe(1);
});

test('converting creates a customer from the enquiry', async () => {
  const { ops } = await world();
  const e = (await addEnquiry(ops, { source: 'instagram' })).body.enquiry;
  const r = await convert(ops, e);
  ok(r);
  expect(r.body.matched).toBe(false);
  expect(r.body.customer).toMatchObject({
    name: 'Priya Sharma',
    phone: '+919845012345',
    source: 'instagram',
    stateCode: '29',
    consent: { email: false, whatsapp: false, sms: false },
  });
  expect(r.body.enquiry.convertedCustomer.id).toBe(r.body.customer.id);
  expect(await Customer.countDocuments()).toBe(2);
});

test('staff can pick a different customer', async () => {
  const { ops, customer } = await world();
  const e = (await addEnquiry(ops)).body.enquiry;
  const r = await convert(ops, e, { customerId: customer.id });
  ok(r);
  expect(r.body).toMatchObject({ matched: false, customer: { id: customer.id } });
  expect(await Customer.countDocuments()).toBe(1);
  const missing = await convert(ops, r.body.enquiry, { customerId: '0123456789abcdef01234567' });
  expect(missing.status).toBe(400);
  expect(missing.body.error.details).toEqual([{ path: 'customerId', message: 'Not found' }]);
});

test('converting twice gives the same customer', async () => {
  const { ops } = await world();
  const e = (await addEnquiry(ops)).body.enquiry;
  const first = await convert(ops, e);
  const second = await convert(ops, first.body.enquiry);
  ok(second);
  expect(second.body.customer.id).toBe(first.body.customer.id);
  expect(await Customer.countDocuments()).toBe(2);
});

test('a lost or converted enquiry cannot be converted', async () => {
  const { ops, d1 } = await world();
  const e = (await addEnquiry(ops)).body.enquiry;
  const lost = (await ops.agent.post(`/v1/enquiries/${e.id}/lost`).send({ version: 0, reason: 'Other' })).body.enquiry;
  const r = await convert(ops, lost);
  expect(r.status).toBe(422);
  expect(r.body.error.code).toBe('ENQUIRY_CLOSED');

  const e2 = (await addEnquiry(ops, { phone: '9845000030' })).body.enquiry;
  const ready = (await convert(ops, e2)).body;
  ok(await takeOrder(ops, { customerId: ready.customer.id, designerId: String(d1.user._id), enquiryId: e2.id }), 201);
  const again = await convert(ops, { id: e2.id, version: (await Enquiry.findById(e2.id).lean()).__v });
  expect(again.status).toBe(422);
  expect(again.body.error.code).toBe('ENQUIRY_CLOSED');
});

test('the order taken from an enquiry marks it converted', async () => {
  const { ops, d1 } = await world();
  const e = (await addEnquiry(ops, { followUpDate: today() })).body.enquiry;
  const ready = (await convert(ops, e)).body;
  const r = await takeOrder(ops, { customerId: ready.customer.id, designerId: String(d1.user._id), enquiryId: e.id });
  ok(r, 201);
  const got = (await ops.agent.get(`/v1/enquiries/${e.id}`)).body.enquiry;
  expect(got).toMatchObject({
    status: 'converted',
    isOpen: false,
    followUpDate: null,
    convertedOrder: { id: r.body.id, orderNo: r.body.orderNo },
    convertedCustomer: { id: ready.customer.id, name: 'Priya Sharma' },
  });
  expect(got.log.at(-1)).toMatchObject({ kind: 'status', text: `Order ${r.body.orderNo}` });
  expect((await ops.agent.get('/v1/enquiries/follow-ups/count')).body.count).toBe(0);
  expect((await Order.findById(r.body.id).lean()).enquiryId).toBeUndefined();
});

test('an order that fails leaves the enquiry open', async () => {
  const { ops, d1 } = await world();
  const e = (await addEnquiry(ops)).body.enquiry;
  const ready = (await convert(ops, e)).body;
  const r = await takeOrder(ops, {
    customerId: ready.customer.id,
    designerId: String(d1.user._id),
    enquiryId: e.id,
    pickupDate: addDaysYmd(today(), -1),
  });
  expect(r.status).toBe(422);
  const after = await Enquiry.findById(e.id).lean();
  expect(after).toMatchObject({ status: 'new', isOpen: true, convertedOrderId: null });
  expect(after.__v).toBe(ready.enquiry.version);
  const missing = await takeOrder(ops, { customerId: ready.customer.id, designerId: String(d1.user._id), enquiryId: '0123456789abcdef01234567' });
  expect(missing.status).toBe(400);
  expect(missing.body.error.details).toEqual([{ path: 'enquiryId', message: 'Not found' }]);
  expect(await Order.countDocuments()).toBe(0);
});

test('an order for another customer than the converted one is refused', async () => {
  const { ops, d1, customer } = await world();
  const e = (await addEnquiry(ops)).body.enquiry;
  await convert(ops, e);
  const r = await takeOrder(ops, { customerId: customer.id, designerId: String(d1.user._id), enquiryId: e.id });
  expect(r.status).toBe(422);
  expect(r.body.error).toMatchObject({ code: 'ENQUIRY_CUSTOMER_MISMATCH', message: 'This enquiry was converted for a different customer' });
  const next = await takeOrder(ops, { customerId: customer.id, designerId: String(d1.user._id), enquiryId: null });
  ok(next, 201);
  expect(next.body.orderNo).toMatch(/\/0001$/);
});

test('an enquiry without a customer yet is converted by the order', async () => {
  const { ops, d1, customer } = await world();
  const e = (await addEnquiry(ops)).body.enquiry;
  ok(await takeOrder(ops, { customerId: customer.id, designerId: String(d1.user._id), enquiryId: e.id }), 201);
  expect(await Enquiry.findById(e.id).lean()).toMatchObject({ status: 'converted', convertedCustomerId: expect.anything() });
  expect(String((await Enquiry.findById(e.id).lean()).convertedCustomerId)).toBe(customer.id);
});

test('a converted enquiry frees the phone for a new enquiry', async () => {
  const { ops, d1 } = await world();
  const e = (await addEnquiry(ops)).body.enquiry;
  const ready = (await convert(ops, e)).body;
  ok(await takeOrder(ops, { customerId: ready.customer.id, designerId: String(d1.user._id), enquiryId: e.id }), 201);
  const again = await addEnquiry(ops, { name: 'Priya Sharma' });
  ok(again, 201);
  const check = await ops.agent.get('/v1/enquiries/check-phone').query({ phone: '9845012345' });
  expect(check.body).toEqual({
    customer: { id: ready.customer.id, name: 'Priya Sharma' },
    openEnquiry: { id: again.body.enquiry.id, name: 'Priya Sharma', status: 'new' },
  });
});

test('converting when the phone is saved as a customer at the same moment finds that customer', async () => {
  const { ops, customer } = await world();
  const e = (await addEnquiry(ops, { name: 'Asha', phone: '98765 43210' })).body.enquiry;
  // The first reads of the phone miss (the customer was committed just after), so the insert hits
  // the unique index; the retry finds the customer.
  const real = Customer.findOne.bind(Customer);
  let misses = 2;
  vi.spyOn(Customer, 'findOne').mockImplementation((filter, ...rest) => {
    if (filter?.phone && misses > 0) {
      misses -= 1;
      return { session: () => ({ lean: async () => null }) };
    }
    return real(filter, ...rest);
  });
  const r = await convert(ops, e);
  ok(r);
  expect(r.body.matched).toBe(true);
  expect(r.body.customer.id).toBe(customer.id);
  expect(await Customer.countDocuments({ phone: customer.phone })).toBe(1);
});

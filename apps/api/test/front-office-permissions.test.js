import { test, expect, vi, afterEach, beforeEach } from 'vitest';
import { can } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { frontOfficeHelpers } from './helpers/frontOffice.js';
import { Outbox } from '../src/core/notify/models.js';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../src/core/errors.js';
import { ordersRouter } from '../src/modules/orders/routes.js';
import { enquiriesRouter } from '../src/modules/enquiries/routes.js';
import { appointmentsRouter } from '../src/modules/appointments/routes.js';
import { enquiryConversionBySource } from '../src/modules/enquiries/service.js';

useTestDb();
const app = buildTestApp();
const { world, addEnquiry, book, atIst } = frontOfficeHelpers(app);

const D = '2026-12-01';
beforeEach(() => atIst(D, '09:00'));
afterEach(() => vi.restoreAllMocks());

const ID = '0123456789abcdef01234567';
const ENQ = 'enquiries.write';
const WRITE = 'appointments.write';
const OWN = 'appointments.own';

// Every front-office route and the permission it needs (asserted equal to the routers below).
const ROUTES = [
  ['GET', '/v1/enquiries', ENQ],
  ['GET', '/v1/enquiries/check-phone', ENQ],
  ['GET', '/v1/enquiries/follow-ups/count', ENQ],
  ['POST', '/v1/enquiries', ENQ],
  ['GET', '/v1/enquiries/:id', ENQ],
  ['PATCH', '/v1/enquiries/:id', ENQ],
  ['POST', '/v1/enquiries/:id/call', ENQ],
  ['POST', '/v1/enquiries/:id/lost', ENQ],
  ['POST', '/v1/enquiries/:id/reopen', ENQ],
  ['POST', '/v1/enquiries/:id/convert', ENQ],
  ['POST', '/v1/appointments', WRITE],
  ['GET', '/v1/appointments/day', OWN],
  ['GET', '/v1/appointments', OWN],
  ['GET', '/v1/appointments/:id', OWN],
  ['PATCH', '/v1/appointments/:id', WRITE],
  ['POST', '/v1/appointments/:id/cancel', WRITE],
  ['POST', '/v1/appointments/:id/mark', OWN],
];

function declared(prefix, router) {
  return router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) =>
      Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} ${prefix}${layer.route.path === '/' ? '' : layer.route.path}`),
    );
}

const call = (who, method, path) => {
  const req = who.agent[method.toLowerCase()](path.replace(':id', ID));
  if (method === 'GET') return req;
  return req.set('Idempotency-Key', `perm-${Math.random().toString(36).slice(2)}`).send({});
};
const ok = (r, status = 200) => expect(r.status, JSON.stringify(r.body)).toBe(status);

/** Every key anywhere in a JSON value. */
const keysOf = (value, out = new Set()) => {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  }
  return out;
};

test('the permission table covers every enquiry and appointment route', () => {
  const real = [...declared('/v1/enquiries', enquiriesRouter()), ...declared('/v1/appointments', appointmentsRouter())].sort();
  expect(ROUTES.map(([m, p]) => `${m} ${p}`).sort()).toEqual(real);
  for (const [, , permission] of ROUTES) {
    expect(can(['admin'], permission)).toBe(true);
    expect(can(['operations'], permission)).toBe(true);
    expect(can(['designer'], permission)).toBe(permission === OWN);
  }
});

test('designers are refused every enquiry route', async () => {
  const { d1 } = await world();
  for (const [method, path] of ROUTES.filter(([, p]) => p.startsWith('/v1/enquiries'))) {
    const r = await call(d1, method, path);
    expect([r.status, r.body.error?.code], `${method} ${path}`).toEqual([403, 'FORBIDDEN']);
  }
});

test('designers are refused booking, moving and cancelling', async () => {
  const { d1 } = await world();
  for (const [method, path] of ROUTES.filter(([, , p]) => p === WRITE)) {
    const r = await call(d1, method, path);
    expect([r.status, r.body.error?.code], `${method} ${path}`).toEqual([403, 'FORBIDDEN']);
  }
});

test('designers see only their own appointments', async () => {
  const { ops, d1, d2, customer } = await world();
  const at = (designer, time) =>
    book(ops, { type: 'consultation', designerId: String(designer.user._id), customerId: customer.id, date: D, time });
  const mine = (await at(d1, '11:00')).body.appointment;
  const theirs = (await at(d2, '11:00')).body.appointment;
  expect((await d1.agent.get(`/v1/appointments/${theirs.id}`)).status).toBe(404);
  ok(await d1.agent.get(`/v1/appointments/${mine.id}`));
  const day = await d1.agent.get('/v1/appointments/day').query({ date: D, designerId: String(d2.user._id) });
  expect(day.body.designers.map((d) => d.id)).toEqual([String(d1.user._id)]);
  const list = await d1.agent.get('/v1/appointments');
  expect(list.body.items.map((a) => a.id)).toEqual([mine.id]);
  const byCustomer = await d1.agent.get('/v1/appointments').query({ customerId: customer.id });
  expect(byCustomer.body.items.map((a) => a.id)).toEqual([mine.id]);
});

test('operations and admins are allowed every front-office route', async () => {
  const { ops, admin } = await world();
  for (const who of [ops, admin]) {
    for (const [method, path] of ROUTES) {
      const r = await call(who, method, path);
      expect(r.status, `${method} ${path}`).not.toBe(403);
    }
  }
});

test('no appointment response carries a budget', async () => {
  const { ops, admin, d1, customer } = await world();
  const e = (await addEnquiry(ops, { budget: 15000000 })).body.enquiry;
  const base = { type: 'consultation', designerId: String(d1.user._id), date: D };
  const forEnquiry = await book(ops, { ...base, enquiryId: e.id, time: '11:00' });
  const forCustomer = await book(ops, { ...base, customerId: customer.id, time: '12:00' });
  const a = forEnquiry.body.appointment;
  const responses = [
    forEnquiry,
    forCustomer,
    await ops.agent.patch(`/v1/appointments/${a.id}`).send({ version: 0, note: 'x' }),
  ];
  for (const who of [ops, admin, d1]) {
    responses.push(await who.agent.get(`/v1/appointments/${a.id}`));
    responses.push(await who.agent.get('/v1/appointments/day').query({ date: D }));
    responses.push(await who.agent.get('/v1/appointments'));
  }
  responses.push(await d1.agent.post(`/v1/appointments/${a.id}/mark`).send({ version: 1, status: 'completed' }));
  for (const r of responses) {
    ok(r, r.status === 201 ? 201 : 200);
    const keys = keysOf(r.body);
    for (const money of ['budget', 'price', 'amount', 'agreedPrice', 'total']) expect(keys.has(money), money).toBe(false);
  }
});

test('an enquiry from phone call to order', async () => {
  const { ops, d1, branchId } = await world();
  // Phone call.
  const e = (await addEnquiry(ops, { garmentTypes: ['lehenga'], source: 'instagram', followUpDate: D })).body.enquiry;
  const called = await ops.agent.post(`/v1/enquiries/${e.id}/call`).send({ version: 0, note: 'Wants a trial', followUpDate: null });
  ok(called);
  // Consultation at 11:00 with Meera.
  const booked = await book(ops, { type: 'consultation', designerId: String(d1.user._id), enquiryId: e.id, date: D, time: '11:00' });
  ok(booked, 201);
  const consult = booked.body.appointment;
  expect((await ops.agent.get(`/v1/enquiries/${e.id}`)).body.enquiry.status).toBe('appointment_booked');
  expect(await Outbox.countDocuments({ event: 'appointment.booked.designer', 'recipient.id': String(d1.user._id) })).toBe(2);
  // She comes; Meera marks it done.
  atIst(D, '12:05');
  ok(await d1.agent.post(`/v1/appointments/${consult.id}/mark`).send({ version: 0, status: 'completed' }));
  // Convert: a new customer from the enquiry.
  const version = (await ops.agent.get(`/v1/enquiries/${e.id}`)).body.enquiry.version;
  const converted = await ops.agent.post(`/v1/enquiries/${e.id}/convert`).send({ version });
  ok(converted);
  expect(converted.body.matched).toBe(false);
  const customerId = converted.body.customer.id;
  // The order.
  const order = await ops.agent.post('/v1/orders').set('Idempotency-Key', 'journey').send({
    customerId,
    designerId: String(d1.user._id),
    pickupDate: '2027-02-01',
    enquiryId: e.id,
    garments: [{ type: 'lehenga', description: 'Bridal lehenga', agreedPrice: 15000000 }],
  });
  ok(order, 201);
  const after = (await ops.agent.get(`/v1/enquiries/${e.id}`)).body.enquiry;
  expect(after).toMatchObject({ status: 'converted', convertedOrder: { id: order.body.id, orderNo: order.body.orderNo } });
  expect((await ops.agent.get('/v1/enquiries').query({ view: 'follow_ups' })).body.items).toEqual([]);
  const theirs = await ops.agent.get('/v1/appointments').query({ customerId });
  expect(theirs.body.items.map((a) => [a.id, a.status])).toEqual([[consult.id, 'completed']]);
  expect(await enquiryConversionBySource(branchId, { from: D, to: D })).toEqual([
    { source: 'instagram', total: 1, converted: 1, lost: 0, open: 0 },
  ]);
});

test("designers never see an enquiry's phone; front desk does", async () => {
  const { ops, d1 } = await world();
  const e = (await addEnquiry(ops, { phone: '98450 12345' })).body.enquiry;
  const booked = await book(ops, { type: 'consultation', designerId: String(d1.user._id), enquiryId: e.id, date: D, time: '11:00' });
  ok(booked, 201);
  const a = booked.body.appointment;
  expect(a.enquiry.phone).toBeTruthy();
  const forDesigner = [
    await d1.agent.get(`/v1/appointments/${a.id}`),
    await d1.agent.get('/v1/appointments/day').query({ date: D }),
    await d1.agent.get('/v1/appointments'),
  ];
  for (const r of forDesigner) {
    ok(r);
    expect(JSON.stringify(r.body)).not.toContain('9845012345');
    expect(JSON.stringify(r.body)).not.toContain('98450 12345');
    expect(keysOf(r.body).has('phone')).toBe(false);
  }
  expect(forDesigner[0].body.appointment.enquiry).toEqual({ id: e.id, name: 'Priya Sharma' });
  const desk = [await ops.agent.get(`/v1/appointments/${a.id}`), await ops.agent.get('/v1/appointments')];
  expect(desk[0].body.appointment.enquiry.phone).toBeTruthy();
  expect(desk[1].body.items[0].enquiry.phone).toBeTruthy();
});

// A user who holds only some permissions (no role does) reaches each route; a refusal is 403 before
// any work, so no database is needed.
async function asPermissions(permissions, router, method, path, body = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: ID, branchId: ID, permissions: new Set(permissions) };
    next();
  });
  app.use('/v1', router);
  app.use(errorHandler);
  return request(app)[method](`/v1${path}`).send(body);
}

test('converting an enquiry also needs customers.write', async () => {
  const path = `/${ID}/convert`;
  const r = await asPermissions([ENQ], enquiriesRouter(), 'post', path, { version: 0 });
  expect([r.status, r.body.error?.code]).toEqual([403, 'FORBIDDEN']);
  const customersOnly = await asPermissions(['customers.write'], enquiriesRouter(), 'post', path, { version: 0 });
  expect(customersOnly.status).toBe(403);
  expect(can(['operations'], 'customers.write')).toBe(true);
});

test('an order for an enquiry also needs enquiries.write', async () => {
  const withEnquiry = { enquiryId: ID };
  const refused = await asPermissions(['orders.write'], ordersRouter(), 'post', '/', withEnquiry);
  expect([refused.status, refused.body.error?.code]).toEqual([403, 'FORBIDDEN']);
  // Without an enquiry, orders.write alone gets past the permission check (to validation).
  const plain = await asPermissions(['orders.write'], ordersRouter(), 'post', '/', {});
  expect(plain.status).not.toBe(403);
  const both = await asPermissions(['orders.write', ENQ], ordersRouter(), 'post', '/', withEnquiry);
  expect(both.status).not.toBe(403);
});

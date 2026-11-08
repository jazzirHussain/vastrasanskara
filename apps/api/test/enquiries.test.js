import { test, expect, vi, afterEach } from 'vitest';
import { addDaysYmd } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { captureLogger } from './helpers/logs.js';
import { frontOfficeHelpers } from './helpers/frontOffice.js';
import { today } from './helpers/production.js';
import { Enquiry } from '../src/modules/enquiries/model.js';
import { enquiryListFilter } from '../src/modules/enquiries/queries.js';

useTestDb();
const { logger, lines } = captureLogger();
const app = buildTestApp({ logger });
const { world, addEnquiry, atIst } = frontOfficeHelpers(app);

afterEach(() => vi.restoreAllMocks());

const ok = (r, status = 200) => expect(r.status, JSON.stringify(r.body)).toBe(status);
const call = (who, e, body) => who.agent.post(`/v1/enquiries/${e.id}/call`).send({ version: e.version, ...body });

test("a phone enquiry is saved as new with today's date", async () => {
  const { ops } = await world();
  const r = await addEnquiry(ops, {
    garmentTypes: ['lehenga'],
    interest: 'Bridal, red',
    budget: 15000000,
    source: 'instagram',
    occasionDate: addDaysYmd(today(), 90),
    followUpDate: addDaysYmd(today(), 1),
    note: 'Saw the reel',
  });
  ok(r, 201);
  expect(r.body.enquiry).toMatchObject({
    id: expect.any(String),
    name: 'Priya Sharma',
    phone: '+919845012345',
    garmentTypes: ['lehenga'],
    interest: 'Bridal, red',
    budget: 15000000,
    source: 'instagram',
    followUpDate: addDaysYmd(today(), 1),
    status: 'new',
    isOpen: true,
    lostReason: null,
    enquiryDate: today(),
    convertedCustomer: null,
    convertedOrder: null,
    version: 0,
  });
  expect(r.body.enquiry.log).toEqual([
    { at: expect.any(String), by: { id: String(ops.user._id), name: ops.user.name }, kind: 'note', text: 'Saw the reel' },
  ]);
  const plain = await addEnquiry(ops, { phone: '9845000001' });
  expect(plain.body.enquiry.log).toEqual([]);
  expect(plain.body.enquiry.followUpDate).toBeNull();
});

test('the phone check finds a customer and an open enquiry', async () => {
  const { ops, customer } = await world();
  const none = await ops.agent.get('/v1/enquiries/check-phone').query({ phone: '9000000000' });
  ok(none);
  expect(none.body).toEqual({ customer: null, openEnquiry: null });
  const known = await ops.agent.get('/v1/enquiries/check-phone').query({ phone: '98765 43210' });
  expect(known.body).toEqual({ customer: { id: customer.id, name: 'Asha Rao' }, openEnquiry: null });
  const e = (await addEnquiry(ops)).body.enquiry;
  const open = await ops.agent.get('/v1/enquiries/check-phone').query({ phone: '+919845012345' });
  expect(open.body).toEqual({ customer: null, openEnquiry: { id: e.id, name: 'Priya Sharma', status: 'new' } });
  expect((await ops.agent.get('/v1/enquiries/check-phone').query({ phone: '12' })).status).toBe(400);
});

test('a second open enquiry for a phone is refused', async () => {
  const { ops } = await world();
  await Enquiry.init();
  const first = (await addEnquiry(ops)).body.enquiry;
  const again = await addEnquiry(ops, { name: 'Priya S' });
  expect(again.status).toBe(409);
  expect(again.body.error).toMatchObject({ code: 'ENQUIRY_EXISTS', message: 'There is already an open enquiry for this phone', details: { enquiryId: first.id } });

  const [a, b] = await Promise.all([addEnquiry(ops, { phone: '9845000002' }), addEnquiry(ops, { phone: '9845000002' })]);
  expect([a.status, b.status].sort()).toEqual([201, 409]);
  const loser = a.status === 409 ? a : b;
  const winner = a.status === 201 ? a : b;
  expect(loser.body.error.details).toEqual({ enquiryId: winner.body.enquiry.id });
  expect(await Enquiry.countDocuments({ phone: '+919845000002' })).toBe(1);
});

test('saving twice with one key makes one enquiry', async () => {
  const { ops } = await world();
  const r1 = await addEnquiry(ops, {}, 'same-key');
  const r2 = await addEnquiry(ops, {}, 'same-key');
  ok(r1, 201);
  ok(r2, 201);
  expect(r2.body.enquiry.id).toBe(r1.body.enquiry.id);
  expect(await Enquiry.countDocuments()).toBe(1);
  expect((await ops.agent.post('/v1/enquiries').send({ name: 'X', phone: '9845000003' })).status).toBe(400);
});

test('logging a call moves it to contacted and sets the next call', async () => {
  const { ops } = await world();
  const e = (await addEnquiry(ops, { followUpDate: today() })).body.enquiry;
  const next = addDaysYmd(today(), 3);
  const r = await call(ops, e, { note: 'Wants a lehenga by March', followUpDate: next });
  ok(r);
  expect(r.body.enquiry).toMatchObject({ status: 'contacted', followUpDate: next, version: 1 });
  expect(r.body.enquiry.log.at(-1)).toMatchObject({ kind: 'call', text: 'Wants a lehenga by March' });
  const again = await call(ops, r.body.enquiry, { followUpDate: next });
  expect(again.body.enquiry.log.at(-1)).toMatchObject({ kind: 'call', text: 'Called' });
});

test('no more calls clears the follow-up date', async () => {
  const { ops } = await world();
  const e = (await addEnquiry(ops, { followUpDate: today() })).body.enquiry;
  const r = await call(ops, e, { followUpDate: null });
  ok(r);
  expect(r.body.enquiry.followUpDate).toBeNull();
  expect(r.body.enquiry.isOpen).toBe(true);
});

test("today's follow-ups list due and overdue enquiries, oldest first, without closed ones", async () => {
  const { ops } = await world();
  const t = today();
  const due = (await addEnquiry(ops, { name: 'Due', phone: '9845000010', followUpDate: t })).body.enquiry;
  const late = (await addEnquiry(ops, { name: 'Late', phone: '9845000011', followUpDate: addDaysYmd(t, -2) })).body.enquiry;
  await addEnquiry(ops, { name: 'Later', phone: '9845000012', followUpDate: addDaysYmd(t, 1) });
  await addEnquiry(ops, { name: 'Never', phone: '9845000013' });
  const lost = (await addEnquiry(ops, { name: 'Lost', phone: '9845000014', followUpDate: t })).body.enquiry;
  ok(await ops.agent.post(`/v1/enquiries/${lost.id}/lost`).send({ version: 0, reason: 'Went elsewhere' }));

  const r = await ops.agent.get('/v1/enquiries').query({ view: 'follow_ups' });
  ok(r);
  expect(r.body.items.map((i) => i.name)).toEqual(['Late', 'Due']);
  expect(r.body.items[0]).toMatchObject({ id: late.id, overdue: true, followUpDate: addDaysYmd(t, -2), phone: '+919845000011' });
  expect(r.body.items[1]).toMatchObject({ id: due.id, overdue: false });
  expect(r.body.items[0].budget).toBeUndefined();
  const count = await ops.agent.get('/v1/enquiries/follow-ups/count');
  expect(count.body).toEqual({ count: 2, overdue: 1 });
  const open = await ops.agent.get('/v1/enquiries');
  expect(open.body.items).toHaveLength(4);
  const lostView = await ops.agent.get('/v1/enquiries').query({ view: 'lost' });
  expect(lostView.body.items.map((i) => i.name)).toEqual(['Lost']);
  expect((await ops.agent.get('/v1/enquiries').query({ view: 'all' })).body.items).toHaveLength(5);
});

test('a lost enquiry needs a reason and leaves the follow-ups', async () => {
  const { ops } = await world();
  const e = (await addEnquiry(ops, { followUpDate: today() })).body.enquiry;
  expect((await ops.agent.post(`/v1/enquiries/${e.id}/lost`).send({ version: 0 })).status).toBe(400);
  const r = await ops.agent.post(`/v1/enquiries/${e.id}/lost`).send({ version: 0, reason: 'Too expensive' });
  ok(r);
  expect(r.body.enquiry).toMatchObject({ status: 'lost', isOpen: false, lostReason: 'Too expensive', followUpDate: null });
  expect(r.body.enquiry.log.at(-1)).toMatchObject({ kind: 'status', text: 'Not interested: Too expensive' });
  expect((await ops.agent.get('/v1/enquiries/follow-ups/count')).body.count).toBe(0);
  const twice = await ops.agent.post(`/v1/enquiries/${e.id}/lost`).send({ version: 1, reason: 'Too expensive' });
  expect(twice.status).toBe(422);
  expect(twice.body.error.code).toBe('ENQUIRY_CLOSED');
});

test('a lost enquiry can be reopened unless the phone has a new open enquiry', async () => {
  const { ops } = await world();
  const e = (await addEnquiry(ops)).body.enquiry;
  const lost = (await ops.agent.post(`/v1/enquiries/${e.id}/lost`).send({ version: 0, reason: 'Plans changed' })).body.enquiry;
  const r = await ops.agent.post(`/v1/enquiries/${e.id}/reopen`).send({ version: lost.version });
  ok(r);
  expect(r.body.enquiry).toMatchObject({ status: 'contacted', isOpen: true, lostReason: null, followUpDate: today() });
  const reopenOpen = await ops.agent.post(`/v1/enquiries/${e.id}/reopen`).send({ version: r.body.enquiry.version });
  expect(reopenOpen.body.error.code).toBe('ENQUIRY_CLOSED');

  const lost2 = (await ops.agent.post(`/v1/enquiries/${e.id}/lost`).send({ version: r.body.enquiry.version, reason: 'Other' })).body.enquiry;
  const fresh = (await addEnquiry(ops, { name: 'Priya again' })).body.enquiry;
  const refused = await ops.agent.post(`/v1/enquiries/${e.id}/reopen`).send({ version: lost2.version });
  expect(refused.status).toBe(409);
  expect(refused.body.error).toMatchObject({ code: 'ENQUIRY_EXISTS', details: { enquiryId: fresh.id } });
});

test('a closed enquiry cannot be edited', async () => {
  const { ops } = await world();
  const e = (await addEnquiry(ops)).body.enquiry;
  const edited = await ops.agent.patch(`/v1/enquiries/${e.id}`).send({ version: 0, name: 'Priya Iyer', budget: null, garmentTypes: ['gown'] });
  ok(edited);
  expect(edited.body.enquiry).toMatchObject({ name: 'Priya Iyer', garmentTypes: ['gown'], version: 1 });
  expect((await ops.agent.get('/v1/enquiries').query({ q: 'priya i' })).body.items).toHaveLength(1);
  await ops.agent.post(`/v1/enquiries/${e.id}/lost`).send({ version: 1, reason: 'Other' });
  const r = await ops.agent.patch(`/v1/enquiries/${e.id}`).send({ version: 2, name: 'X' });
  expect(r.status).toBe(422);
  expect(r.body.error).toMatchObject({ code: 'ENQUIRY_CLOSED', message: 'This enquiry is closed' });

  const other = (await addEnquiry(ops, { phone: '9845000020' })).body.enquiry;
  const third = (await addEnquiry(ops, { phone: '9845000021' })).body.enquiry;
  const clash = await ops.agent.patch(`/v1/enquiries/${third.id}`).send({ version: 0, phone: '9845000020' });
  expect(clash.status).toBe(409);
  expect(clash.body.error).toMatchObject({ code: 'ENQUIRY_EXISTS', details: { enquiryId: other.id } });
});

test('a stale version is a conflict', async () => {
  const { ops } = await world();
  const e = (await addEnquiry(ops)).body.enquiry;
  ok(await call(ops, e, { followUpDate: null }));
  const stale = await call(ops, e, { followUpDate: null });
  expect(stale.status).toBe(409);
  expect(stale.body.error.code).toBe('CONFLICT');
  expect((await ops.agent.get('/v1/enquiries/0123456789abcdef01234567')).status).toBe(404);
  expect((await ops.agent.get('/v1/enquiries/nope')).status).toBe(404);
});

test('search finds a phone or a name', async () => {
  const { ops } = await world();
  await addEnquiry(ops, { name: 'Priya Sharma', phone: '9845012345' });
  await addEnquiry(ops, { name: 'Kavya Rao', phone: '9123456780' });
  const byPhone = await ops.agent.get('/v1/enquiries').query({ view: 'all', q: '98450' });
  expect(byPhone.body.items.map((i) => i.name)).toEqual(['Priya Sharma']);
  const byName = await ops.agent.get('/v1/enquiries').query({ view: 'all', q: 'KAV' });
  expect(byName.body.items.map((i) => i.name)).toEqual(['Kavya Rao']);
  const odd = await ops.agent.get('/v1/enquiries').query({ q: 'a.*' });
  expect(odd.body.items).toEqual([]);
});

test('the log keeps the last hundred entries', async () => {
  const { ops } = await world();
  const e = (await addEnquiry(ops)).body.enquiry;
  const log = Array.from({ length: 100 }, (_, i) => ({ at: new Date(), by: ops.user._id, kind: 'call', text: `call ${i}` }));
  await Enquiry.updateOne({ _id: e.id }, { $set: { log } });
  const r = await call(ops, e, { note: 'latest', followUpDate: null });
  ok(r);
  expect(r.body.enquiry.log).toHaveLength(100);
  expect(r.body.enquiry.log[0].text).toBe('call 1');
  expect(r.body.enquiry.log.at(-1).text).toBe('latest');
});

test('enquiry queries use indexes', async () => {
  const { ops, branchId } = await world();
  await Enquiry.init();
  await addEnquiry(ops, { followUpDate: today() });
  const winning = (explained) => {
    const names = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.stage === 'IXSCAN') names.push(node.indexName);
      if (node.stage === 'COLLSCAN') names.push('COLLSCAN');
      walk(node.inputStage);
      for (const child of node.inputStages ?? []) walk(child);
    };
    walk(explained.queryPlanner.winningPlan);
    return names;
  };
  const t = today();
  for (const [view, sort, index] of [
    ['follow_ups', { followUpDate: 1, _id: 1 }, 'follow_ups'],
    ['open', { enquiryDate: -1, _id: -1 }, 'by_open'],
    ['lost', { enquiryDate: -1, _id: -1 }, 'by_status'],
    ['all', { enquiryDate: -1, _id: -1 }, 'by_date'],
  ]) {
    const plan = await Enquiry.find(enquiryListFilter(branchId, { view }, { today: t })).sort(sort).explain('queryPlanner');
    expect(winning(plan), view).toEqual([index]);
  }
  const phonePlan = await Enquiry.find({ branchId, phone: '+919845012345', isOpen: true }).explain('queryPlanner');
  expect(winning(phonePlan)).not.toContain('COLLSCAN');
});

test('no phone or name reaches the logs', async () => {
  const { ops } = await world();
  lines.length = 0;
  const e = (await addEnquiry(ops, { name: 'Zeenat Unique', note: 'secret note' })).body.enquiry;
  await call(ops, e, { note: 'said something private', followUpDate: null });
  await ops.agent.get('/v1/enquiries/check-phone').query({ phone: '9845012345' });
  const text = JSON.stringify(lines);
  expect(lines.length).toBeGreaterThan(0);
  for (const secret of ['9845012345', 'Zeenat', 'secret note', 'private']) expect(text).not.toContain(secret);
});

test('the enquiry date is the IST day', async () => {
  const { ops } = await world();
  atIst('2026-11-07', '23:50');
  const r = await addEnquiry(ops);
  expect(r.body.enquiry.enquiryDate).toBe('2026-11-07');
});

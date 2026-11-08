import { test, expect } from 'vitest';
import {
  enquirySchema,
  enquiryPatchSchema,
  logCallSchema,
  lostSchema,
  reopenSchema,
  convertSchema,
  enquiryListQuery,
  checkPhoneQuery,
  appointmentSchema,
  appointmentMoveSchema,
  appointmentCancelSchema,
  appointmentMarkSchema,
  appointmentDayQuery,
  appointmentListQuery,
} from '../src/schemas/frontOffice.js';
import { orderCreateSchema } from '../src/schemas/orders.js';

const id = (n) => String(n).padStart(24, 'a');
const enquiry = { name: 'Priya', phone: '98765 43210' };
const appt = { type: 'consultation', designerId: id(1), customerId: id(2), date: '2026-11-07', time: '11:30' };
const fails = (schema, value) => !schema.safeParse(value).success;

test('an enquiry needs a name and a valid phone', () => {
  const r = enquirySchema.parse(enquiry);
  expect(r).toEqual({
    name: 'Priya',
    phone: '+919876543210',
    garmentTypes: [],
    interest: '',
    budget: null,
    source: 'walk_in',
    occasionDate: null,
    followUpDate: null,
    note: '',
  });
  expect(fails(enquirySchema, { phone: '9876543210' })).toBe(true);
  expect(fails(enquirySchema, { ...enquiry, name: '  ' })).toBe(true);
  expect(fails(enquirySchema, { ...enquiry, phone: '123' })).toBe(true);
  expect(fails(enquirySchema, { name: 'Priya' })).toBe(true);
});

test('phones are stored in international form', () => {
  expect(enquirySchema.parse(enquiry).phone).toBe('+919876543210');
  expect(checkPhoneQuery.parse({ phone: '98765 43210' }).phone).toBe('+919876543210');
});

test('interest chips are garment types, at most ten, no repeats', () => {
  expect(enquirySchema.parse({ ...enquiry, garmentTypes: ['lehenga', 'blouse'] }).garmentTypes).toEqual(['lehenga', 'blouse']);
  expect(fails(enquirySchema, { ...enquiry, garmentTypes: ['lehenga', 'lehenga'] })).toBe(true);
  expect(fails(enquirySchema, { ...enquiry, garmentTypes: ['Bad Key'] })).toBe(true);
  const eleven = Array.from({ length: 11 }, (_, i) => `t${i}`);
  expect(fails(enquirySchema, { ...enquiry, garmentTypes: eleven })).toBe(true);
  expect(enquirySchema.safeParse({ ...enquiry, garmentTypes: eleven.slice(0, 10) }).success).toBe(true);
});

test('a budget is paise and may be empty', () => {
  expect(enquirySchema.parse({ ...enquiry, budget: 5000000 }).budget).toBe(5000000);
  expect(enquirySchema.parse({ ...enquiry, budget: null }).budget).toBeNull();
  expect(fails(enquirySchema, { ...enquiry, budget: 12.5 })).toBe(true);
  expect(fails(enquirySchema, { ...enquiry, budget: -1 })).toBe(true);
  expect(fails(enquirySchema, { ...enquiry, budget: 1_000_000_001 })).toBe(true);
});

test('an enquiry patch is never filled with defaults and cannot be empty', () => {
  expect(enquiryPatchSchema.parse({ name: 'Priya S' })).toEqual({ name: 'Priya S' });
  expect(fails(enquiryPatchSchema, {})).toBe(true);
  expect(fails(enquiryPatchSchema, { note: 'x' })).toBe(true);
  expect(enquiryPatchSchema.parse({ followUpDate: null })).toEqual({ followUpDate: null });
});

test('a lost enquiry needs a reason', () => {
  expect(fails(lostSchema, {})).toBe(true);
  expect(fails(lostSchema, { reason: ' ' })).toBe(true);
  expect(lostSchema.parse({ reason: 'Too expensive' })).toEqual({ reason: 'Too expensive' });
  expect(logCallSchema.parse({ followUpDate: null })).toEqual({ note: '', followUpDate: null });
  expect(fails(logCallSchema, {})).toBe(true);
  expect(reopenSchema.parse({})).toEqual({});
  expect(convertSchema.parse({})).toEqual({ customerId: null });
});

test('an appointment is for a customer or an enquiry, not both', () => {
  const r = appointmentSchema.parse(appt);
  expect(r).toMatchObject({ customerId: id(2), enquiryId: null, garmentIds: [], note: '' });
  expect(r.minutes).toBeUndefined();
  expect(appointmentSchema.safeParse({ ...appt, customerId: null, enquiryId: id(3) }).success).toBe(true);
  const both = appointmentSchema.safeParse({ ...appt, enquiryId: id(3) });
  expect(both.success).toBe(false);
  expect(both.error.issues[0]).toMatchObject({ path: ['customerId'], message: 'Choose who the appointment is for' });
  expect(fails(appointmentSchema, { ...appt, customerId: null })).toBe(true);
});

test('garments go only on fittings', () => {
  expect(appointmentSchema.safeParse({ ...appt, type: 'fitting', garmentIds: [id(5)] }).success).toBe(true);
  const r = appointmentSchema.safeParse({ ...appt, garmentIds: [id(5)] });
  expect(r.success).toBe(false);
  expect(r.error.issues[0].path).toEqual(['garmentIds']);
  expect(fails(appointmentSchema, { ...appt, type: 'fitting', garmentIds: [id(5), id(5)] })).toBe(true);
});

test('times are on the quarter hour', () => {
  expect(appointmentSchema.safeParse({ ...appt, time: '11:45' }).success).toBe(true);
  const r = appointmentSchema.safeParse({ ...appt, time: '11:40' });
  expect(r.success).toBe(false);
  expect(r.error.issues[0].message).toBe('Choose a time on the quarter hour');
  expect(fails(appointmentSchema, { ...appt, minutes: 4 })).toBe(true);
  expect(fails(appointmentSchema, { ...appt, minutes: 481 })).toBe(true);
});

test('an appointment must end by midnight', () => {
  const r = appointmentSchema.safeParse({ ...appt, time: '23:45', minutes: 30 });
  expect(r.success).toBe(false);
  expect(r.error.issues[0]).toMatchObject({ path: ['minutes'], message: 'The appointment must end by midnight' });
  expect(appointmentSchema.safeParse({ ...appt, time: '23:45', minutes: 15 }).success).toBe(true);
});

test('a move cannot be empty', () => {
  expect(fails(appointmentMoveSchema, {})).toBe(true);
  expect(appointmentMoveSchema.parse({ time: '12:00' })).toEqual({ time: '12:00' });
  expect(fails(appointmentMoveSchema, { type: 'fitting' })).toBe(true);
  expect(appointmentCancelSchema.parse({})).toEqual({ reason: '' });
});

test("done or didn't come are the only marks", () => {
  expect(appointmentMarkSchema.parse({ status: 'completed' })).toEqual({ status: 'completed' });
  expect(appointmentMarkSchema.parse({ status: 'no_show' })).toEqual({ status: 'no_show' });
  expect(fails(appointmentMarkSchema, { status: 'cancelled' })).toBe(true);
  expect(fails(appointmentMarkSchema, { status: 'booked' })).toBe(true);
});

test('unknown keys are refused', () => {
  expect(fails(enquirySchema, { ...enquiry, extra: 1 })).toBe(true);
  expect(fails(appointmentSchema, { ...appt, extra: 1 })).toBe(true);
  expect(fails(enquiryListQuery, { extra: '1' })).toBe(true);
  expect(enquiryListQuery.parse({})).toEqual({ view: 'open' });
  expect(enquiryListQuery.parse({ view: 'follow_ups', limit: '20' })).toEqual({ view: 'follow_ups', limit: 20 });
  expect(fails(enquiryListQuery, { view: 'mine' })).toBe(true);
  expect(appointmentDayQuery.parse({ date: '2026-11-07' })).toEqual({ date: '2026-11-07' });
  expect(fails(appointmentDayQuery, {})).toBe(true);
  expect(appointmentListQuery.parse({ status: 'booked', limit: '5' })).toEqual({ status: 'booked', limit: 5 });
  expect(fails(appointmentListQuery, { q: 'x' })).toBe(true);
});

test('an order may name the enquiry it came from', () => {
  const order = {
    customerId: id(1),
    designerId: id(2),
    pickupDate: '2026-12-01',
    garments: [{ type: 'blouse', description: 'Silk blouse', agreedPrice: 500000 }],
  };
  expect(orderCreateSchema.parse(order).enquiryId).toBeNull();
  expect(orderCreateSchema.parse({ ...order, enquiryId: id(3) }).enquiryId).toBe(id(3));
  expect(fails(orderCreateSchema, { ...order, enquiryId: 'nope' })).toBe(true);
});

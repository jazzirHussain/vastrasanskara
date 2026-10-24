import { test, expect } from 'vitest';
import { DEFAULT_SETTINGS, settingsSchema, settingsPatchSchema } from '../src/schemas/settings.js';
import { customerSchema, customerPatchSchema } from '../src/schemas/customers.js';
import { measurementSchema } from '../src/schemas/measurements.js';
import { orderCreateSchema, ymd } from '../src/schemas/orders.js';

const ID = '0123456789abcdef01234567';
const customer = { name: 'Asha Rao', phone: '98765 43210' };
const order = {
  customerId: ID, designerId: ID, pickupDate: '2026-11-15',
  garments: [{ type: 'blouse', description: 'Bridal blouse', agreedPrice: 450000 }],
};

test('default garment types parse and cover the common garments', () => {
  expect(settingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  expect(DEFAULT_SETTINGS.garmentTypes.map((t) => t.key)).toEqual(['blouse', 'lehenga', 'kurta', 'gown', 'sherwani', 'pants', 'other']);
  expect(DEFAULT_SETTINGS.garmentTypes[0].measurementFields).toHaveLength(10);
});
test('duplicate garment-type keys are rejected', () => {
  const garmentTypes = [{ key: 'blouse', label: 'Blouse', measurementFields: [] }, { key: 'blouse', label: 'Other blouse', measurementFields: [] }];
  expect(settingsPatchSchema.safeParse({ garmentTypes }).success).toBe(false);
});
test('customer defaults and phone normalisation', () => {
  expect(customerSchema.parse(customer)).toMatchObject({
    name: 'Asha Rao', phone: '+919876543210', type: 'individual', source: 'walk_in',
    consent: { email: false, whatsapp: false, sms: false }, billingAddress: { line1: '', line2: '', city: '', pincode: '' },
  });
});
test('consent without a note is rejected', () => {
  const r = customerSchema.safeParse({ ...customer, consent: { email: true, whatsapp: false, sms: false } });
  expect(r.success).toBe(false);
  expect(r.error.issues[0].path).toEqual(['consentNote']);
  expect(customerSchema.safeParse({ ...customer, consent: { email: true, whatsapp: false, sms: false }, consentNote: 'Agreed at the counter' }).success).toBe(true);
});
test('GSTIN must match the state code', () => {
  const r = customerSchema.safeParse({ ...customer, gstin: '29ABCDE1234F1Z5', stateCode: '32' });
  expect(r.success).toBe(false);
  expect(r.error.issues[0].path).toEqual(['stateCode']);
  expect(customerSchema.safeParse({ ...customer, gstin: '29ABCDE1234F1Z5', stateCode: '29' }).success).toBe(true);
});
test('customer patch applies no defaults', () => {
  expect(customerPatchSchema.parse({ name: 'Asha' })).toEqual({ name: 'Asha' });
  expect(customerPatchSchema.safeParse({}).success).toBe(false);
});
test('measurement values are positive and uniquely named', () => {
  const values = [{ name: 'Bust', value: 34, unit: 'in' }];
  expect(measurementSchema.parse({ garmentType: 'blouse', values })).toEqual({ garmentType: 'blouse', values, notes: '' });
  expect(measurementSchema.safeParse({ garmentType: 'blouse', values: [{ ...values[0], value: 0 }] }).success).toBe(false);
  expect(measurementSchema.safeParse({ garmentType: 'blouse', values: [...values, ...values] }).success).toBe(false);
});
test('order defaults', () => {
  expect(orderCreateSchema.parse(order)).toMatchObject({
    priority: 'normal', expectedBudget: null, occasionDate: null, notes: '',
    garments: [{ quantity: 1, dueDate: null, referenceKeys: [], measurementId: null, fabric: '', designNotes: '' }],
  });
});
test('dates must be real calendar dates', () => {
  expect(ymd.safeParse('2026-02-28').success).toBe(true);
  expect(orderCreateSchema.safeParse({ ...order, pickupDate: '2026-02-30' }).success).toBe(false);
  expect(orderCreateSchema.safeParse({ ...order, pickupDate: '15-11-2026' }).success).toBe(false);
});
test('an order needs garments with a quantity of at least 1', () => {
  expect(orderCreateSchema.safeParse({ ...order, garments: [] }).success).toBe(false);
  expect(orderCreateSchema.safeParse({ ...order, garments: [{ ...order.garments[0], quantity: 0 }] }).success).toBe(false);
  expect(orderCreateSchema.safeParse({ ...order, garments: [{ ...order.garments[0], quantity: 3 }] }).success).toBe(true);
});

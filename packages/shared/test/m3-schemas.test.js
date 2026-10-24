import { test, expect } from 'vitest';
import { stageActionSchema } from '../src/schemas/production.js';
import { vendorPatchSchema, vendorSchema, workerPatchSchema, workerSchema } from '../src/schemas/workshop.js';

const id = (n) => String(n).padStart(24, 'a');
const base = { stage: 'handwork', garments: [{ id: id(1), version: 0 }] };
const ok = (body) => stageActionSchema.safeParse({ ...base, ...body }).success;

test('a plain action parses with defaults', () => {
  expect(stageActionSchema.parse({ ...base, action: 'complete' })).toEqual({
    ...base, action: 'complete', remarks: '', photoKeys: [], workerIds: [], chargeable: false,
  });
});

test('skip needs a reason', () => {
  expect(ok({ action: 'skip' })).toBe(false);
  expect(ok({ action: 'skip', reason: 'Plain' })).toBe(true);
});

test('sent_to_vendor needs vendor and due-back date', () => {
  expect(ok({ action: 'sent_to_vendor', vendorId: id(2) })).toBe(false);
  expect(ok({ action: 'sent_to_vendor', dueBackDate: '2026-11-15' })).toBe(false);
  expect(ok({ action: 'sent_to_vendor', vendorId: id(2), dueBackDate: '2026-11-15' })).toBe(true);
});

test('rework and QC fail need a rework stage', () => {
  expect(ok({ action: 'qc_fail' })).toBe(false);
  expect(ok({ action: 'rework', reworkStage: 'tailors' })).toBe(true);
});

test('charges only on rework, QC fail and alteration', () => {
  expect(ok({ action: 'complete', chargeable: true })).toBe(false);
  expect(ok({ action: 'complete', chargeAmount: 100 })).toBe(false);
  expect(ok({ action: 'qc_fail', reworkStage: 'handwork', chargeable: true, chargeAmount: 50000 })).toBe(true);
  expect(ok({ action: 'alteration', chargeable: true, chargeAmount: null })).toBe(true);
  expect(ok({ action: 'alteration', chargeAmount: 1.5 })).toBe(false);
});

test('rejection acts on one garment', () => {
  const two = [{ id: id(1), version: 0 }, { id: id(2), version: 0 }];
  expect(ok({ action: 'rejected', reason: 'Disliked', resolution: 'remake' })).toBe(true);
  expect(ok({ action: 'rejected', reason: 'Disliked' })).toBe(false);
  expect(ok({ action: 'rejected', resolution: 'refund' })).toBe(false);
  expect(ok({ action: 'rejected', reason: 'Disliked', resolution: 'refund', garments: two })).toBe(false);
  expect(ok({ action: 'alteration', garments: two })).toBe(false);
});

test('garments are unique and at most 50', () => {
  expect(ok({ action: 'complete', garments: [] })).toBe(false);
  expect(ok({ action: 'complete', garments: [{ id: id(1), version: 0 }, { id: id(1), version: 1 }] })).toBe(false);
  expect(ok({ action: 'complete', garments: Array.from({ length: 51 }, (_, i) => ({ id: id(i), version: 0 })) })).toBe(false);
  expect(ok({ action: 'complete', garments: Array.from({ length: 50 }, (_, i) => ({ id: id(i), version: 0 })) })).toBe(true);
});

test('unknown keys and actions are refused', () => {
  expect(ok({ action: 'teleport' })).toBe(false);
  expect(ok({ action: 'complete', $where: 1 })).toBe(false);
});

test('worker schema defaults and patch', () => {
  expect(workerSchema.parse({ name: ' Ravi ' })).toEqual({ name: 'Ravi', skill: '', phone: null, active: true });
  expect(workerSchema.parse({ name: 'Ravi', phone: '98765 43210' }).phone).toBe('+919876543210');
  expect(workerPatchSchema.safeParse({}).success).toBe(false);
  expect(workerPatchSchema.parse({ active: false })).toEqual({ active: false });
});

test('vendor GSTIN fixes the state code', () => {
  const gstin = '29ABCDE1234F1Z5';
  expect(vendorSchema.safeParse({ name: 'Zari works', gstin, stateCode: '27' }).success).toBe(false);
  expect(vendorSchema.parse({ name: 'Zari works', gstin, stateCode: '29', services: ['Embroidery'] })).toMatchObject({
    name: 'Zari works', gstin, stateCode: '29', services: ['Embroidery'], phone: null, active: true,
  });
  expect(vendorPatchSchema.parse({ services: [] })).toEqual({ services: [] });
  expect(vendorPatchSchema.safeParse({ gstin, stateCode: '27' }).success).toBe(false);
});

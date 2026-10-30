import { http, HttpResponse } from 'msw';
import { amountInWords, computeInvoice, permissionsFor } from '@vs/shared';
import { server } from './server.js';

/** Front desk staff (the operations role): may draft, issue and discount bills. */
export const frontDeskUser = {
  id: 'ops1',
  name: 'Kavya',
  email: 'kavya@x.com',
  roles: ['operations'],
  permissions: [...permissionsFor(['operations'])],
  branchId: 'b1',
};

export function asFrontDesk() {
  server.use(http.get('/v1/auth/me', () => HttpResponse.json(frontDeskUser)));
}

const clothing = [
  { upToUnitPrice: 250000, rateBp: 500 },
  { upToUnitPrice: null, rateBp: 1800 },
];
const item = (fields) => ({
  kind: 'stitching_service',
  supplyType: 'service',
  hsnSac: '998821',
  unit: 'PCS',
  defaultPrice: 0,
  gstSlabs: clothing,
  garmentTypes: [],
  chargeFor: null,
  active: true,
  version: 0,
  ...fields,
});

export const blouseItem = item({ id: 'i1', name: 'Blouse stitching', defaultPrice: 120000, garmentTypes: ['blouse'] });
export const alterationItem = item({ id: 'i2', name: 'Alteration', kind: 'extra_charge', gstSlabs: [{ upToUnitPrice: null, rateBp: 500 }], chargeFor: 'alteration' });
export const fallItem = item({ id: 'i3', name: 'Fall and pico', defaultPrice: 25000, gstSlabs: [{ upToUnitPrice: null, rateBp: 500 }] });
export const catalogItems = [blouseItem, alterationItem, fallItem];

export function catalog(items = catalogItems) {
  server.use(http.get('/v1/catalog/items', () => HttpResponse.json({ items })));
}

const byId = new Map(catalogItems.map((i) => [i.id, i]));

/** A draft line as stored (the request shape). */
export function lineInput({ key = 'g-g1', itemId = 'i1', garmentId = 'g1', stageEventId = null, source = 'garment', ...fields } = {}) {
  return {
    key,
    itemId,
    garmentId,
    stageEventId,
    source,
    description: 'Blouse — Blouse 1 (VS/ORD/2627/0007-01)',
    quantity: 1,
    rate: 200000,
    discount: 0,
    discountReason: '',
    ...fields,
  };
}

/** A draft bill as GET /v1/billing/invoices/:id returns it, computed as the server does. */
export function draftFixture({ lines = [lineInput()], invoiceDiscount = null, warnings, version = 0, ...fields } = {}) {
  const ready = lines.length > 0 && lines.every((l) => byId.has(l.itemId));
  const calc = ready
    ? computeInvoice({
        lines: lines.map((l) => ({ ...l, hsnSac: byId.get(l.itemId).hsnSac, gstSlabs: byId.get(l.itemId).gstSlabs })),
        invoiceDiscount: invoiceDiscount?.amount ?? 0,
        interState: false,
      })
    : null;
  const calcOf = (key) => calc?.lines.find((c) => c.key === key);
  return {
    id: 'inv1',
    type: 'invoice',
    status: 'draft',
    number: null,
    date: null,
    dueDate: null,
    customer: { id: 'c1', name: 'Asha Rao', gstin: null, stateCode: '29' },
    order: { id: 'o1', orderNo: 'VS/ORD/2627/0007' },
    lines: lines.map((l) => {
      const c = calcOf(l.key);
      const it = byId.get(l.itemId);
      return {
        ...l,
        item: it ? { name: it.name, hsnSac: it.hsnSac, supplyType: it.supplyType, unit: it.unit } : null,
        invoiceDiscountShare: c?.invoiceDiscountShare ?? null,
        taxable: c?.taxable ?? null,
        gstRateBp: c?.rateBp ?? null,
        cgst: c?.cgst ?? null,
        sgst: c?.sgst ?? null,
        igst: c?.igst ?? null,
        total: c?.total ?? null,
      };
    }),
    invoiceDiscount,
    notes: '',
    placeOfSupply: { stateCode: '29', stateName: 'Karnataka', interState: false },
    totals: calc ? calc.totals : null,
    amountInWords: calc ? amountInWords(calc.totals.total) : null,
    settlement: null,
    overdue: false,
    monthLocked: false,
    remindersPaused: false,
    advanceAdjustments: [],
    creditNotes: [],
    warnings: warnings ?? lines.filter((l) => !byId.has(l.itemId)).map((l) => ({ code: 'ITEM_REQUIRED', lineKey: l.key })),
    pdf: null,
    cancellation: null,
    version,
    ...fields,
  };
}

/** The same bill once issued (number INV/2627/0001, nothing paid unless `settlement` says). */
export function issuedFixture({ settlement, pdf = { status: 'pending' }, ...fields } = {}) {
  const draft = draftFixture(fields);
  const total = draft.totals.total;
  return {
    ...draft,
    status: 'issued',
    number: 'INV/2627/0001',
    date: '2026-10-30',
    dueDate: '2026-11-06',
    settlement: settlement ?? { advanceApplied: 0, paid: 0, credited: 0, balance: total, payStatus: 'unpaid' },
    warnings: [],
    pdf,
    version: draft.version + 1,
  };
}

/** GET /v1/billing/orders/:id/summary. */
export function orderMoneyFixture(fields = {}) {
  return {
    orderValue: 400000,
    estimatedTotal: 420000,
    advanceDue: 200000,
    advanceHeld: 0,
    billed: 0,
    balanceDue: 0,
    hasUnbilled: true,
    draftInvoiceId: null,
    invoices: [],
    receipts: [],
    refundSuggestion: null,
    ...fields,
  };
}

export function orderMoney(fields) {
  server.use(http.get('/v1/billing/orders/o1/summary', () => HttpResponse.json(orderMoneyFixture(fields))));
}

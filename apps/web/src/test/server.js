import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { DEFAULT_SETTINGS } from '@vs/shared/schemas/settings.js';

const notAuthenticated = () =>
  HttpResponse.json({ error: { code: 'NOT_AUTHENTICATED', message: 'Please sign in' } }, { status: 401 });

export const adminUser = {
  id: 'admin1',
  name: 'Owner',
  email: 'owner@x.com',
  roles: ['admin'],
  permissions: ['users.manage', 'settings.edit', 'system.monitor', 'money.view', 'catalog.manage'],
  branchId: 'b1',
};

export const defaultSettings = structuredClone(DEFAULT_SETTINGS);

export const defaultBranch = {
  id: 'b1',
  name: 'Vastrasanskara',
  legalName: 'Vastrasanskara Pvt Ltd',
  gstin: null,
  stateCode: '29',
  address: { line1: '', line2: '', city: 'Bengaluru', pincode: '' },
  phone: null,
  email: null,
  logoKey: null,
  prefixes: { invoice: 'INV', creditNote: 'CN', receiptVoucher: 'RV', receipt: 'RCPT', refund: 'RF', expense: 'EXP', order: 'VS/ORD' },
};

// Defaults: nobody is signed in, no notifications, default settings and branch, no money on orders,
// no records check run yet.
// Tests override with server.use().
export const server = setupServer(
  http.get('/v1/auth/me', notAuthenticated),
  http.get('/v1/notifications', () => HttpResponse.json({ items: [], unreadCount: 0 })),
  http.get('/v1/settings', () => HttpResponse.json(defaultSettings)),
  http.get('/v1/branch', () => HttpResponse.json(defaultBranch)),
  http.get('/v1/orders', () => HttpResponse.json({ items: [], nextCursor: null })),
  http.get('/v1/expenses/payees', () => HttpResponse.json({ vendors: [], recent: [] })),
  http.get('/v1/expenses', () => HttpResponse.json({ items: [], nextCursor: null })),
  http.get('/v1/expenses/summary', ({ request }) =>
    HttpResponse.json({
      month: new URL(request.url).searchParams.get('month'),
      total: 0,
      count: 0,
      previousMonthTotal: 0,
      byCategory: [],
      byMode: [],
      gst: { count: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, itc: { cgst: 0, sgst: 0, igst: 0 }, ineligible: { cgst: 0, sgst: 0, igst: 0 } },
      missingBill: 0,
      locked: false,
    }),
  ),
  http.get('/v1/billing/customers/:id/summary', () =>
    HttpResponse.json({ billed: 0, received: 0, credited: 0, refunded: 0, outstanding: 0, overdue: 0, advanceHeld: 0 }),
  ),
  http.get('/v1/admin/audit/verify', () => HttpResponse.json({ run: null })),
  http.get('/v1/billing/customers/:id/ledger', () => HttpResponse.json({ items: [], nextCursor: null })),
  http.get('/v1/billing/orders/:id/summary', () =>
    HttpResponse.json({
      orderValue: 0,
      estimatedTotal: 0,
      advanceDue: 0,
      advanceHeld: 0,
      billed: 0,
      balanceDue: 0,
      hasUnbilled: true,
      draftInvoiceId: null,
      invoices: [],
      receipts: [],
      refundSuggestion: null,
    }),
  ),
);

export function asAdmin() {
  server.use(http.get('/v1/auth/me', () => HttpResponse.json(adminUser)));
}

export function asAnonymous() {
  server.use(http.get('/v1/auth/me', notAuthenticated));
}

export const operationsUser = {
  id: 'ops1',
  name: 'Kavya',
  email: 'kavya@x.com',
  roles: ['operations'],
  permissions: ['orders.read.own', 'orders.read.all', 'orders.write', 'customers.read', 'customers.write', 'measurements.write', 'money.view', 'workshop.manage'],
  branchId: 'b1',
};

export const designerUser = {
  id: 'des1',
  name: 'Meera',
  email: 'meera@x.com',
  roles: ['designer'],
  permissions: ['orders.read.own', 'production.update', 'measurements.write', 'customers.read'],
  branchId: 'b1',
};

export function asOperations() {
  server.use(http.get('/v1/auth/me', () => HttpResponse.json(operationsUser)));
}

export function asDesigner() {
  server.use(http.get('/v1/auth/me', () => HttpResponse.json(designerUser)));
}

/** A customer as GET /v1/customers/:id returns it. */
export function customerFixture(fields = {}) {
  return {
    id: 'c1',
    name: 'Asha Rao',
    phone: '+919876543210',
    email: null,
    type: 'individual',
    gstin: null,
    stateCode: '29',
    billingAddress: { line1: '', line2: '', city: '', pincode: '' },
    source: 'walk_in',
    consent: { email: false, whatsapp: false, sms: false },
    consentNote: '',
    preferredChannel: null,
    createdAt: '2026-10-20T06:00:00Z',
    version: 0,
    ...fields,
  };
}

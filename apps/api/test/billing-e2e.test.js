import { test, expect } from 'vitest';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { billingHelpers } from './helpers/billing.js';
import { BillingDocument } from '../src/modules/billing/model.js';
import { renderPendingPdfs, runPendingIntegrityChecks } from '../src/modules/billing/service.js';

useTestDb();
const app = buildTestApp();
const storage = app.locals.storage;
const { world, draftFor, issue, pay, makeReady, send } = billingHelpers(app);

const ok = (r, status = 201) => expect(r.status, JSON.stringify(r.body)).toBe(status);

test('order to stages to bill to payment to credit note', async () => {
  const { ops, admin, d1, customerId, takeOrder } = await world();

  // Take the order with an advance.
  const order = await takeOrder({ prices: [450000] }); // 12 % GST: bill total 5,040.00
  const advance = await pay(ops, { customerId, orderId: order.id, amount: 100000, mode: 'cash' });
  ok(advance);

  // The designer walks the garment to ready, then the front desk bills it.
  const ready = await makeReady(d1, order.garments[0]);
  expect(ready.status).toBe('ready');
  const draft = await draftFor(order);
  const issued = await issue(ops, draft);
  ok(issued);
  const bill = issued.body.invoice;
  expect(bill.settlement).toMatchObject({ advanceApplied: 100000, balance: bill.totals.total - 100000 });

  // The worker renders the PDF; staff get a link.
  expect(await renderPendingPdfs({ storage })).toMatchObject({ failed: 0 });
  const link = await ops.agent.get(`/v1/billing/documents/${bill.id}/pdf`);
  ok(link, 200);
  expect(link.body.status).toBe('ready');
  expect((await BillingDocument.findById(bill.id).lean()).pdf.status).toBe('ready');

  // Pay the balance, then the customer picks the garment up.
  const balance = bill.totals.total - 100000;
  ok(await pay(ops, { customerId, invoiceId: bill.id, amount: balance, mode: 'upi' }));
  const pickedUp = await send(ops, [ready], { action: 'picked_up' });
  ok(pickedUp, 200);

  // A part credit note reduces the bill; the freed money is refunded.
  const credit = await admin.agent
    .post(`/v1/billing/invoices/${bill.id}/credit-notes`)
    .set('Idempotency-Key', 'e2e-credit')
    .send({ reason: 'Price reduced', lines: [{ key: bill.lines[0].key, taxable: 10000 }] });
  ok(credit);
  const credited = credit.body.creditNote.totals.total;
  expect(credited).toBe(11200);
  const held = (await ops.agent.get(`/v1/billing/customers/${customerId}/summary`)).body;
  expect(held.advanceHeld).toBe(credited);
  ok(
    await admin.agent
      .post('/v1/billing/refunds')
      .set('Idempotency-Key', 'e2e-refund')
      .send({ customerId, orderId: order.id, amount: credited, mode: 'upi', reason: 'Price reduced after pickup' }),
  );

  // Everything squares: nothing owed, nothing held, ledger balance 0.
  const summary = (await ops.agent.get(`/v1/billing/customers/${customerId}/summary`)).body;
  expect(summary).toMatchObject({ outstanding: 0, advanceHeld: 0, credited, refunded: credited });
  const ledger = (await ops.agent.get(`/v1/billing/customers/${customerId}/ledger?limit=100`)).body;
  expect(ledger.items[0].balance).toBe(0);
  expect((await ops.agent.get(`/v1/billing/invoices/${bill.id}`)).body.invoice.settlement.balance).toBe(0);

  // And the records check out.
  await renderPendingPdfs({ storage });
  ok(await admin.agent.post('/v1/admin/audit/verify').send({}), 202);
  await runPendingIntegrityChecks({ storage });
  const check = await admin.agent.get('/v1/admin/audit/verify');
  ok(check, 200);
  expect(check.body.run).toMatchObject({ status: 'done' });
  expect(check.body.run.result).toMatchObject({
    ok: true,
    audit: { ok: true, firstBreak: null },
    pdfs: { pending: 0, problems: [] },
    balances: { problems: [] },
  });
});

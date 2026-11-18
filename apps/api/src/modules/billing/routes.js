import { Router } from 'express';
import {
  billingReasonSchema,
  remindersSchema,
  blankInvoiceSchema,
  creditNoteSchema,
  fromOrderSchema,
  invoiceDraftSchema,
  invoiceListQuery,
  ledgerQuery,
  issueSchema,
  paymentSchema,
  receiptListQuery,
  receivablesQuery,
  refundSchema,
} from '@vs/shared/schemas/billing.js';
import { actorFrom, requirePermission } from '../../core/auth/middleware.js';
import { idempotent } from '../../core/idempotency.js';
import { validate, versioned } from '../../core/validate.js';
import { logger } from '../../logger.js';
import {
  toCreditNoteJson,
  toInvoiceJson,
  toIntegrityRunJson,
  toInvoiceRowJson,
  toReceiptJson,
  toReceiptRowJson,
  toReceiptVoucherJson,
  toRefundJson,
} from './json.js';
import {
  cancelInvoice,
  cancelOpeningBalance,
  cancelReceipt,
  createBlankDraft,
  createDraftFromOrder,
  customerLedger,
  customerMoneySummary,
  deleteDraft,
  getCreditNote,
  getInvoice,
  getReceipt,
  getReceiptVoucher,
  getRefund,
  invoiceView,
  issueCreditNote,
  issueInvoice,
  issueRefund,
  latestIntegrityCheck,
  listInvoices,
  listReceipts,
  listReceivables,
  orderMoney,
  receiptView,
  recordPayment,
  refundView,
  setReminderPause,
  startIntegrityCheck,
  pdfLink,
  updateDraft,
} from './service.js';

const jsonOf = async (branchId, invoice) => toInvoiceJson(await invoiceView(branchId, invoice));
const receiptJsonOf = async (branchId, receipt) => toReceiptJson(await receiptView(branchId, receipt));
const refundJsonOf = async (_branchId, refund) => toRefundJson(await refundView(refund));
const minimalDoc = (d) => ({ id: String(d._id), number: d.number, status: d.status });

// How each committed document answers, and its minimal form if reading it back fails.
const ANSWERS = {
  invoice: { read: jsonOf, minimal: (d) => ({ id: String(d._id), number: d.number, status: d.status, version: d.__v }) },
  receipt: { read: receiptJsonOf, minimal: minimalDoc },
  creditNote: { read: async (_branchId, d) => toCreditNoteJson(d), minimal: minimalDoc },
  refund: { read: refundJsonOf, minimal: minimalDoc },
};

/**
 * Answers 201 for a billing write that has committed. If reading the bill back fails, the reply
 * is still a success (its id, number and status), because an error would free the
 * Idempotency-Key and the client's retry would repeat the write.
 */
async function respondCommitted(req, res, kind, doc, extra = {}) {
  const { read, minimal } = ANSWERS[kind];
  let body;
  try {
    body = { [kind]: await read(req.user.branchId, doc), ...extra };
  } catch (err) {
    logger.warn({ err, docId: String(doc._id), kind, requestId: req.id }, 'billing document saved; reading it back failed');
    body = { [kind]: minimal(doc), ...extra };
  }
  res.status(201).json(body);
}

export function billingRouter(storage) {
  const router = Router();
  // Every billing route needs money.view: designers never see bills.
  router.use(requirePermission('money.view'));

  router.get('/customers/:id/summary', async (req, res) => {
    res.json(await customerMoneySummary(req.user.branchId, req.params.id));
  });

  router.get('/customers/:id/ledger', validate({ query: ledgerQuery }), async (req, res) => {
    res.json(await customerLedger(req.user.branchId, req.params.id, req.validatedQuery));
  });

  router.get('/receivables', validate({ query: receivablesQuery }), async (req, res) => {
    res.json(await listReceivables(req.user.branchId, req.validatedQuery));
  });

  router.get('/orders/:id/summary', async (req, res) => {
    res.json(await orderMoney(req.user.branchId, req.params.id));
  });

  router.get('/invoices', validate({ query: invoiceListQuery }), async (req, res) => {
    const { items, nextCursor } = await listInvoices(req.user.branchId, req.validatedQuery);
    res.json({ items: items.map(toInvoiceRowJson), nextCursor });
  });

  router.get('/payments', validate({ query: receiptListQuery }), async (req, res) => {
    const { items, nextCursor } = await listReceipts(req.user.branchId, req.validatedQuery);
    res.json({ items: items.map(toReceiptRowJson), nextCursor });
  });

  router.post('/invoices/from-order', requirePermission('billing.draft'), validate({ body: fromOrderSchema }), async (req, res) => {
    const { branchId } = req.user;
    const { invoice, created } = await createDraftFromOrder(branchId, req.body.orderId, actorFrom(req));
    res.status(created ? 201 : 200).json({ invoice: await jsonOf(branchId, invoice) });
  });

  router.post('/invoices', requirePermission('billing.draft'), validate({ body: blankInvoiceSchema }), async (req, res) => {
    const { branchId } = req.user;
    const invoice = await createBlankDraft(branchId, req.body.customerId, actorFrom(req));
    res.status(201).json({ invoice: await jsonOf(branchId, invoice) });
  });

  router.get('/documents/:id/pdf', async (req, res) => {
    res.json(await pdfLink(req.user.branchId, req.user, req.params.id, storage));
  });

  router.get('/invoices/:id', async (req, res) => {
    const { branchId } = req.user;
    res.json({ invoice: await jsonOf(branchId, await getInvoice(branchId, req.params.id)) });
  });

  router.put(
    '/invoices/:id',
    requirePermission('billing.draft'),
    validate({ body: versioned(invoiceDraftSchema) }),
    async (req, res) => {
      const { branchId } = req.user;
      const invoice = await updateDraft(branchId, req.params.id, req.body, req.user, actorFrom(req));
      res.json({ invoice: await jsonOf(branchId, invoice) });
    },
  );

  router.post(
    '/invoices/:id/issue',
    requirePermission('billing.issue'),
    validate({ body: issueSchema }),
    idempotent(),
    async (req, res) => {
      const invoice = await issueInvoice(req.user.branchId, req.params.id, req.body, actorFrom(req));
      await respondCommitted(req, res, 'invoice', invoice);
    },
  );

  router.post(
    '/invoices/:id/cancel',
    requirePermission('billing.cancel'),
    validate({ body: billingReasonSchema }),
    async (req, res) => {
      const { branchId } = req.user;
      const invoice = await cancelInvoice(branchId, req.params.id, req.body, actorFrom(req));
      res.json({ invoice: await jsonOf(branchId, invoice) });
    },
  );

  router.put(
    '/invoices/:id/reminders',
    requirePermission('billing.cancel'),
    validate({ body: remindersSchema }),
    async (req, res) => {
      const { branchId } = req.user;
      const invoice = await setReminderPause(branchId, req.params.id, req.body, actorFrom(req));
      res.json({ invoice: await jsonOf(branchId, invoice) });
    },
  );

  router.post(
    '/invoices/:id/credit-notes',
    requirePermission('billing.cancel'),
    validate({ body: creditNoteSchema }),
    idempotent(),
    async (req, res) => {
      const { creditNote, warnings } = await issueCreditNote(req.user.branchId, req.params.id, req.body, actorFrom(req));
      await respondCommitted(req, res, 'creditNote', creditNote, { warnings });
    },
  );

  router.get('/credit-notes/:id', async (req, res) => {
    res.json({ creditNote: toCreditNoteJson(await getCreditNote(req.user.branchId, req.params.id)) });
  });

  router.delete('/invoices/:id', requirePermission('billing.draft'), async (req, res) => {
    await deleteDraft(req.user.branchId, req.params.id);
    res.status(204).end();
  });

  router.post('/payments', requirePermission('payments.record'), validate({ body: paymentSchema }), idempotent(), async (req, res) => {
    const receipt = await recordPayment(req.user.branchId, req.body, actorFrom(req));
    await respondCommitted(req, res, 'receipt', receipt);
  });

  router.get('/payments/:id', async (req, res) => {
    const { branchId } = req.user;
    res.json({ receipt: await receiptJsonOf(branchId, await getReceipt(branchId, req.params.id)) });
  });

  router.post(
    '/payments/:id/cancel',
    requirePermission('billing.cancel'),
    validate({ body: billingReasonSchema }),
    async (req, res) => {
      const { branchId } = req.user;
      const receipt = await cancelReceipt(branchId, req.params.id, req.body, actorFrom(req));
      res.json({ receipt: await receiptJsonOf(branchId, receipt) });
    },
  );

  // Cancels a customer's opening balance and opening advance together (admin), to bring them in again.
  router.post(
    '/opening-balances/:id/cancel',
    requirePermission('billing.cancel'),
    validate({ body: versioned(billingReasonSchema) }),
    async (req, res) => {
      const doc = await cancelOpeningBalance(req.user.branchId, req.params.id, req.body, actorFrom(req));
      res.json({ openingBalance: { id: String(doc._id), status: doc.status, version: doc.__v } });
    },
  );

  router.post('/refunds', requirePermission('billing.cancel'), validate({ body: refundSchema }), idempotent(), async (req, res) => {
    const refund = await issueRefund(req.user.branchId, req.body, actorFrom(req));
    await respondCommitted(req, res, 'refund', refund);
  });

  router.get('/refunds/:id', async (req, res) => {
    const { branchId } = req.user;
    res.json({ refund: await refundJsonOf(branchId, await getRefund(branchId, req.params.id)) });
  });

  router.get('/receipt-vouchers/:id', async (req, res) => {
    res.json({ receiptVoucher: toReceiptVoucherJson(await getReceiptVoucher(req.user.branchId, req.params.id)) });
  });

  return router;
}

/**
 * "Check records" (admin), mounted at /v1/admin/audit: POST /verify starts a check in the
 * background (or answers the one already running) with 202; GET /verify answers the latest run.
 */
export function integrityRouter() {
  const router = Router();
  router.use(requirePermission('audit.verify'));

  router.post('/verify', async (req, res) => {
    const run = await startIntegrityCheck(req.user.branchId, actorFrom(req));
    res.status(202).json({ run: toIntegrityRunJson(run) });
  });

  router.get('/verify', async (req, res) => {
    res.json({ run: toIntegrityRunJson(await latestIntegrityCheck(req.user.branchId)) });
  });

  return router;
}

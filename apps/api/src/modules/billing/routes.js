import { Router } from 'express';
import {
  billingReasonSchema,
  blankInvoiceSchema,
  fromOrderSchema,
  invoiceDraftSchema,
  issueSchema,
  paymentSchema,
} from '@vs/shared/schemas/billing.js';
import { actorFrom, requirePermission } from '../../core/auth/middleware.js';
import { idempotent } from '../../core/idempotency.js';
import { validate, versioned } from '../../core/validate.js';
import { logger } from '../../logger.js';
import { toInvoiceJson, toReceiptJson, toReceiptVoucherJson } from './json.js';
import {
  cancelReceipt,
  createBlankDraft,
  createDraftFromOrder,
  deleteDraft,
  getInvoice,
  getReceipt,
  getReceiptVoucher,
  invoiceView,
  issueInvoice,
  receiptView,
  recordPayment,
  updateDraft,
} from './service.js';

const jsonOf = async (branchId, invoice) => toInvoiceJson(await invoiceView(branchId, invoice));
const receiptJsonOf = async (branchId, receipt) => toReceiptJson(await receiptView(branchId, receipt));

// How each committed document answers, and its minimal form if reading it back fails.
const ANSWERS = {
  invoice: { read: jsonOf, minimal: (d) => ({ id: String(d._id), number: d.number, status: d.status, version: d.__v }) },
  receipt: { read: receiptJsonOf, minimal: (d) => ({ id: String(d._id), number: d.number, status: d.status }) },
};

/**
 * Answers 201 for a billing write that has committed. If reading the bill back fails, the reply
 * is still a success (its id, number and status), because an error would free the
 * Idempotency-Key and the client's retry would repeat the write.
 */
async function respondCommitted(req, res, kind, doc) {
  const { read, minimal } = ANSWERS[kind];
  let body;
  try {
    body = { [kind]: await read(req.user.branchId, doc) };
  } catch (err) {
    logger.warn({ err, docId: String(doc._id), kind, requestId: req.id }, 'billing document saved; reading it back failed');
    body = { [kind]: minimal(doc) };
  }
  res.status(201).json(body);
}

export function billingRouter(_storage) {
  const router = Router();
  // Every billing route needs money.view: designers never see bills.
  router.use(requirePermission('money.view'));

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

  router.get('/receipt-vouchers/:id', async (req, res) => {
    res.json({ receiptVoucher: toReceiptVoucherJson(await getReceiptVoucher(req.user.branchId, req.params.id)) });
  });

  return router;
}

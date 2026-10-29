import { Router } from 'express';
import { blankInvoiceSchema, fromOrderSchema, invoiceDraftSchema, issueSchema } from '@vs/shared/schemas/billing.js';
import { actorFrom, requirePermission } from '../../core/auth/middleware.js';
import { idempotent } from '../../core/idempotency.js';
import { validate, versioned } from '../../core/validate.js';
import { logger } from '../../logger.js';
import { toInvoiceJson } from './json.js';
import {
  createBlankDraft,
  createDraftFromOrder,
  deleteDraft,
  getInvoice,
  invoiceView,
  issueInvoice,
  updateDraft,
} from './service.js';

const jsonOf = async (branchId, invoice) => toInvoiceJson(await invoiceView(branchId, invoice));

/**
 * Answers 201 for a billing write that has committed. If reading the bill back fails, the reply
 * is still a success (its id, number and status), because an error would free the
 * Idempotency-Key and the client's retry would repeat the write.
 */
async function respondCommitted(req, res, invoice) {
  let body;
  try {
    body = { invoice: await jsonOf(req.user.branchId, invoice) };
  } catch (err) {
    logger.warn({ err, invoiceId: String(invoice._id), requestId: req.id }, 'bill saved; reading it back failed');
    body = { invoice: { id: String(invoice._id), number: invoice.number, status: invoice.status, version: invoice.__v } };
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
      await respondCommitted(req, res, invoice);
    },
  );

  router.delete('/invoices/:id', requirePermission('billing.draft'), async (req, res) => {
    await deleteDraft(req.user.branchId, req.params.id);
    res.status(204).end();
  });

  return router;
}

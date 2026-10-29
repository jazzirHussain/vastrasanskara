import { Router } from 'express';
import { blankInvoiceSchema, fromOrderSchema, invoiceDraftSchema } from '@vs/shared/schemas/billing.js';
import { actorFrom, requirePermission } from '../../core/auth/middleware.js';
import { validate, versioned } from '../../core/validate.js';
import { toInvoiceJson } from './json.js';
import { createBlankDraft, createDraftFromOrder, deleteDraft, getInvoice, invoiceView, updateDraft } from './service.js';

const jsonOf = async (branchId, invoice) => toInvoiceJson(await invoiceView(branchId, invoice));

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

  router.delete('/invoices/:id', requirePermission('billing.draft'), async (req, res) => {
    await deleteDraft(req.user.branchId, req.params.id);
    res.status(204).end();
  });

  return router;
}

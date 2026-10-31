import { Router } from 'express';
import {
  materialChangeSchema,
  materialLinesSchema,
  movementsQuery,
  pickerQuery,
  purchaseOrderSchema,
  purchaseRequestSchema,
  receiptUndoSchema,
  receiveSchema,
  requestsQuery,
  stockCountSchema,
  stockItemPatchSchema,
  stockItemSchema,
  stockListQuery,
} from '@vs/shared/schemas/stock.js';
import { z } from 'zod';
import { actorFrom, requireAnyPermission, requirePermission } from '../../core/auth/middleware.js';
import { withTransaction } from '../../core/db.js';
import { businessRule } from '../../core/errors.js';
import { idempotent } from '../../core/idempotency.js';
import { validate, versioned } from '../../core/validate.js';
import { logger } from '../../logger.js';
import { getGarment, getOrderStatus } from '../orders/service.js';
import { getUserNames } from '../users/service.js';
import { getVendorNames } from '../vendors/service.js';
import { toItemJson, toMovementJson, toRequestJson } from './json.js';
import {
  cancelRequest,
  createRequest,
  itemsOfRequests,
  listRequests,
  markOrdered,
  receive,
  undoReceipt,
} from './purchasing.js';
import {
  changeUsedMaterials,
  countStock,
  createItem,
  garmentFacts,
  garmentMaterialsView,
  getItem,
  listItems,
  listMovements,
  lowStockItems,
  pickerItems,
  setGarmentMaterials,
  updateItem,
} from './service.js';

const OPEN_ORDER = ['active', 'on_hold'];
const materialsBody = versioned(z.strictObject({ lines: materialLinesSchema }));
const usedBody = versioned(materialChangeSchema);

const moneyOf = (req) => req.user.permissions.has('money.view');

/** Stock: admin and operations (stock.view / stock.write); money fields need money.view too. */
// `storage` checks the bill photos of a delivery.
export function stockRouter(storage) {
  const router = Router();
  const itemJson = (req, item) => toItemJson(item, { money: moneyOf(req) });

  /** The requests as JSON, with their items and vendor names. */
  async function requestsJson(req, requests) {
    const { branchId } = req.user;
    const [items, names] = await Promise.all([
      itemsOfRequests(branchId, requests),
      getVendorNames(branchId, requests.map((r) => r.vendorId)),
    ]);
    return requests.map((r) => toRequestJson(r, { names, item: items.get(String(r.stockItemId)), money: moneyOf(req) }));
  }
  const requestJson = async (req, request) => (await requestsJson(req, [request]))[0];

  router.get('/items', requirePermission('stock.view'), validate({ query: stockListQuery }), async (req, res) => {
    const { items, nextCursor } = await listItems(req.user.branchId, req.validatedQuery);
    res.json({ items: items.map((item) => itemJson(req, item)), nextCursor });
  });

  // A double tap would add the item (and its opening stock) twice.
  router.post('/items', requirePermission('stock.write'), validate({ body: stockItemSchema }), idempotent(), async (req, res) => {
    const item = await createItem(req.user.branchId, req.body, actorFrom(req));
    res.status(201).json({ item: itemJson(req, item) });
  });

  router.get('/items/:id', requirePermission('stock.view'), async (req, res) => {
    res.json({ item: itemJson(req, await getItem(req.user.branchId, req.params.id)) });
  });

  router.patch('/items/:id', requirePermission('stock.write'), validate({ body: versioned(stockItemPatchSchema) }), async (req, res) => {
    const item = await updateItem(req.user.branchId, req.params.id, req.body, actorFrom(req));
    res.json({ item: itemJson(req, item) });
  });

  router.get('/items/:id/movements', requirePermission('stock.view'), validate({ query: movementsQuery }), async (req, res) => {
    const { branchId } = req.user;
    const item = await getItem(branchId, req.params.id);
    const { items, nextCursor } = await listMovements(branchId, item._id, req.validatedQuery);
    const names = await getUserNames(items.map((m) => m.by));
    res.json({ items: items.map((m) => toMovementJson(m, { names, money: moneyOf(req) })), nextCursor });
  });

  router.post('/items/:id/count', requirePermission('stock.write'), validate({ body: stockCountSchema }), async (req, res) => {
    const item = await countStock(req.user.branchId, req.params.id, req.body, actorFrom(req));
    res.json({ item: itemJson(req, item) });
  });

  router.get('/low', requirePermission('stock.view'), async (req, res) => {
    const items = await lowStockItems(req.user.branchId);
    res.json({ items: items.map((item) => itemJson(req, item)) });
  });

  // Choosing materials: quantities only, so designers may use it too.
  router.get('/picker', requireAnyPermission('stock.view', 'stock.consume.own'), validate({ query: pickerQuery }), async (req, res) => {
    res.json({ items: await pickerItems(req.user.branchId, req.validatedQuery) });
  });

  // A garment's materials: in the user's order scope (a designer's own garments), quantities only.
  router.get(
    '/garments/:id/materials',
    requireAnyPermission('stock.view', 'stock.write', 'stock.consume.own'),
    async (req, res) => {
      const garment = await getGarment(req.user.branchId, req.user, req.params.id);
      res.json(await garmentMaterialsView(req.user.branchId, garment._id));
    },
  );

  /**
   * Changes a garment's materials in one transaction: the garment and its order's status are read
   * inside it, so a Materials ready or a cancellation at the same moment is seen on retry. Answers
   * the card.
   */
  async function onOpenGarment(req, res, change) {
    const { branchId } = req.user;
    const garmentId = await withTransaction(async (session) => {
      const garment = await getGarment(branchId, req.user, req.params.id, session);
      if (!OPEN_ORDER.includes(await getOrderStatus(branchId, garment.orderId, session))) {
        throw businessRule('INVALID_STATUS', 'This order cannot be changed in its current status');
      }
      await change(garmentFacts(garment), session);
      return garment._id;
    });
    res.json(await garmentMaterialsView(branchId, garmentId));
  }

  router.put(
    '/garments/:id/materials',
    requireAnyPermission('stock.write', 'stock.consume.own'),
    validate({ body: materialsBody }),
    (req, res) => {
      const { version, patch } = req.body;
      return onOpenGarment(req, res, (garment, session) =>
        setGarmentMaterials(req.user.branchId, garment, { version, lines: patch.lines }, actorFrom(req), session));
    },
  );

  // "Used more" / "Put back" after Materials ready: same scope as the plan.
  router.post(
    '/garments/:id/materials/used',
    requireAnyPermission('stock.write', 'stock.consume.own'),
    validate({ body: usedBody }),
    (req, res) => {
      const { version, patch } = req.body;
      return onOpenGarment(req, res, (garment, session) =>
        changeUsedMaterials(req.user.branchId, garment, { version, ...patch }, actorFrom(req), session));
    },
  );

  // --- "To buy" requests and deliveries ---------------------------------------------------------

  router.get('/requests', requirePermission('stock.view'), validate({ query: requestsQuery }), async (req, res) => {
    const { items, nextCursor } = await listRequests(req.user.branchId, req.validatedQuery);
    res.json({ items: await requestsJson(req, items), nextCursor });
  });

  router.post('/requests', requirePermission('stock.write'), validate({ body: purchaseRequestSchema }), async (req, res) => {
    const request = await createRequest(req.user.branchId, req.body, actorFrom(req));
    res.status(201).json({ request: await requestJson(req, request) });
  });

  const requestAction = (path, schema, action) =>
    router.post(`/requests/:id/${path}`, requirePermission('stock.write'), validate({ body: versioned(schema) }), async (req, res) => {
      const { request } = await action(req.user.branchId, req.params.id, req.body, actorFrom(req));
      res.json({ request: await requestJson(req, request) });
    });
  requestAction('order', purchaseOrderSchema, async (...args) => ({ request: await markOrdered(...args) }));
  requestAction('cancel', receiptUndoSchema, async (...args) => ({ request: await cancelRequest(...args) }));
  requestAction('undo', receiptUndoSchema, undoReceipt);

  /**
   * Answers 201 for a delivery that has committed. If reading it back fails the reply is still a
   * success with the ids: an error would free the Idempotency-Key and a retry would receive twice.
   */
  async function respondReceived(req, res, { request, item, expense }) {
    let body;
    try {
      body = { request: await requestJson(req, request), item: itemJson(req, item) };
    } catch (err) {
      logger.warn({ err, requestId: req.id, purchaseRequestId: String(request._id) }, 'delivery received; reading it back failed');
      body = { request: { id: String(request._id), status: request.status, version: request.__v }, item: { id: String(item._id) } };
    }
    res.status(201).json({ ...body, expense: { id: String(expense._id), number: expense.number } });
  }

  const receiving = (target) => [
    requirePermission('stock.write'),
    validate({ body: receiveSchema }),
    idempotent(),
    async (req, res) => {
      const received = await receive(req.user.branchId, target(req), req.body, actorFrom(req), { storage });
      await respondReceived(req, res, received);
    },
  ];
  router.post('/requests/:id/receive', ...receiving((req) => ({ requestId: req.params.id })));
  router.post('/items/:id/receive', ...receiving((req) => ({ stockItemId: req.params.id })));

  return router;
}

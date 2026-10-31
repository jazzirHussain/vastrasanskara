import { Router } from 'express';
import {
  materialChangeSchema,
  materialLinesSchema,
  movementsQuery,
  pickerQuery,
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
import { getGarment, getOrderStatus } from '../orders/service.js';
import { getUserNames } from '../users/service.js';
import { toItemJson, toMovementJson } from './json.js';
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
// `_storage` is for receiving deliveries (bill photos, M6 Task 5).
export function stockRouter(_storage) {
  const router = Router();
  const itemJson = (req, item) => toItemJson(item, { money: moneyOf(req) });

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

  return router;
}

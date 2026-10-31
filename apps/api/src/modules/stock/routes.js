import { Router } from 'express';
import {
  movementsQuery,
  stockCountSchema,
  stockItemPatchSchema,
  stockItemSchema,
  stockListQuery,
} from '@vs/shared/schemas/stock.js';
import { actorFrom, requirePermission } from '../../core/auth/middleware.js';
import { idempotent } from '../../core/idempotency.js';
import { validate, versioned } from '../../core/validate.js';
import { getUserNames } from '../users/service.js';
import { toItemJson, toMovementJson } from './json.js';
import {
  countStock,
  createItem,
  getItem,
  listItems,
  listMovements,
  lowStockItems,
  updateItem,
} from './service.js';

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

  return router;
}

import { Router } from 'express';
import { z } from 'zod';
import { catalogItemPatchSchema, catalogItemSchema, ITEM_KINDS } from '@vs/shared/schemas/catalog.js';
import { actorFrom, requirePermission } from '../../core/auth/middleware.js';
import { validate, versioned } from '../../core/validate.js';
import { createItem, listItems, updateItem } from './service.js';

export function toItemJson(item) {
  return {
    id: String(item._id),
    name: item.name,
    kind: item.kind,
    supplyType: item.supplyType,
    hsnSac: item.hsnSac,
    unit: item.unit,
    defaultPrice: item.defaultPrice,
    gstSlabs: item.gstSlabs.map((s) => ({ upToUnitPrice: s.upToUnitPrice, rateBp: s.rateBp })),
    garmentTypes: [...item.garmentTypes],
    chargeFor: item.chargeFor ?? null,
    active: item.active,
    version: item.__v,
  };
}

const listQuery = z.strictObject({
  active: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  kind: z.enum(ITEM_KINDS).optional(),
  q: z.string().trim().max(100).optional(),
});

export function catalogRouter() {
  const router = Router();

  router.get('/items', requirePermission('money.view'), validate({ query: listQuery }), async (req, res) => {
    res.json({ items: (await listItems(req.user.branchId, req.validatedQuery)).map(toItemJson) });
  });

  router.post('/items', requirePermission('catalog.manage'), validate({ body: catalogItemSchema }), async (req, res) => {
    res.status(201).json(toItemJson(await createItem(req.user.branchId, req.body, actorFrom(req))));
  });

  router.patch(
    '/items/:id',
    requirePermission('catalog.manage'),
    validate({ body: versioned(catalogItemPatchSchema) }),
    async (req, res) => {
      res.json(toItemJson(await updateItem(req.user.branchId, req.params.id, req.body, actorFrom(req))));
    },
  );

  return router;
}

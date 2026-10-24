import { Router } from 'express';
import { vendorPatchSchema, vendorSchema } from '@vs/shared/schemas/workshop.js';
import { actorFrom, requireAnyPermission, requirePermission } from '../../core/auth/middleware.js';
import { validate, versioned } from '../../core/validate.js';
import { activeQuery } from '../workers/routes.js';
import { createVendor, listVendors, updateVendor } from './service.js';

export function toVendorJson(v) {
  return {
    id: String(v._id),
    name: v.name,
    phone: v.phone ?? null,
    gstin: v.gstin ?? null,
    stateCode: v.stateCode,
    services: [...v.services],
    active: v.active,
    version: v.__v,
  };
}

/** Designers read the list to send stage work out; operations and admin keep it. */
export function vendorsRouter() {
  const router = Router();

  router.get(
    '/',
    requireAnyPermission('workshop.manage', 'production.update'),
    validate({ query: activeQuery }),
    async (req, res) => {
      res.json({ items: (await listVendors(req.user.branchId, req.validatedQuery)).map(toVendorJson) });
    },
  );

  router.post('/', requirePermission('workshop.manage'), validate({ body: vendorSchema }), async (req, res) => {
    res.status(201).json(toVendorJson(await createVendor(req.user.branchId, req.body, actorFrom(req))));
  });

  router.patch(
    '/:id',
    requirePermission('workshop.manage'),
    validate({ body: versioned(vendorPatchSchema) }),
    async (req, res) => {
      res.json(toVendorJson(await updateVendor(req.user.branchId, req.params.id, req.body, actorFrom(req))));
    },
  );

  return router;
}

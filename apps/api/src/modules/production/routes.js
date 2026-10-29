import { Router } from 'express';
import { z } from 'zod';
import { objectId } from '@vs/shared/schemas/common.js';
import { STAGE_KEYS } from '@vs/shared/stages.js';
import { stageActionSchema } from '@vs/shared/schemas/production.js';
import { actorFrom, requireAnyPermission, requirePermission } from '../../core/auth/middleware.js';
import { forbidden } from '../../core/errors.js';
import { validate } from '../../core/validate.js';
import { toGarmentJson } from '../orders/routes.js';
import { listGarmentEvents, listProductionGarments, productionBoard, recordStageAction } from './service.js';

// Only designers (and admin) update stages; the counter may hand a garment over, and only
// those who take orders may record a rejection (it changes what is billed).
const ACTION_PERMISSIONS = {
  picked_up: ['production.update', 'orders.write'],
  rejected: ['orders.write'],
};
const DEFAULT_PERMISSIONS = ['production.update'];

function toEventJson(e, names, user) {
  const id = (v) => (v ? String(v) : null);
  return {
    id: String(e._id),
    stage: e.stage,
    action: e.action,
    workerIds: e.workerIds.map(String),
    workers: e.workerIds.map((w) => ({ id: String(w), name: names.workers.get(String(w)) ?? '' })),
    vendor: e.vendorId ? { id: String(e.vendorId), name: names.vendors.get(String(e.vendorId)) ?? '' } : null,
    dueBackDate: e.dueBackDate ?? null,
    readyBy: e.readyBy ?? null,
    reworkStage: e.reworkStage ?? null,
    reason: e.reason ?? null,
    resolution: e.resolution ?? null,
    chargeable: Boolean(e.chargeable),
    // Paise fields are left out entirely for users without money.view.
    ...(user.permissions.has('money.view') && { chargeAmount: e.chargeAmount ?? null }),
    remarks: e.remarks,
    photoKeys: [...e.photoKeys],
    by: { id: id(e.by), name: names.users.get(String(e.by)) ?? '' },
    at: e.at,
  };
}

const flag = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();
const garmentsQuery = z.strictObject({
  stage: z.enum(STAGE_KEYS).optional(),
  late: flag,
  withVendor: flag,
  vendorId: objectId.optional(),
  designerId: objectId.optional(),
});

function toRowJson(r, user) {
  const { garment: g, order } = r;
  return {
    garment: toGarmentJson(g, user),
    order: { id: String(order._id), orderNo: order.orderNo, pickupDate: order.pickupDate, priority: order.priority },
    customer: { id: String(order.customerId), name: r.customerName },
    designer: { id: String(order.designerId), name: r.designerName },
    workingStage: r.workingStage,
    late: r.late,
    nearlyReady: r.nearlyReady,
    vendor: g.vendorWork ? { id: String(g.vendorWork.vendorId), name: r.vendorName ?? '' } : null,
  };
}

export function productionRouter() {
  const router = Router();

  router.post(
    '/actions',
    requireAnyPermission('production.update', 'orders.write'),
    validate({ body: stageActionSchema }),
    async (req, res) => {
      const needed = ACTION_PERMISSIONS[req.body.action] ?? DEFAULT_PERMISSIONS;
      if (!needed.some((p) => req.user.permissions.has(p))) throw forbidden();
      const garments = await recordStageAction(req.user.branchId, req.user, req.body, actorFrom(req));
      res.json({ garments: garments.map((g) => toGarmentJson(g, req.user)) });
    },
  );

  router.get('/board', requirePermission('orders.read.own'), async (req, res) => {
    res.json(await productionBoard(req.user.branchId, req.user));
  });

  router.get('/garments', requirePermission('orders.read.own'), validate({ query: garmentsQuery }), async (req, res) => {
    const { items, truncated } = await listProductionGarments(req.user.branchId, req.user, req.validatedQuery);
    res.json({ items: items.map((r) => toRowJson(r, req.user)), truncated });
  });

  router.get('/garments/:id/events', requirePermission('orders.read.own'), async (req, res) => {
    const { events, names } = await listGarmentEvents(req.user.branchId, req.user, req.params.id);
    res.json({ items: events.map((e) => toEventJson(e, names, req.user)) });
  });

  return router;
}

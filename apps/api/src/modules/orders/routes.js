import { Router } from 'express';
import { z } from 'zod';
import { objectId } from '@vs/shared/schemas/common.js';
import {
  addGarmentsSchema,
  garmentPatchSchema,
  garmentPlanSchema,
  orderCreateSchema,
  orderPatchSchema,
  orderReasonSchema,
  orderResumeSchema,
  ymd,
} from '@vs/shared/schemas/orders.js';
import { actorFrom, requireAnyPermission, requirePermission } from '../../core/auth/middleware.js';
import { idempotent } from '../../core/idempotency.js';
import { validate, versioned } from '../../core/validate.js';
import { addGarments, updateGarment, updateGarmentPlan } from './garments.js';
import { cancelOrder, holdOrder, resumeOrder, updateOrder } from './lifecycle.js';
import { getUserNames } from '../users/service.js';
import { createOrder, getOrder, listOrders, today } from './service.js';

const DONE = new Set(['ready', 'picked_up', 'rejected', 'cancelled']);

// The stage a garment is working towards: Order taken is complete once the order exists.
const stageToFinish = (g) => (g.currentStage === 'order_taken' ? 'materials_ready' : g.currentStage);

/** Late: the stage being worked is past its planned date, or the garment is past due and not ready. */
export function isGarmentLate(garment, order, day) {
  if (order.status !== 'active' || DONE.has(garment.status)) return false;
  const stage = stageToFinish(garment);
  const planned = garment.stagePlan.find((s) => s.stage === stage);
  if (planned?.plannedDate && !planned.skipped && planned.plannedDate < day) return true;
  return (garment.dueDate ?? order.pickupDate) < day;
}

// Paise fields are left out entirely (not nulled) for users without money.view.
const withMoney = (user, fields) => (user.permissions.has('money.view') ? fields : {});

export function toOrderSummary({ order, garments, customerName, designerName }, user, day = today()) {
  return {
    id: String(order._id),
    orderNo: order.orderNo,
    status: order.status,
    priority: order.priority,
    pickupDate: order.pickupDate,
    originalPickupDate: order.originalPickupDate,
    customer: { id: String(order.customerId), name: customerName ?? '' },
    designer: { id: String(order.designerId), name: designerName ?? '' },
    garmentCount: garments.length,
    tight: garments.some((g) => g.tightSchedule && !DONE.has(g.status)),
    late: garments.some((g) => isGarmentLate(g, order, day)),
    ...withMoney(user, { expectedBudget: order.expectedBudget ?? null }),
    version: order.__v,
  };
}

export function toGarmentJson(g, user) {
  return {
    id: String(g._id),
    garmentNo: g.garmentNo,
    index: g.index,
    type: g.type,
    description: g.description,
    fabric: g.fabric,
    designNotes: g.designNotes,
    batchId: g.batchId ? String(g.batchId) : null,
    dueDate: g.dueDate ?? null,
    originalDueDate: g.originalDueDate ?? null,
    currentStage: g.currentStage,
    stageState: g.stageState,
    status: g.status,
    tightSchedule: g.tightSchedule,
    stagePlan: g.stagePlan.map(({ stage, plannedDate, originalPlannedDate, skipped, skipReason }) => ({
      stage,
      plannedDate: plannedDate ?? null,
      originalPlannedDate: originalPlannedDate ?? null,
      skipped: Boolean(skipped),
      skipReason: skipReason ?? null,
    })),
    referenceKeys: [...g.referenceKeys],
    measurementId: g.measurementId ? String(g.measurementId) : null,
    ...withMoney(user, { agreedPrice: g.agreedPrice }),
    version: g.__v,
  };
}

export function toOrderDetail({ order, garments, customerName, designerName }, user, day = today()) {
  return {
    ...toOrderSummary({ order, garments, customerName, designerName }, user, day),
    orderDate: order.orderDate,
    occasionDate: order.occasionDate ?? null,
    notes: order.notes,
    holdHistory: order.holdHistory.map(({ from, to, reason, by }) => ({ from, to: to ?? null, reason, by: by ? String(by) : null })),
    cancellation: order.cancellation
      ? {
          reason: order.cancellation.reason,
          furthestStage: order.cancellation.furthestStage,
          refundPercent: order.cancellation.refundPercent,
          at: order.cancellation.at,
          by: order.cancellation.by ? String(order.cancellation.by) : null,
        }
      : null,
    garments: garments.map((g) => toGarmentJson(g, user)),
  };
}

/** Reads the order back in the user's scope and serializes it in full. */
export async function orderDetailResponse(req, orderId) {
  const { order, garments, customer } = await getOrder(req.user.branchId, req.user, orderId);
  const names = await getUserNames([order.designerId]);
  return toOrderDetail(
    { order, garments, customerName: customer.name, designerName: names.get(String(order.designerId)) },
    req.user,
  );
}

const listQuery = z.strictObject({
  status: z.enum(['active', 'on_hold', 'completed', 'cancelled']).optional(),
  designerId: objectId.optional(),
  priority: z.enum(['normal', 'rush']).optional(),
  pickupFrom: ymd.optional(),
  pickupTo: ymd.optional(),
  q: z.string().max(100).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export function ordersRouter() {
  const router = Router();

  router.get('/', requirePermission('orders.read.own'), validate({ query: listQuery }), async (req, res) => {
    const { items, nextCursor } = await listOrders(req.user.branchId, req.user, req.validatedQuery);
    const day = today();
    res.json({ items: items.map((item) => toOrderSummary(item, req.user, day)), nextCursor });
  });

  router.get('/:id', requirePermission('orders.read.own'), async (req, res) => {
    res.json(await orderDetailResponse(req, req.params.id));
  });

  // Each change answers with the order as the user now sees it.
  const change = (path, method, schema, action) =>
    router[method](path, requirePermission('orders.write'), validate({ body: versioned(schema) }), async (req, res) => {
      const order = await action(req.user.branchId, req.params.id, req.body, actorFrom(req));
      res.json(await orderDetailResponse(req, order._id));
    });
  change('/:id', 'patch', orderPatchSchema, updateOrder);
  change('/:id/hold', 'post', orderReasonSchema, holdOrder);
  change('/:id/resume', 'post', orderResumeSchema, resumeOrder);
  change('/:id/cancel', 'post', orderReasonSchema, cancelOrder);

  router.post(
    '/:id/garments',
    requirePermission('orders.write'),
    validate({ body: addGarmentsSchema }),
    idempotent(),
    async (req, res) => {
      const order = await addGarments(req.user.branchId, req.user, req.params.id, req.body, actorFrom(req));
      res.status(201).json(await orderDetailResponse(req, order._id));
    },
  );

  router.post(
    '/',
    requirePermission('orders.write'),
    validate({ body: orderCreateSchema }),
    idempotent(),
    async (req, res) => {
      const { order } = await createOrder(req.user.branchId, req.body, actorFrom(req));
      res.status(201).json(await orderDetailResponse(req, order._id));
    },
  );

  return router;
}

/** Garment edits and planned dates; designers may edit their own orders' garments (design side only). */
export function garmentsRouter() {
  const router = Router();
  const canEdit = requireAnyPermission('orders.write', 'production.update');

  router.patch('/:id', canEdit, validate({ body: versioned(garmentPatchSchema) }), async (req, res) => {
    const garment = await updateGarment(req.user.branchId, req.user, req.params.id, req.body, actorFrom(req));
    res.json(toGarmentJson(garment, req.user));
  });

  router.put('/:id/plan', canEdit, validate({ body: versioned(garmentPlanSchema) }), async (req, res) => {
    const garment = await updateGarmentPlan(req.user.branchId, req.user, req.params.id, req.body, actorFrom(req));
    res.json(toGarmentJson(garment, req.user));
  });

  return router;
}

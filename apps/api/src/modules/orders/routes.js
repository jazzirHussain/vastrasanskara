import { Router } from 'express';
import { z } from 'zod';
import { isGarmentLate } from '@vs/shared/production.js';
import { stageIndex } from '@vs/shared/stages.js';
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
import { logger } from '../../logger.js';
import { validate, versioned } from '../../core/validate.js';
import { addGarments, updateGarment, updateGarmentPlan } from './garments.js';
import { cancelOrder, holdOrder, resumeOrder, updateOrder } from './lifecycle.js';
import { getUserNames } from '../users/service.js';
import { createOrder, getOrder, listOrders, today } from './service.js';

const DONE = new Set(['ready', 'picked_up', 'rejected', 'cancelled']);

const planJson = (plan) =>
  plan.map(({ stage, plannedDate, originalPlannedDate, skipped, skipReason }) => ({
    stage,
    plannedDate: plannedDate ?? null,
    originalPlannedDate: originalPlannedDate ?? null,
    skipped: Boolean(skipped),
    skipReason: skipReason ?? null,
  }));

/** The garment furthest behind (lowest stage among unfinished ones), for the list's thread. */
function slowestGarment(garments) {
  const open = garments.filter((g) => !DONE.has(g.status));
  const pool = open.length ? open : garments;
  const slowest = pool.reduce((a, g) => (stageIndex(g.currentStage) < stageIndex(a.currentStage) ? g : a), pool[0]);
  if (!slowest) return null;
  const { currentStage, status, tightSchedule, stagePlan } = slowest;
  return { currentStage, status, tightSchedule, stagePlan: planJson(stagePlan) };
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
    thread: slowestGarment(garments),
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
    alterationOpen: Boolean(g.alterationOpen),
    vendorWork: g.vendorWork
      ? { vendorId: String(g.vendorWork.vendorId), dueBackDate: g.vendorWork.dueBackDate, sentOn: g.vendorWork.sentOn }
      : null,
    readyDate: g.readyDate ?? null,
    rejection: g.rejection
      ? {
          resolution: g.rejection.resolution,
          reason: g.rejection.reason,
          remakeGarmentId: g.rejection.remakeGarmentId ? String(g.rejection.remakeGarmentId) : null,
          at: g.rejection.at,
        }
      : null,
    remakeOf: g.remakeOf ? String(g.remakeOf) : null,
    stagePlan: planJson(g.stagePlan),
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
  customerId: objectId.optional(),
  priority: z.enum(['normal', 'rush']).optional(),
  pickupFrom: ymd.optional(),
  pickupTo: ymd.optional(),
  q: z.string().max(100).optional(),
  late: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * Answers 201 for a change that has committed. If reading the order back fails, the reply is
 * still a success ({ id, orderNo }), because an error would free the Idempotency-Key and the
 * client's retry would save everything a second time.
 */
async function respondCommitted(req, res, order) {
  let body;
  try {
    body = await orderDetailResponse(req, order._id);
  } catch (err) {
    logger.warn({ err, orderId: String(order._id), requestId: req.id }, 'order saved; reading it back failed');
    body = { id: String(order._id), orderNo: order.orderNo };
  }
  res.status(201).json(body);
}

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
      await respondCommitted(req, res, order);
    },
  );

  router.post(
    '/',
    requirePermission('orders.write'),
    validate({ body: orderCreateSchema }),
    idempotent(),
    async (req, res) => {
      const { order } = await createOrder(req.user.branchId, req.body, actorFrom(req));
      await respondCommitted(req, res, order);
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

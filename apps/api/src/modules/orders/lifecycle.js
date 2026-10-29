import { stageIndex } from '@vs/shared/stages.js';
import { clock } from '../../clock.js';
import { recordAudit } from '../../core/audit/service.js';
import { withTransaction } from '../../core/db.js';
import { businessRule, validationError } from '../../core/errors.js';
import { readSettings } from '../settings/service.js';
import { isActiveDesigner } from '../users/service.js';
import { Garment } from './model.js';
import { assertStatus, loadOrderForChange, replanGarment, today } from './service.js';

const OPEN = ['active', 'on_hold'];
// Garments that are finished one way or another keep their state when the order changes.
const SETTLED = new Set(['ready', 'picked_up', 'rejected', 'cancelled']);

const auditFields = (o) => ({
  designerId: String(o.designerId),
  priority: o.priority,
  expectedBudget: o.expectedBudget ?? null,
  notes: o.notes,
  occasionDate: o.occasionDate ?? null,
  pickupDate: o.pickupDate,
  status: o.status,
});

async function saveOrder(order, action, before, actor, session) {
  order.updatedBy = actor.userId;
  order.increment();
  await order.save({ session });
  await recordAudit(
    { branchId: order.branchId, entityType: 'order', entityId: order._id, action, before, after: auditFields(order), actor },
    session,
  );
}

async function saveGarments(garments, actor, session) {
  for (const g of garments) {
    if (!g.isModified()) continue;
    g.updatedBy = actor.userId;
    g.increment();
    await g.save({ session });
  }
}

/**
 * Changes order details. A new pickup date keeps the original and re-plans every open garment
 * that follows the pickup date (no due date of its own).
 */
export async function updateOrder(branchId, orderId, { version, patch }, actor) {
  if (patch.designerId && !(await isActiveDesigner(branchId, patch.designerId))) {
    throw validationError([{ path: 'designerId', message: 'Choose an active designer' }]);
  }
  if (patch.pickupDate && patch.pickupDate < today()) {
    throw businessRule('PICKUP_IN_PAST', 'The pickup date cannot be in the past');
  }
  const settings = await readSettings(branchId);
  return withTransaction(async (session) => {
    const order = await loadOrderForChange(branchId, orderId, version, session);
    assertStatus(order, OPEN);
    const before = auditFields(order);

    if (patch.pickupDate && patch.pickupDate !== order.pickupDate) {
      const garments = (await Garment.find({ orderId: order._id }).session(session)).filter((g) => !SETTLED.has(g.status));
      if (garments.some((g) => g.dueDate && g.dueDate > patch.pickupDate)) {
        throw businessRule('DUE_AFTER_PICKUP', 'A garment cannot be due after the pickup date');
      }
      for (const g of garments.filter((g) => !g.dueDate)) replanGarment(g, { dueDate: patch.pickupDate, settings });
      await saveGarments(garments, actor, session);
    }

    order.set(patch);
    await saveOrder(order, 'update', before, actor, session);
    return order.toObject();
  });
}

/**
 * Moves an order's pickup date (the original is kept) and audits it like any order change.
 * Used when an alteration is promised after the current pickup date.
 */
export async function movePickupDate(order, pickupDate, exceptGarmentId, actor, session) {
  // Other open garments that follow the pickup date keep the date they were promised.
  const others = await Garment.find({
    orderId: order._id,
    _id: { $ne: exceptGarmentId },
    status: { $in: ['in_progress', 'ready'] },
    dueDate: null,
  }).session(session);
  for (const g of others) {
    g.dueDate = order.pickupDate;
    g.originalDueDate ??= order.pickupDate;
  }
  await saveGarments(others, actor, session);
  const before = auditFields(order);
  order.pickupDate = pickupDate;
  await saveOrder(order, 'update', before, actor, session);
}

/** Puts an active order on hold (late checks pause while it is held). */
export function holdOrder(branchId, orderId, { version, patch: { reason } }, actor) {
  return withTransaction(async (session) => {
    const order = await loadOrderForChange(branchId, orderId, version, session);
    assertStatus(order, ['active']);
    const before = auditFields(order);
    order.status = 'on_hold';
    order.holdHistory.push({ from: today(), to: null, reason, by: actor.userId });
    await saveOrder(order, 'hold', before, actor, session);
    return order.toObject();
  });
}

const closeOpenHold = (order) => {
  const open = order.holdHistory.find((h) => h.to === null);
  if (open) open.to = today();
};

/** Resumes a held order, closing its open hold entry. */
export function resumeOrder(branchId, orderId, { version }, actor) {
  return withTransaction(async (session) => {
    const order = await loadOrderForChange(branchId, orderId, version, session);
    assertStatus(order, ['on_hold']);
    const before = auditFields(order);
    order.status = 'active';
    closeOpenHold(order);
    await saveOrder(order, 'resume', before, actor, session);
    return order.toObject();
  });
}

/**
 * Brings the order's status in line with its garments after a stage change: an active order
 * whose garments are all settled, with at least one picked up, is completed; a completed order
 * with a garment back in work (an alteration after pickup) is active again. Both are audited.
 */
export async function settleOrderAfterStageChange(order, actor, session) {
  const garments = await Garment.find({ orderId: order._id }, { status: 1 }).session(session).lean();
  const inWork = garments.some((g) => g.status === 'in_progress' || g.status === 'ready');
  const before = auditFields(order);
  if (order.status === 'active' && !inWork && garments.some((g) => g.status === 'picked_up')) {
    order.status = 'completed';
    await saveOrder(order, 'complete', before, actor, session);
  } else if (order.status === 'completed' && inWork) {
    order.status = 'active';
    await saveOrder(order, 'reopen', before, actor, session);
  }
}

/**
 * The refund percent for an order whose garments reached `furthestStage`: the first schedule
 * row (in stage order) whose `uptoStage` is at or after it, else 0.
 */
export function refundPercentFor(schedule, furthestStage) {
  const reached = stageIndex(furthestStage);
  const row = [...schedule]
    .sort((a, b) => stageIndex(a.uptoStage) - stageIndex(b.uptoStage))
    .find((r) => stageIndex(r.uptoStage) >= reached);
  return row?.refundPercent ?? 0;
}

/**
 * Cancels an active or held order: records the furthest stage any garment reached and the
 * refund percent from the schedule (the amount is worked out against payments in billing),
 * and cancels every unfinished garment.
 */
export async function cancelOrder(branchId, orderId, { version, patch: { reason } }, actor) {
  const settings = await readSettings(branchId);
  return withTransaction(async (session) => {
    const order = await loadOrderForChange(branchId, orderId, version, session);
    assertStatus(order, OPEN);
    const before = auditFields(order);
    const garments = await Garment.find({ orderId: order._id }).session(session);
    const furthestStage = garments.reduce(
      (furthest, g) => (stageIndex(g.currentStage) > stageIndex(furthest) ? g.currentStage : furthest),
      'order_taken',
    );
    for (const g of garments) if (!SETTLED.has(g.status)) g.status = 'cancelled';
    await saveGarments(garments, actor, session);

    order.status = 'cancelled';
    closeOpenHold(order);
    order.cancellation = {
      reason,
      furthestStage,
      refundPercent: refundPercentFor(settings.cancellationRefundSchedule, furthestStage),
      at: clock.now(),
      by: actor.userId,
    };
    await saveOrder(order, 'cancel', before, actor, session);
    return order.toObject();
  });
}

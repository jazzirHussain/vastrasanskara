import mongoose from 'mongoose';
import { stageIndex } from '@vs/shared/stages.js';
import { recordAudit } from '../../core/audit/service.js';
import { withTransaction } from '../../core/db.js';
import { businessRule, conflict, forbidden, notFound } from '../../core/errors.js';
import { readSettings } from '../settings/service.js';
import { Garment, Order } from './model.js';
import { assertStatus, buildGarments, checkGarmentInputs, orderScope, replanGarment, today } from './service.js';

const OPEN = ['active', 'on_hold'];
// Designers (production.update without orders.write) may change only these.
const DESIGNER_FIELDS = new Set(['designNotes', 'referenceKeys']);
const AUDITED = ['description', 'fabric', 'designNotes', 'agreedPrice', 'dueDate', 'referenceKeys', 'measurementId'];

const auditFields = (g) =>
  Object.fromEntries(AUDITED.map((f) => [f, f === 'measurementId' ? (g[f] ? String(g[f]) : null) : (g[f] ?? null)]));
const planDates = (g) => Object.fromEntries(g.stagePlan.map((s) => [s.stage, s.plannedDate ?? null]));

/** The garment and its order at `version`, within the user's order scope (404, then 409). */
async function loadGarmentForChange(branchId, user, garmentId, version, session) {
  if (!mongoose.isValidObjectId(garmentId)) throw notFound();
  const garment = await Garment.findOne({ _id: garmentId, branchId }).session(session);
  if (!garment) throw notFound();
  const order = await Order.findOne({ _id: garment.orderId, branchId, ...orderScope(user) }).session(session);
  if (!order) throw notFound();
  if (garment.__v !== version) throw conflict();
  return { garment, order };
}

async function saveGarment(garment, action, { before, after }, actor, session) {
  garment.updatedBy = actor.userId;
  garment.increment();
  await garment.save({ session });
  await recordAudit(
    { branchId: garment.branchId, entityType: 'garment', entityId: garment._id, action, before, after, actor },
    session,
  );
}

/**
 * Edits a garment. A new due date (or null, to follow the pickup date again) keeps the original
 * and re-plans the stages ahead. Without orders.write only design notes and photos may change.
 */
export async function updateGarment(branchId, user, garmentId, { version, patch }, actor) {
  if (!user.permissions.has('orders.write') && Object.keys(patch).some((f) => !DESIGNER_FIELDS.has(f))) {
    throw forbidden();
  }
  const settings = await readSettings(branchId);
  return withTransaction(async (session) => {
    const { garment, order } = await loadGarmentForChange(branchId, user, garmentId, version, session);
    assertStatus(order, OPEN);
    await checkGarmentInputs(
      branchId,
      {
        customerId: order.customerId,
        pickupDate: order.pickupDate,
        garments: [{ type: garment.type, referenceKeys: patch.referenceKeys ?? [], measurementId: patch.measurementId, dueDate: patch.dueDate }],
      },
      settings,
      'garment',
    );
    const before = auditFields(garment);
    if (patch.dueDate !== undefined && patch.dueDate !== garment.dueDate) {
      garment.originalDueDate ??= garment.dueDate ?? order.originalPickupDate;
      replanGarment(garment, { dueDate: patch.dueDate ?? order.pickupDate, settings });
    }
    garment.set(patch);
    await saveGarment(garment, 'update', { before, after: auditFields(garment) }, actor, session);
    return garment.toObject();
  });
}

/**
 * Sets planned dates by hand. Dates must lie between today and the garment's due date
 * and follow the stage order; the original dates are kept. A plan fixed this way is no longer
 * flagged tight.
 */
export function updateGarmentPlan(branchId, user, garmentId, { version, patch: { changes } }, actor) {
  return withTransaction(async (session) => {
    const { garment, order } = await loadGarmentForChange(branchId, user, garmentId, version, session);
    assertStatus(order, OPEN);
    const due = garment.dueDate ?? order.pickupDate;
    const before = planDates(garment);
    for (const { stage, plannedDate } of changes) {
      if (plannedDate < today() || plannedDate > due) {
        throw businessRule('PLAN_OUT_OF_RANGE', 'Planned dates must fall between today and the due date');
      }
      garment.stagePlan[stageIndex(stage)].plannedDate = plannedDate;
    }
    const dates = garment.stagePlan.filter((s) => s.plannedDate && !s.skipped).map((s) => s.plannedDate);
    if (dates.some((date, i) => i > 0 && date < dates[i - 1])) {
      throw businessRule('STAGE_ORDER_VIOLATION', 'Planned dates must follow the stage order');
    }
    garment.tightSchedule = false;
    await saveGarment(garment, 'plan', { before, after: planDates(garment) }, actor, session);
    return garment.toObject();
  });
}

/** Adds garments to an open order, numbered after the existing ones. */
export async function addGarments(branchId, user, orderId, { garments }, actor) {
  if (!mongoose.isValidObjectId(orderId)) throw notFound();
  const settings = await readSettings(branchId);
  return withTransaction(async (session) => {
    const order = await Order.findOne({ _id: orderId, branchId, ...orderScope(user) }).session(session);
    if (!order) throw notFound();
    assertStatus(order, OPEN);
    await checkGarmentInputs(branchId, { customerId: order.customerId, pickupDate: order.pickupDate, garments }, settings);
    const last = await Garment.findOne({ orderId: order._id }).sort({ index: -1 }).session(session).lean();
    const docs = await Garment.create(
      buildGarments({ branchId, order, garments, startIndex: (last?.index ?? 0) + 1, settings, actor }),
      { session, ordered: true },
    );
    await recordAudit(
      {
        branchId,
        entityType: 'order',
        entityId: order._id,
        action: 'add_garments',
        changes: [{ path: 'garments', before: null, after: docs.map((g) => g.garmentNo) }],
        actor,
      },
      session,
    );
    return order.toObject();
  });
}

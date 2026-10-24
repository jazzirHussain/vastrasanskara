import mongoose from 'mongoose';
import { applyStageAction, isGarmentLate, isNearlyReady, ProductionRuleError, workingStage } from '@vs/shared/production.js';
import { STAGE_KEYS, STAGES } from '@vs/shared/stages.js';
import { clock } from '../../clock.js';
import { recordAudit } from '../../core/audit/service.js';
import { withTransaction } from '../../core/db.js';
import { businessRule, forbidden, validationError } from '../../core/errors.js';
import { emit } from '../../core/notify/emit.js';
import { getCustomerNames } from '../customers/service.js';
import { loadGarmentsForStageAction, remakeGarment, saveStageChange } from '../orders/garments.js';
import { settleOrderAfterStageChange } from '../orders/lifecycle.js';
import { getGarment, isOrderInScope, listOpenGarments, today } from '../orders/service.js';
import { getUserNames } from '../users/service.js';
import { getVendorNames, isActiveVendor } from '../vendors/service.js';
import { areActiveWorkers, getWorkerNames } from '../workers/service.js';
import { StageEvent } from './model.js';
import './notifications.js';

const { ObjectId } = mongoose.Types;

// Inputs every event keeps as given (the rest comes from the production rules).
const EVENT_FIELDS = ['workerIds', 'remarks', 'photoKeys', 'reason', 'resolution', 'chargeable', 'chargeAmount'];
const stageLabel = (key) => STAGES.find((s) => s.key === key)?.label ?? key;

/** Workers and vendor must be active ones of the branch; photos must be this branch's stage photos. */
async function checkInputs(branchId, user, input) {
  if (input.chargeAmount != null && !user.permissions.has('money.view')) throw forbidden();
  const issues = [];
  if (input.workerIds.length && !(await areActiveWorkers(branchId, input.workerIds))) {
    issues.push({ path: 'workerIds', message: 'Choose active workers' });
  }
  if (input.vendorId && !(await isActiveVendor(branchId, input.vendorId))) {
    issues.push({ path: 'vendorId', message: 'Choose an active vendor' });
  }
  for (const [i, key] of input.photoKeys.entries()) {
    if (!key.startsWith(`${branchId}/stage_photo/`)) issues.push({ path: `photoKeys.${i}`, message: 'Not a stage photo upload' });
  }
  if (issues.length) throw validationError(issues);
}

function applyRules(garment, input, day) {
  try {
    return applyStageAction(garment, input, { today: day });
  } catch (err) {
    if (err instanceof ProductionRuleError) throw businessRule(err.code, err.message);
    throw err;
  }
}

/**
 * The immediate notifications a saved stage event sets off, queued in the same transaction:
 * reaching Trials and fittings, a failed QC, and a garment ready for pickup. `refId` is the
 * stage event, so returning to a stage later notifies again.
 */
async function notifyStageEvent({ garment, order, previousStage, changes, event, customerName }, session) {
  const notices = [];
  if (changes.currentStage === 'trials_fittings' && previousStage !== 'trials_fittings') notices.push('garment.fitting_reached');
  if (event.action === 'qc_fail') notices.push('qc.failed');
  if (changes.status === 'ready') notices.push('garment.ready_for_pickup');
  for (const name of notices) {
    const vars = {
      garmentNo: garment.garmentNo,
      description: garment.description,
      customerName,
      orderNo: order.orderNo,
      link: `/orders/${order._id}`,
      ...(name === 'qc.failed' && { stage: stageLabel(event.stage), reworkStage: stageLabel(event.reworkStage), remarks: event.remarks }),
    };
    await emit(
      name,
      {
        branchId: order.branchId,
        refId: String(event._id),
        data: { designerId: String(order.designerId), customerId: String(order.customerId) },
        vars,
      },
      { session },
    );
  }
}

/**
 * A rejected garment is never charged; the owner's resolution is kept on it, and a remake is a
 * new garment on the same order. Returns the `rejection` to save with the garment.
 */
async function resolveRejection(item, input, actor, session) {
  const remake = input.resolution === 'remake' ? await remakeGarment(item, actor, session) : null;
  await recordAudit(
    {
      branchId: item.garment.branchId,
      entityType: 'garment',
      entityId: item.garment._id,
      action: 'reject',
      before: { status: item.garment.status, resolution: null },
      after: { status: 'rejected', resolution: input.resolution },
      actor,
    },
    session,
  );
  return { resolution: input.resolution, reason: input.reason, remakeGarmentId: remake?._id ?? null, at: clock.now(), by: actor.userId };
}

/**
 * Records one stage action on one or more garments (a bulk action) in one transaction: every
 * garment's new state and one stage event each, or nothing. Orders whose garments are now all
 * settled are completed (or reopened by an alteration). Returns the saved garments.
 */
export async function recordStageAction(branchId, user, input, actor) {
  await checkInputs(branchId, user, input);
  const fields = Object.fromEntries(EVENT_FIELDS.filter((f) => input[f] !== undefined).map((f) => [f, input[f]]));

  return withTransaction(async (session) => {
    const day = today();
    const at = clock.now();
    const loaded = await loadGarmentsForStageAction(branchId, user, input.garments, session, { action: input.action });
    const bulkId = loaded.length > 1 ? new ObjectId() : null;
    const events = [];
    const applied = [];
    for (const item of loaded) {
      const previousStage = item.garment.currentStage;
      const { changes, event } = applyRules(item.garment, input, day);
      applied.push({ ...item, previousStage, changes });
      if (input.action === 'rejected') changes.rejection = await resolveRejection(item, input, actor, session);
      await saveStageChange(item, changes, actor, session);
      events.push({
        ...fields,
        ...event,
        branchId,
        orderId: item.order._id,
        garmentId: item.garment._id,
        by: actor.userId,
        at,
        bulkId,
      });
    }
    const saved = await StageEvent.create(events, { session, ordered: true });
    const customerNames = await getCustomerNames(branchId, loaded.map(({ order }) => order.customerId));
    for (const [i, item] of applied.entries()) {
      const customerName = customerNames.get(String(item.order.customerId)) ?? '';
      await notifyStageEvent({ ...item, event: saved[i], customerName }, session);
    }
    const orders = new Map(loaded.map(({ order }) => [String(order._id), order]));
    for (const order of orders.values()) await settleOrderAfterStageChange(order, actor, session);
    return loaded.map(({ garment }) => garment.toObject());
  });
}

/** A garment's stage events, oldest first, with worker, vendor and user names. 404 out of scope. */
export async function listGarmentEvents(branchId, user, garmentId) {
  const garment = await getGarment(branchId, user, garmentId);
  const events = await StageEvent.find({ branchId, garmentId: garment._id }).sort({ at: 1, _id: 1 }).lean();
  const [workers, vendors, users] = await Promise.all([
    getWorkerNames(branchId, events.flatMap((e) => e.workerIds)),
    getVendorNames(branchId, events.map((e) => e.vendorId)),
    getUserNames(events.map((e) => e.by)),
  ]);
  return { events, names: { workers, vendors, users } };
}

/**
 * Whether the user may read a stage photo: its event's order is in their scope. A photo not
 * yet attached to an event is readable by those who may upload one.
 */
export async function canReadStagePhoto(user, key) {
  const event = await StageEvent.findOne({ branchId: user.branchId, photoKeys: key }, { orderId: 1 }).lean();
  if (!event) return user.permissions.has('production.update') || user.permissions.has('orders.write');
  return isOrderInScope(user, event.orderId);
}

// The stages a garment can be worked on or wait at: Materials ready through Ready for pickup.
const BOARD_STAGES = STAGE_KEYS.slice(1, 13);

/** Open garments in the user's scope per working stage: in house, with vendors, and late. */
export async function productionBoard(branchId, user) {
  const { items } = await listOpenGarments(branchId, user);
  const day = today();
  const stages = new Map(BOARD_STAGES.map((stage) => [stage, { stage, inHouse: 0, withVendor: 0, late: 0 }]));
  for (const { garment, order } of items) {
    const count = stages.get(workingStage(garment));
    if (garment.stageState === 'with_vendor') count.withVendor += 1;
    else count.inHouse += 1;
    if (isGarmentLate(garment, order, day)) count.late += 1;
  }
  return { stages: [...stages.values()] };
}

/**
 * Open garments in the user's scope, filtered, by due date then garment number. Each item adds
 * workingStage, late, nearlyReady and the vendor (name) holding it.
 */
export async function listProductionGarments(branchId, user, { stage, late, withVendor, vendorId, designerId } = {}) {
  const { items, truncated } = await listOpenGarments(branchId, user, { designerId });
  const day = today();
  const rows = items
    .map((item) => ({
      ...item,
      workingStage: workingStage(item.garment),
      late: isGarmentLate(item.garment, item.order, day),
      nearlyReady: isNearlyReady(item.garment),
    }))
    .filter(
      (r) =>
        (!stage || r.workingStage === stage) &&
        (late === undefined || r.late === late) &&
        (withVendor === undefined || (r.garment.stageState === 'with_vendor') === withVendor) &&
        (!vendorId || String(r.garment.vendorWork?.vendorId) === vendorId),
    )
    .sort((a, b) => {
      const due = (r) => r.garment.dueDate ?? r.order.pickupDate;
      return due(a).localeCompare(due(b)) || a.garment.garmentNo.localeCompare(b.garment.garmentNo);
    });
  const vendors = await getVendorNames(branchId, rows.map((r) => r.garment.vendorWork?.vendorId));
  return { items: rows.map((r) => ({ ...r, vendorName: vendors.get(String(r.garment.vendorWork?.vendorId)) ?? null })), truncated };
}

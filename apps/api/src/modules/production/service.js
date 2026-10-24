import mongoose from 'mongoose';
import { applyStageAction, ProductionRuleError } from '@vs/shared/production.js';
import { clock } from '../../clock.js';
import { withTransaction } from '../../core/db.js';
import { businessRule, forbidden, validationError } from '../../core/errors.js';
import { loadGarmentsForStageAction, saveStageChange } from '../orders/garments.js';
import { getGarment, isOrderInScope, today } from '../orders/service.js';
import { getUserNames } from '../users/service.js';
import { getVendorNames, isActiveVendor } from '../vendors/service.js';
import { areActiveWorkers, getWorkerNames } from '../workers/service.js';
import { StageEvent } from './model.js';

const { ObjectId } = mongoose.Types;

// Inputs every event keeps as given (the rest comes from the production rules).
const EVENT_FIELDS = ['workerIds', 'remarks', 'photoKeys', 'reason', 'resolution', 'chargeable', 'chargeAmount'];
// Not recorded until alteration, pickup and rejection are built.
const NOT_YET = new Set(['alteration', 'picked_up', 'rejected']);

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
 * Records one stage action on one or more garments (a bulk action) in one transaction: every
 * garment's new state and one stage event each, or nothing. Returns the saved garments.
 */
export async function recordStageAction(branchId, user, input, actor) {
  if (NOT_YET.has(input.action)) throw businessRule('ACTION_NOT_ALLOWED', 'That step is not possible yet');
  await checkInputs(branchId, user, input);
  const fields = Object.fromEntries(EVENT_FIELDS.filter((f) => input[f] !== undefined).map((f) => [f, input[f]]));

  return withTransaction(async (session) => {
    const day = today();
    const at = clock.now();
    const loaded = await loadGarmentsForStageAction(branchId, user, input.garments, session, { action: input.action });
    const bulkId = loaded.length > 1 ? new ObjectId() : null;
    const events = [];
    for (const item of loaded) {
      const { changes, event } = applyRules(item.garment, input, day);
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
    await StageEvent.create(events, { session, ordered: true });
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

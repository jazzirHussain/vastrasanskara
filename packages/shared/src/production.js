// Production rules: which stage action a garment accepts in which state, and the state that
// follows. Pure, so the API decides with it and the web offers only what the API will accept.
import { addDaysYmd } from './fy.js';
import { WORK_STAGES } from './planning.js';
import { STAGE_KEYS, stageIndex } from './stages.js';

export const QC_STAGES = Object.freeze(['quality_check', 'final_qc']);

export const ACTIONS = Object.freeze([
  'start',
  'complete',
  'skip',
  'qc_pass',
  'qc_fail',
  'sent_to_vendor',
  'returned_from_vendor',
  'rework',
  'alteration',
  'rejected',
  'picked_up',
]);

// These act on the garment as it stands (`stage` = currentStage), not on the stage being worked.
const AT_CURRENT = new Set(['alteration', 'picked_up', 'rejected']);
const DONE = new Set(['ready', 'picked_up', 'rejected', 'cancelled']);
const isWorkStage = (stage) => WORK_STAGES.includes(stage);
const isQcStage = (stage) => QC_STAGES.includes(stage);
const planEntry = (garment, stage) => garment.stagePlan.find((s) => s.stage === stage);

export class ProductionRuleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProductionRuleError';
    this.code = code;
  }
}

/** The stage a garment is working on: Order taken is complete once the order exists. */
export const workingStage = (garment) => (garment.currentStage === 'order_taken' ? 'materials_ready' : garment.currentStage);

/** The first stage after `fromStage` that is not skipped (Ready for pickup never is). */
export function nextStage(garment, fromStage) {
  for (const stage of STAGE_KEYS.slice(stageIndex(fromStage) + 1)) {
    if (stage === 'ready_for_pickup' || !planEntry(garment, stage)?.skipped) return stage;
  }
  return 'ready_for_pickup';
}

/** Late: the working stage is past its planned date, or the garment is past due and not ready. */
export function isGarmentLate(garment, order, today) {
  if (order.status !== 'active' || DONE.has(garment.status)) return false;
  const planned = planEntry(garment, workingStage(garment));
  if (planned?.plannedDate && !planned.skipped && planned.plannedDate < today) return true;
  return (garment.dueDate ?? order.pickupDate) < today;
}

/** Nearly ready (for pickup-risk alerts): at Final quality check or later. */
export function isNearlyReady(garment) {
  if (garment.status === 'ready' || garment.status === 'picked_up') return true;
  return stageIndex(workingStage(garment)) >= stageIndex('final_qc');
}

/**
 * Pickup at risk: the garment is in progress, its order's pickup falls today or within the next
 * three days, and the garment is not yet nearly ready.
 */
export function isPickupAtRisk({ garment, order }, today) {
  return (
    garment.status === 'in_progress' &&
    order.pickupDate >= today &&
    order.pickupDate <= addDaysYmd(today, 3) &&
    !isNearlyReady(garment)
  );
}

/**
 * Applies a stage action to a garment's state. `input` is a parsed stage action (`action`,
 * `stage`, and what the action needs). Returns `{ changes, event }`: the garment fields to set
 * (`skip` names a plan entry to mark skipped) and the stage event's production fields. Throws
 * ProductionRuleError when the garment does not accept the action.
 */
export function applyStageAction(garment, input, { today }) {
  const { action, stage } = input;
  const fail = (code, message) => {
    throw new ProductionRuleError(code, message);
  };
  const notAllowed = () => fail('ACTION_NOT_ALLOWED', 'That step is not possible for this garment right now');
  const working = workingStage(garment);

  if (stage !== (AT_CURRENT.has(action) ? garment.currentStage : working)) {
    fail('STAGE_ORDER_VIOLATION', 'This garment is not at that stage');
  }
  if (garment.stageState === 'with_vendor' && action !== 'returned_from_vendor') {
    fail('WITH_VENDOR', 'This garment is with a vendor');
  }

  const inProgress = garment.status === 'in_progress';
  const event = { stage, action };
  const advance = () => {
    const next = nextStage(garment, working);
    return next === 'ready_for_pickup'
      ? { currentStage: next, stageState: 'pending', status: 'ready', readyDate: today }
      : { currentStage: next, stageState: 'pending' };
  };

  switch (action) {
    case 'start':
      if (!inProgress || garment.stageState !== 'pending' || !isWorkStage(working)) notAllowed();
      return { changes: { currentStage: working, stageState: 'in_progress' }, event };
    case 'complete':
      if (!inProgress || !isWorkStage(working) || isQcStage(working)) notAllowed();
      return { changes: advance(), event };
    case 'qc_pass':
      if (!inProgress || !isQcStage(working)) notAllowed();
      return { changes: advance(), event };
    case 'skip':
      if (!inProgress || !isWorkStage(working)) notAllowed();
      return { changes: { ...advance(), skip: { stage: working, reason: input.reason } }, event };
    case 'qc_fail':
    case 'rework': {
      const allowed =
        action === 'qc_fail'
          ? inProgress && isQcStage(working)
          : (inProgress && isWorkStage(working)) || garment.status === 'ready';
      if (!allowed) notAllowed();
      const target = input.reworkStage;
      if (!isWorkStage(target) || stageIndex(target) >= stageIndex(working) || planEntry(garment, target)?.skipped) {
        fail('REWORK_TARGET_INVALID', 'Choose an earlier stage that was not skipped');
      }
      return {
        changes: { currentStage: target, stageState: 'pending', status: 'in_progress', readyDate: null },
        event: { ...event, reworkStage: target },
      };
    }
    case 'sent_to_vendor': {
      if (!inProgress || !isWorkStage(working) || !(input.dueBackDate >= today)) notAllowed();
      const { vendorId, dueBackDate } = input;
      return {
        changes: { currentStage: working, stageState: 'with_vendor', vendorWork: { vendorId, dueBackDate, sentOn: today } },
        event: { ...event, vendorId, dueBackDate },
      };
    }
    case 'returned_from_vendor':
      if (garment.stageState !== 'with_vendor') notAllowed();
      return { changes: { stageState: 'in_progress', vendorWork: null }, event };
    case 'alteration': {
      const pickedUp = garment.status === 'picked_up';
      const allowed =
        pickedUp || garment.status === 'ready' || (inProgress && stageIndex(working) > stageIndex('tailors'));
      if (!allowed) notAllowed();
      return {
        changes: {
          currentStage: 'tailors',
          stageState: 'pending',
          status: 'in_progress',
          readyDate: null,
          ...(pickedUp && { alterationOpen: true }),
        },
        event: { ...event, readyBy: input.readyBy },
      };
    }
    case 'picked_up':
      if (garment.status !== 'ready') notAllowed();
      return { changes: { currentStage: 'picked_up', status: 'picked_up', alterationOpen: false }, event };
    case 'rejected':
      if (!inProgress && garment.status !== 'ready') notAllowed();
      return { changes: { status: 'rejected' }, event };
    default:
      return notAllowed();
  }
}

// The earliest stage a rework could return to, if any.
function firstReworkTarget(garment) {
  const working = stageIndex(workingStage(garment));
  return WORK_STAGES.find((s) => stageIndex(s) < working && !planEntry(garment, s)?.skipped);
}

/** The actions the garment accepts now (order status and permissions are the caller's). */
export function allowedActions(garment) {
  const probe = (action) => ({
    action,
    stage: AT_CURRENT.has(action) ? garment.currentStage : workingStage(garment),
    reason: '-',
    vendorId: '-',
    dueBackDate: '9999-12-31',
    reworkStage: firstReworkTarget(garment),
  });
  return ACTIONS.filter((action) => {
    try {
      applyStageAction(garment, probe(action), { today: '0000-01-01' });
      return true;
    } catch (err) {
      if (err instanceof ProductionRuleError) return false;
      throw err;
    }
  });
}

// What a user may do next with a garment, and how each step is named. The rules come from
// the shared production module, so the app offers exactly what the API accepts.
import { WORK_STAGES } from '@vs/shared/planning.js';
import { allowedActions, workingStage } from '@vs/shared/production.js';
import { STAGES, stageIndex } from '@vs/shared/stages.js';

export const stageName = (key) => STAGES.find((s) => s.key === key)?.label ?? key;

// These act on the garment as it stands, not on the stage being worked.
const AT_CURRENT = new Set(['alteration', 'picked_up', 'rejected']);

/** The `stage` an action names for the API. */
export const actingStage = (garment, action) => (AT_CURRENT.has(action) ? garment.currentStage : workingStage(garment));

export function actionLabel(action, garment) {
  const stage = stageName(workingStage(garment)).toLowerCase();
  const labels = {
    start: `Start ${stage}`,
    complete: `Mark ${stage} done`,
    qc_pass: `Mark ${stage} done`,
    skip: `Skip ${stage}`,
    qc_fail: 'QC failed',
    sent_to_vendor: 'Send to vendor',
    returned_from_vendor: 'Back from vendor',
    rework: 'Rework',
    alteration: 'Alteration',
    rejected: 'Client rejected',
    picked_up: 'Hand over to client',
  };
  return labels[action];
}

// Designers (and admin) update stages; the counter hands garments over; rejections are the
// owner's call. Same as the API.
const PERMISSIONS = { picked_up: ['production.update', 'orders.write'], rejected: ['orders.write'] };

/** The steps this user can take with the garment on this order. */
export function actionsFor(order, garment, can) {
  const orderAccepts = (action) => order.status === 'active' || (order.status === 'completed' && action === 'alteration');
  return allowedActions(garment).filter(
    (action) => orderAccepts(action) && (PERMISSIONS[action] ?? ['production.update']).some((p) => can(p)),
  );
}

const PRIMARY = ['returned_from_vendor', 'complete', 'qc_pass', 'picked_up'];

/** The natural next step, shown as the main button. */
export const primaryAction = (actions) => PRIMARY.find((a) => actions.includes(a)) ?? null;

/** Stages a rework can return the garment to: earlier work stages that were not skipped. */
export function reworkTargets(garment) {
  const working = stageIndex(workingStage(garment));
  const skipped = new Set(garment.stagePlan.filter((s) => s.skipped).map((s) => s.stage));
  return WORK_STAGES.filter((s) => stageIndex(s) < working && !skipped.has(s));
}

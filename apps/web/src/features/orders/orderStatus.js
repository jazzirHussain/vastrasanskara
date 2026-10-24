import { stageIndex } from '@vs/shared/stages.js';

const DONE = new Set(['ready', 'picked_up', 'rejected', 'cancelled']);

/** Active or on hold: the order can still change. */
export const isOpen = (order) => order.status === 'active' || order.status === 'on_hold';

/** Same rule as the server: the stage being worked is past its plan, or the garment is past due. */
export function isGarmentLate(garment, order, today) {
  if (order.status !== 'active' || DONE.has(garment.status)) return false;
  const stage = garment.currentStage === 'order_taken' ? 'materials_ready' : garment.currentStage;
  const planned = garment.stagePlan.find((s) => s.stage === stage);
  if (planned?.plannedDate && !planned.skipped && planned.plannedDate < today) return true;
  return (garment.dueDate ?? order.pickupDate) < today;
}

/** The furthest stage any garment reached, as the server records it on cancellation. */
export function furthestStage(garments) {
  return garments.reduce((far, g) => (stageIndex(g.currentStage) > stageIndex(far) ? g.currentStage : far), 'order_taken');
}

/** The refund percent the cancellation schedule gives for that stage (the server decides). */
export function refundPercentFor(schedule, stage) {
  const reached = stageIndex(stage);
  const row = [...schedule]
    .sort((a, b) => stageIndex(a.uptoStage) - stageIndex(b.uptoStage))
    .find((r) => stageIndex(r.uptoStage) >= reached);
  return row?.refundPercent ?? 0;
}

import { stageIndex } from '@vs/shared/stages.js';

/** Active or on hold: the order can still change. */
export const isOpen = (order) => order.status === 'active' || order.status === 'on_hold';

// Same rule as the server.
export { isGarmentLate } from '@vs/shared/production.js';

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

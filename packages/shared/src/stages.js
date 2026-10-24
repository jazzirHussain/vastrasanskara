// Production stages of an order, in workflow order.

export const STAGES = Object.freeze(
  [
    { key: 'order_taken', label: 'Order taken + advance' },
    { key: 'materials_ready', label: 'Materials ready' },
    { key: 'pattern_making', label: 'Pattern making' },
    { key: 'handwork', label: 'Handwork' },
    { key: 'quality_check', label: 'Quality check' },
    { key: 'masters_cutting', label: 'Masters cutting table' },
    { key: 'tailors', label: 'Tailors' },
    { key: 'trials_fittings', label: 'Trials and fittings' },
    { key: 'finishing', label: 'Finishing' },
    { key: 'branding', label: 'Branding' },
    { key: 'final_qc', label: 'Final quality check' },
    { key: 'packaging', label: 'Packaging' },
    { key: 'ready_for_pickup', label: 'Ready for pickup' },
    { key: 'picked_up', label: 'Picked up' },
  ].map((stage) => Object.freeze(stage)),
);

export const STAGE_KEYS = Object.freeze(STAGES.map((s) => s.key));

/** Position of a stage in the workflow; throws on an unknown key. */
export function stageIndex(key) {
  const index = STAGE_KEYS.indexOf(key);
  if (index === -1) throw new RangeError(`Unknown stage: ${key}`);
  return index;
}

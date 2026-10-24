import { test, expect } from 'vitest';
import { STAGE_KEYS } from '../src/stages.js';
import {
  ACTIONS,
  ProductionRuleError,
  allowedActions,
  applyStageAction,
  isGarmentLate,
  isNearlyReady,
  nextStage,
  workingStage,
} from '../src/production.js';

const TODAY = '2026-11-10';
const plan = (dates = {}, skipped = []) =>
  STAGE_KEYS.map((stage) => ({
    stage,
    plannedDate: stage === 'picked_up' ? null : (dates[stage] ?? '2026-11-30'),
    skipped: skipped.includes(stage),
    skipReason: skipped.includes(stage) ? 'Not needed' : null,
  }));
const garment = (fields = {}) => ({
  currentStage: 'order_taken',
  stageState: 'pending',
  status: 'in_progress',
  alterationOpen: false,
  dueDate: null,
  stagePlan: plan(),
  ...fields,
});
const apply = (g, input) => applyStageAction(g, { stage: workingStage(g), ...input }, { today: TODAY });
const codeOf = (fn) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ProductionRuleError);
    return err.code;
  }
  return null;
};

test('a new garment works towards materials ready', () => {
  expect(workingStage(garment())).toBe('materials_ready');
  expect(workingStage(garment({ currentStage: 'tailors' }))).toBe('tailors');
  expect(apply(garment(), { action: 'start' }).changes).toEqual({ currentStage: 'materials_ready', stageState: 'in_progress' });
});

test('complete advances past skipped stages', () => {
  const g = garment({ currentStage: 'pattern_making', stagePlan: plan({}, ['handwork']) });
  expect(nextStage(g, 'pattern_making')).toBe('quality_check');
  const { changes, event } = apply(g, { action: 'complete' });
  expect(changes).toEqual({ currentStage: 'quality_check', stageState: 'pending' });
  expect(event).toEqual({ stage: 'pattern_making', action: 'complete' });
});

test('completing packaging makes the garment ready', () => {
  const { changes } = apply(garment({ currentStage: 'packaging', stageState: 'in_progress' }), { action: 'complete' });
  expect(changes).toEqual({ currentStage: 'ready_for_pickup', stageState: 'pending', status: 'ready', readyDate: TODAY });
});

test('skip records the stage and reason and advances', () => {
  const { changes, event } = apply(garment({ currentStage: 'handwork' }), { action: 'skip', reason: 'Plain blouse' });
  expect(changes).toEqual({ currentStage: 'quality_check', stageState: 'pending', skip: { stage: 'handwork', reason: 'Plain blouse' } });
  expect(event).toEqual({ stage: 'handwork', action: 'skip' });
});

test('complete is refused at a QC stage and qc_pass is refused elsewhere', () => {
  expect(codeOf(() => apply(garment({ currentStage: 'quality_check' }), { action: 'complete' }))).toBe('ACTION_NOT_ALLOWED');
  expect(codeOf(() => apply(garment({ currentStage: 'tailors' }), { action: 'qc_pass' }))).toBe('ACTION_NOT_ALLOWED');
  expect(apply(garment({ currentStage: 'final_qc' }), { action: 'qc_pass' }).changes.currentStage).toBe('packaging');
});

test('acting on another stage is a stage order violation', () => {
  const g = garment({ currentStage: 'tailors' });
  expect(codeOf(() => applyStageAction(g, { action: 'complete', stage: 'finishing' }, { today: TODAY }))).toBe('STAGE_ORDER_VIOLATION');
  expect(codeOf(() => applyStageAction(garment(), { action: 'complete', stage: 'order_taken' }, { today: TODAY }))).toBe('STAGE_ORDER_VIOLATION');
});

test('qc_fail sends the garment back to the chosen earlier stage', () => {
  const g = garment({ currentStage: 'quality_check', stagePlan: plan({}, ['pattern_making']) });
  const { changes, event } = apply(g, { action: 'qc_fail', reworkStage: 'handwork' });
  expect(changes).toEqual({ currentStage: 'handwork', stageState: 'pending', status: 'in_progress', readyDate: null });
  expect(event).toEqual({ stage: 'quality_check', action: 'qc_fail', reworkStage: 'handwork' });
  for (const reworkStage of ['tailors', 'quality_check', 'pattern_making', 'order_taken']) {
    expect(codeOf(() => apply(g, { action: 'qc_fail', reworkStage }))).toBe('REWORK_TARGET_INVALID');
  }
});

test('rework from a ready garment reopens it', () => {
  const g = garment({ currentStage: 'ready_for_pickup', status: 'ready' });
  expect(workingStage(g)).toBe('ready_for_pickup');
  expect(apply(g, { action: 'rework', reworkStage: 'finishing' }).changes).toEqual({
    currentStage: 'finishing', stageState: 'pending', status: 'in_progress', readyDate: null,
  });
});

test('only return is allowed while with a vendor', () => {
  const vendorId = 'v1';
  const sent = apply(garment({ currentStage: 'handwork' }), { action: 'sent_to_vendor', vendorId, dueBackDate: '2026-11-15' });
  expect(sent.changes).toEqual({
    currentStage: 'handwork', stageState: 'with_vendor', vendorWork: { vendorId, dueBackDate: '2026-11-15', sentOn: TODAY },
  });
  expect(sent.event).toEqual({ stage: 'handwork', action: 'sent_to_vendor', vendorId, dueBackDate: '2026-11-15' });
  const away = garment({ currentStage: 'handwork', stageState: 'with_vendor' });
  for (const action of ['complete', 'start', 'skip', 'sent_to_vendor']) {
    expect(codeOf(() => apply(away, { action, reason: 'x', vendorId, dueBackDate: '2026-11-15' }))).toBe('WITH_VENDOR');
  }
  expect(apply(away, { action: 'returned_from_vendor' }).changes).toEqual({ stageState: 'in_progress', vendorWork: null });
  expect(codeOf(() => apply(garment({ currentStage: 'handwork' }), { action: 'returned_from_vendor' }))).toBe('ACTION_NOT_ALLOWED');
});

test('a vendor due-back date in the past is refused', () => {
  expect(codeOf(() => apply(garment(), { action: 'sent_to_vendor', vendorId: 'v1', dueBackDate: '2026-11-09' }))).toBe('ACTION_NOT_ALLOWED');
});

test('alteration after pickup reopens with alterationOpen', () => {
  const g = garment({ currentStage: 'picked_up', status: 'picked_up' });
  const { changes, event } = apply(g, { action: 'alteration' });
  expect(changes).toEqual({ currentStage: 'tailors', stageState: 'pending', status: 'in_progress', readyDate: null, alterationOpen: true });
  expect(event).toEqual({ stage: 'picked_up', action: 'alteration' });
  expect(apply(garment({ currentStage: 'trials_fittings' }), { action: 'alteration' }).changes.alterationOpen).toBeUndefined();
});

test('alteration before trials is refused', () => {
  expect(codeOf(() => apply(garment({ currentStage: 'tailors' }), { action: 'alteration' }))).toBe('ACTION_NOT_ALLOWED');
});

test('pickup needs a ready garment and clears alterationOpen', () => {
  const ready = garment({ currentStage: 'ready_for_pickup', status: 'ready', alterationOpen: true });
  expect(apply(ready, { action: 'picked_up' }).changes).toEqual({ currentStage: 'picked_up', status: 'picked_up', alterationOpen: false });
  expect(codeOf(() => apply(garment({ currentStage: 'packaging' }), { action: 'picked_up' }))).toBe('ACTION_NOT_ALLOWED');
});

test('rejection needs a garment that is not picked up', () => {
  expect(apply(garment({ currentStage: 'tailors' }), { action: 'rejected' }).changes).toEqual({ status: 'rejected' });
  expect(codeOf(() => apply(garment({ currentStage: 'picked_up', status: 'picked_up' }), { action: 'rejected' }))).toBe('ACTION_NOT_ALLOWED');
});

test('nothing is allowed on a cancelled garment', () => {
  expect(allowedActions(garment({ status: 'cancelled' }))).toEqual([]);
});

test('allowedActions matches what applyStageAction accepts', () => {
  const states = [
    garment(),
    garment({ currentStage: 'handwork', stageState: 'in_progress' }),
    garment({ currentStage: 'quality_check' }),
    garment({ currentStage: 'final_qc', stageState: 'in_progress' }),
    garment({ currentStage: 'tailors', stageState: 'with_vendor' }),
    garment({ currentStage: 'finishing' }),
    garment({ currentStage: 'ready_for_pickup', status: 'ready' }),
    garment({ currentStage: 'picked_up', status: 'picked_up' }),
    garment({ currentStage: 'tailors', status: 'rejected' }),
  ];
  const inputFor = (g, action) => ({
    action,
    reason: 'x',
    vendorId: 'v1',
    dueBackDate: TODAY,
    reworkStage: 'materials_ready',
    stage: ['alteration', 'picked_up', 'rejected'].includes(action) ? g.currentStage : workingStage(g),
  });
  for (const g of states) {
    for (const action of ACTIONS) {
      const accepted = codeOf(() => applyStageAction(g, inputFor(g, action), { today: TODAY })) === null;
      expect([g.currentStage, g.stageState, g.status, action, allowedActions(g).includes(action)]).toEqual([
        g.currentStage, g.stageState, g.status, action, accepted,
      ]);
    }
  }
});

test('isGarmentLate keeps the M2 rule', () => {
  const active = { status: 'active', pickupDate: '2026-11-30' };
  expect(isGarmentLate(garment(), active, TODAY)).toBe(false);
  expect(isGarmentLate(garment({ stagePlan: plan({ materials_ready: '2026-11-09' }) }), active, TODAY)).toBe(true);
  expect(isGarmentLate(garment({ stagePlan: plan({ materials_ready: '2026-11-09' }, ['materials_ready']) }), active, TODAY)).toBe(false);
  expect(isGarmentLate(garment({ stagePlan: plan({ materials_ready: '2026-11-09' }) }), { ...active, status: 'on_hold' }, TODAY)).toBe(false);
  expect(isGarmentLate(garment(), { ...active, pickupDate: '2026-11-09' }, TODAY)).toBe(true);
  expect(isGarmentLate(garment({ dueDate: '2026-11-09' }), active, TODAY)).toBe(true);
  expect(isGarmentLate(garment({ status: 'ready', dueDate: '2026-11-09' }), active, TODAY)).toBe(false);
  expect(isGarmentLate(garment({ currentStage: 'tailors', stagePlan: plan({ tailors: '2026-11-09' }) }), active, TODAY)).toBe(true);
});

test('nearly ready from final QC on', () => {
  expect(isNearlyReady(garment({ currentStage: 'branding' }))).toBe(false);
  expect(isNearlyReady(garment({ currentStage: 'final_qc' }))).toBe(true);
  expect(isNearlyReady(garment({ currentStage: 'ready_for_pickup', status: 'ready' }))).toBe(true);
});

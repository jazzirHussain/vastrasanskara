import { test, expect } from 'vitest';
import { planStages, durationsFor, WORK_STAGES } from '../src/planning.js';
import { DEFAULT_SETTINGS } from '../src/schemas/settings.js';
import { STAGE_KEYS } from '../src/stages.js';

const DEFAULTS = DEFAULT_SETTINGS.stageDurations.default;
const datesOf = (stagePlan) => Object.fromEntries(stagePlan.map((s) => [s.stage, s.plannedDate]));

test('work stages run from materials ready to packaging', () => {
  expect(WORK_STAGES).toEqual(STAGE_KEYS.slice(1, 12));
  expect(WORK_STAGES).toHaveLength(11);
});
test('back-schedules from the due date when the plan fits', () => {
  const { stagePlan, tightSchedule } = planStages({ orderDate: '2026-10-01', dueDate: '2026-11-15', durations: DEFAULTS });
  expect(stagePlan.map((s) => s.stage)).toEqual(STAGE_KEYS);
  expect(tightSchedule).toBe(false);
  expect(datesOf(stagePlan)).toMatchObject({ order_taken: '2026-10-01', materials_ready: '2026-10-25', pattern_making: '2026-10-26', handwork: '2026-11-02',
    quality_check: '2026-11-03', masters_cutting: '2026-11-04', tailors: '2026-11-08', trials_fittings: '2026-11-10', finishing: '2026-11-12',
    branding: '2026-11-13', final_qc: '2026-11-14', packaging: '2026-11-15', ready_for_pickup: '2026-11-15', picked_up: null });
});
test('a plan that exactly fills the days is not tight', () => {
  const { stagePlan, tightSchedule } = planStages({ orderDate: '2026-10-01', dueDate: '2026-10-24', durations: DEFAULTS });
  expect(tightSchedule).toBe(false);
  expect(datesOf(stagePlan).materials_ready).toBe('2026-10-03');
});
test('compresses proportionally when the plan does not fit', () => {
  const { stagePlan, tightSchedule } = planStages({ orderDate: '2026-10-01', dueDate: '2026-10-11', durations: DEFAULTS });
  const at = datesOf(stagePlan);
  expect(tightSchedule).toBe(true);
  expect(at).toMatchObject({ materials_ready: '2026-10-02', pattern_making: '2026-10-03', handwork: '2026-10-06', quality_check: '2026-10-07',
    masters_cutting: '2026-10-07', tailors: '2026-10-09', trials_fittings: '2026-10-10', finishing: '2026-10-11', packaging: '2026-10-11' });
  for (const s of stagePlan.filter((s) => s.plannedDate)) expect(s.plannedDate >= '2026-10-01' && s.plannedDate <= '2026-10-11').toBe(true);
});
test('pickup on the order date plans everything that day', () => {
  const { stagePlan, tightSchedule } = planStages({ orderDate: '2026-10-01', dueDate: '2026-10-01', durations: DEFAULTS });
  expect(tightSchedule).toBe(true);
  for (const s of stagePlan.filter((s) => s.stage !== 'picked_up')) expect(s.plannedDate).toBe('2026-10-01');
});
test('planned dates never go backwards', () => {
  for (const dueDate of ['2026-10-01', '2026-10-05', '2026-10-11', '2026-10-30', '2027-03-01']) {
    const dates = planStages({ orderDate: '2026-10-01', dueDate, durations: DEFAULTS }).stagePlan.map((s) => s.plannedDate).filter(Boolean);
    expect([...dates].sort()).toEqual(dates);
  }
});
test('garment-type overrides replace the default per stage', () => {
  const settings = { stageDurations: { default: DEFAULTS, byGarmentType: { lehenga: { handwork: 12, branding: 0 } } } };
  expect(durationsFor(settings, 'lehenga')).toEqual({ ...DEFAULTS, handwork: 12, branding: 0 });
  expect(durationsFor(settings, 'blouse')).toEqual(DEFAULTS);
  expect(durationsFor({ stageDurations: { default: { handwork: 3 }, byGarmentType: {} } }, 'x').tailors).toBe(0);
});
test('all-zero durations plan every stage on the due date', () => {
  const zero = Object.fromEntries(WORK_STAGES.map((s) => [s, 0]));
  const { stagePlan, tightSchedule } = planStages({ orderDate: '2026-10-01', dueDate: '2026-10-05', durations: zero });
  expect(tightSchedule).toBe(false);
  expect(datesOf(stagePlan).materials_ready).toBe('2026-10-05');
});
test('due date before order date throws', () => {
  expect(() => planStages({ orderDate: '2026-10-02', dueDate: '2026-10-01', durations: DEFAULTS })).toThrow(RangeError);
});

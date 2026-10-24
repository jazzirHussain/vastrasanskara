import { addDaysYmd } from './fy.js';
import { allocateProRata } from './money.js';
import { STAGE_KEYS } from './stages.js';

/** The stages that take working days: Materials ready through Packaging. */
export const WORK_STAGES = Object.freeze(STAGE_KEYS.slice(1, 12));

const DAY_MS = 24 * 60 * 60 * 1000;
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** Days per work stage for a garment type: the default durations overlaid with the type's own. */
export function durationsFor(settings, garmentType) {
  const { default: base = {}, byGarmentType = {} } = settings.stageDurations ?? {};
  const own = byGarmentType[garmentType] ?? {};
  return Object.fromEntries(WORK_STAGES.map((stage) => [stage, own[stage] ?? base[stage] ?? 0]));
}

/**
 * Back-schedules a garment's stages from its due date. Packaging and Ready for pickup fall on
 * the due date; each earlier stage is planned for the next stage's date minus the next stage's
 * duration, so any slack sits at the start. When the durations do not fit between the order
 * and due dates, the available days are split over the stages in proportion to their
 * durations and the plan is marked tight. Picked up is never planned.
 */
export function planStages({ orderDate, dueDate, durations }) {
  const available = daysBetween(orderDate, dueDate);
  if (!(available >= 0)) throw new RangeError(`Due date ${dueDate} is before order date ${orderDate}`);

  let days = WORK_STAGES.map((stage) => durations[stage] ?? 0);
  const needed = days.reduce((a, d) => a + d, 0);
  const tightSchedule = needed > available;
  if (tightSchedule) days = allocateProRata(available, days);

  const planned = { order_taken: orderDate, ready_for_pickup: dueDate, picked_up: null };
  let date = dueDate;
  for (let i = WORK_STAGES.length - 1; i >= 0; i--) {
    planned[WORK_STAGES[i]] = date;
    date = addDaysYmd(date, -days[i]);
  }
  return { stagePlan: STAGE_KEYS.map((stage) => ({ stage, plannedDate: planned[stage] })), tightSchedule };
}

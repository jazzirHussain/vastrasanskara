import { addDaysYmd, istDate, planStages, durationsFor, DEFAULT_SETTINGS } from '@vs/shared';

export const todayYmd = () => istDate(new Date());

/** An order as GET /v1/orders/:id returns it (with money fields unless `money` is false). */
export function orderDetailFixture({ money = true, garments = 1, ...fields } = {}) {
  const orderDate = todayYmd();
  const pickupDate = fields.pickupDate ?? addDaysYmd(orderDate, 30);
  const garment = (i) => {
    const { stagePlan, tightSchedule } = planStages({ orderDate, dueDate: pickupDate, durations: durationsFor(DEFAULT_SETTINGS, 'blouse') });
    return {
      id: `g${i}`,
      garmentNo: `VS/ORD/2627/0007-0${i}`,
      index: i,
      type: 'blouse',
      description: `Blouse ${i}`,
      fabric: 'Silk',
      designNotes: 'Boat neck',
      batchId: null,
      dueDate: null,
      originalDueDate: null,
      currentStage: 'order_taken',
      stageState: 'pending',
      status: 'in_progress',
      tightSchedule,
      alterationOpen: false,
      vendorWork: null,
      readyDate: null,
      rejection: null,
      remakeOf: null,
      stagePlan: stagePlan.map((s) => ({ ...s, originalPlannedDate: s.plannedDate, skipped: false, skipReason: null })),
      referenceKeys: [],
      measurementId: null,
      ...(money && { agreedPrice: 450000 }),
      version: 0,
    };
  };
  return {
    id: 'o1',
    orderNo: 'VS/ORD/2627/0007',
    status: 'active',
    priority: 'normal',
    pickupDate,
    originalPickupDate: pickupDate,
    customer: { id: 'c1', name: 'Asha Rao' },
    designer: { id: 'des1', name: 'Meera' },
    garmentCount: garments,
    tight: false,
    late: false,
    ...(money && { expectedBudget: 5000000 }),
    version: 0,
    orderDate,
    occasionDate: null,
    notes: '',
    holdHistory: [],
    cancellation: null,
    garments: Array.from({ length: garments }, (_, i) => garment(i + 1)),
    ...fields,
  };
}

/** The list item for an order detail. */
export function orderSummary(detail) {
  const { garments, orderDate: _o, occasionDate: _oc, notes: _n, holdHistory: _h, cancellation: _c, ...summary } = detail;
  const [{ currentStage, status, tightSchedule, stagePlan }] = garments;
  return { ...summary, thread: { currentStage, status, tightSchedule, stagePlan } };
}

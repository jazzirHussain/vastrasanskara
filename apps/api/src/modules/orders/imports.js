// Open orders brought in from earlier records: a new order number, the old paper number kept as
// `legacyRef`, and each garment placed at the stage it has reached (one `imported` stage event).
// No materials are reserved and no message is sent.
import { istDate } from '@vs/shared/fy.js';
import { clock } from '../../clock.js';
import { recordAudit } from '../../core/audit/service.js';
import { withTransaction } from '../../core/db.js';
import { AppError, businessRule, validationError } from '../../core/errors.js';
import { getBranch } from '../branches/service.js';
import { recordImportedStage } from '../production/service.js';
import { readSettings } from '../settings/service.js';
import { Garment, Order } from './model.js';
import { allocateOrderNo, buildGarments, checkGarmentInputs, checkParties } from './service.js';

const orderExists = () => new AppError(409, 'ORDER_EXISTS', 'An order with this old number is already in the system');

/** The branch's order brought in with this old number, or null. */
export function findOrderByLegacyRef(branchId, legacyRef, session) {
  return Order.findOne({ branchId, legacyRef: String(legacyRef).trim() }).session(session ?? null).lean();
}

/**
 * Adds one open order from earlier records. `orderDate` (default today) may not be in the future;
 * the pickup date may be past (the order then shows late). Each garment line carries its `stage`.
 */
export async function importOrder(branchId, input, actor) {
  const now = clock.now();
  const day = istDate(now);
  const orderDate = input.orderDate ?? day;
  if (orderDate > day) throw businessRule('ORDER_DATE_IN_FUTURE', 'The order date cannot be in the future');
  if (input.pickupDate < orderDate) throw businessRule('PICKUP_BEFORE_ORDER', 'The pickup date cannot be before the order date');
  const issues = input.garments
    .map((g, i) => (g.stage === 'picked_up' ? { path: `garments.${i}.stage`, message: 'Picked-up garments are not open orders' } : null))
    .filter(Boolean);
  if (issues.length) throw validationError(issues);
  await checkParties(branchId, input);
  const settings = await readSettings(branchId);
  const lines = input.garments.map(({ stage, materials, ...g }) => ({
    referenceKeys: [],
    measurementId: null,
    designNotes: '',
    fabric: '',
    dueDate: null,
    quantity: 1,
    ...g,
  }));
  await checkGarmentInputs(branchId, { ...input, garments: lines }, settings, 'garments', { allowPast: true });
  const branch = await getBranch(branchId);
  const legacyRef = String(input.legacyRef).trim();

  try {
    return await withTransaction(async (session) => {
      if (await findOrderByLegacyRef(branchId, legacyRef, session)) throw orderExists();
      const orderNo = await allocateOrderNo(branchId, { now, settings, branch }, session);
      const [order] = await Order.create(
        [
          {
            branchId,
            orderNo,
            legacyRef,
            customerId: input.customerId,
            designerId: input.designerId,
            priority: input.priority ?? 'normal',
            notes: input.notes ?? '',
            orderDate,
            pickupDate: input.pickupDate,
            originalPickupDate: input.pickupDate,
            createdBy: actor.userId,
            updatedBy: actor.userId,
          },
        ],
        { session },
      );
      const docs = buildGarments({ branchId, order, garments: lines, startIndex: 1, settings, actor, planFrom: orderDate });
      // Each line's stage applies to every garment made from it (a batch shares its stage).
      const stages = input.garments.flatMap((g) => Array.from({ length: g.quantity ?? 1 }, () => g.stage));
      docs.forEach((doc, i) => {
        doc.currentStage = stages[i];
        doc.stageState = 'pending';
        if (stages[i] === 'ready_for_pickup') Object.assign(doc, { status: 'ready', readyDate: day });
      });
      const garments = await Garment.create(docs, { session, ordered: true });
      for (const garment of garments) {
        await recordImportedStage(branchId, { orderId: order._id, garmentId: garment._id, stage: garment.currentStage }, actor, session);
      }
      await recordAudit(
        {
          branchId,
          entityType: 'order',
          entityId: order._id,
          action: 'import',
          before: null,
          after: { orderNo, legacyRef, customerId: String(order.customerId), pickupDate: order.pickupDate, garments: garments.map((g) => `${g.garmentNo} at ${g.currentStage}`) },
          actor,
        },
        session,
      );
      return { order: order.toObject(), garments: garments.map((g) => g.toObject()) };
    });
  } catch (err) {
    if (err?.code === 11000 && /legacy_ref/.test(err.message)) throw orderExists();
    throw err;
  }
}

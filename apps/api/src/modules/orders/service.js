import mongoose from 'mongoose';
import { durationsFor, planStages } from '@vs/shared/planning.js';
import { isGarmentLate } from '@vs/shared/production.js';
import { stageIndex } from '@vs/shared/stages.js';
import { financialYear, istDate } from '@vs/shared/fy.js';
import { clock } from '../../clock.js';
import { recordAudit } from '../../core/audit/service.js';
import { withTransaction } from '../../core/db.js';
import { businessRule, conflict, notFound, validationError } from '../../core/errors.js';
import { nextDocumentNumber } from '../../core/numbering.js';
import { paginate } from '../../core/pagination.js';
import { logger } from '../../logger.js';
import { getBranch } from '../branches/service.js';
import { customerIdsByNamePrefix, getCustomer, getCustomerNames } from '../customers/service.js';
import { getMeasurement } from '../measurements/service.js';
import { readSettings } from '../settings/service.js';
import { getUserNames, isActiveDesigner } from '../users/service.js';
import { Garment, Order } from './model.js';

const { ObjectId } = mongoose.Types;

/** Today's IST business date. */
export const today = () => istDate(clock.now());

const pad = (n, width) => String(n).padStart(width, '0');

/** Orders the user may see: their own as designer, or all with orders.read.all. */
export function orderScope(user) {
  return user.permissions.has('orders.read.all') ? {} : { designerId: new ObjectId(user.id) };
}

/** A fresh stage plan for a garment, with each planned date also kept as the original. */
export function stagePlanFor({ orderDate, dueDate, settings, type }) {
  const { stagePlan, tightSchedule } = planStages({ orderDate, dueDate, durations: durationsFor(settings, type) });
  return {
    stagePlan: stagePlan.map((s) => ({ ...s, originalPlannedDate: s.plannedDate, skipped: false, skipReason: null })),
    tightSchedule,
  };
}

/**
 * Re-plans the stages after the garment's current stage towards a new due date, planning from
 * today; earlier stages and every original planned date are kept. Mutates the garment document.
 */
export function replanGarment(garment, { dueDate, settings }) {
  const { stagePlan, tightSchedule } = stagePlanFor({ orderDate: today(), dueDate, settings, type: garment.type });
  const current = stageIndex(garment.currentStage);
  for (const entry of garment.stagePlan) {
    const index = stageIndex(entry.stage);
    if (index > current && !entry.skipped) entry.plannedDate = stagePlan[index].plannedDate;
  }
  garment.tightSchedule = tightSchedule;
}

/** Throws 422 INVALID_STATUS unless the order is in one of `statuses`. */
export function assertStatus(order, statuses) {
  if (!statuses.includes(order.status)) {
    throw businessRule('INVALID_STATUS', 'This order cannot be changed in its current status');
  }
}

/** Loads an order document of the branch for a change at `version` (404, then 409). */
export async function loadOrderForChange(branchId, orderId, version, session) {
  if (!mongoose.isValidObjectId(orderId)) throw notFound();
  const order = await Order.findOne({ _id: orderId, branchId }).session(session);
  if (!order) throw notFound();
  if (order.__v !== version) throw conflict();
  return order;
}

/**
 * Checks garment lines against the branch and customer: known garment type, the customer's own
 * measurement set, reference photos uploaded to this branch as garment references (400), and
 * own due dates between today and the pickup date (422).
 */
export async function checkGarmentInputs(branchId, { customerId, pickupDate, garments }, settings, prefix = 'garments') {
  const issues = [];
  const types = new Set(settings.garmentTypes.map((t) => t.key));
  for (const [i, g] of garments.entries()) {
    if (!types.has(g.type)) issues.push({ path: `${prefix}.${i}.type`, message: 'Unknown garment type' });
    if (g.measurementId) {
      const m = await getMeasurement(branchId, g.measurementId).catch(() => null);
      if (!m || String(m.customerId) !== String(customerId) || m.garmentType !== g.type) {
        issues.push({ path: `${prefix}.${i}.measurementId`, message: "Not one of this customer's measurements for this garment type" });
      }
    }
    for (const [k, key] of g.referenceKeys.entries()) {
      if (!key.startsWith(`${branchId}/garment_reference/`)) {
        issues.push({ path: `${prefix}.${i}.referenceKeys.${k}`, message: 'Not a garment reference upload' });
      }
    }
  }
  if (issues.length) throw validationError(issues);
  for (const g of garments) {
    if (g.dueDate && g.dueDate > pickupDate) {
      throw businessRule('DUE_AFTER_PICKUP', 'A garment cannot be due after the pickup date');
    }
    if (g.dueDate && g.dueDate < today()) throw businessRule('DUE_IN_PAST', 'A garment cannot be due in the past');
  }
}

/**
 * Garment documents for the lines, numbered from `startIndex`. A line with quantity N becomes
 * N garments sharing a new batchId.
 */
export function buildGarments({ branchId, order, garments, startIndex, settings, actor }) {
  const docs = [];
  let index = startIndex;
  for (const { quantity, ...line } of garments) {
    const batchId = quantity > 1 ? new ObjectId() : null;
    const dueDate = line.dueDate ?? null;
    const plan = stagePlanFor({ orderDate: today(), dueDate: dueDate ?? order.pickupDate, settings, type: line.type });
    for (let n = 0; n < quantity; n++) {
      docs.push({
        ...line,
        branchId,
        orderId: order._id,
        garmentNo: `${order.orderNo}-${pad(index, 2)}`,
        index,
        quantity: 1,
        dueDate,
        originalDueDate: dueDate,
        batchId,
        ...structuredClone(plan),
        createdBy: actor.userId,
        updatedBy: actor.userId,
      });
      index += 1;
    }
  }
  return docs;
}

async function checkParties(branchId, { customerId, designerId }) {
  const issues = [];
  const customer = await getCustomer(branchId, customerId).catch(() => null);
  if (!customer) issues.push({ path: 'customerId', message: 'Unknown customer' });
  if (!(await isActiveDesigner(branchId, designerId))) {
    issues.push({ path: 'designerId', message: 'Choose an active designer' });
  }
  if (issues.length) throw validationError(issues);
}

/**
 * Takes an order: the order number, every garment (batches expanded) with its stage plan, and
 * the audit entry are saved in one transaction.
 */
export async function createOrder(branchId, input, actor) {
  // One clock read dates and numbers the order, so both fall in the same financial year.
  const now = clock.now();
  const orderDate = istDate(now);
  if (input.pickupDate < orderDate) throw businessRule('PICKUP_IN_PAST', 'The pickup date cannot be in the past');
  await checkParties(branchId, input);
  const settings = await readSettings(branchId);
  await checkGarmentInputs(branchId, input, settings);
  const branch = await getBranch(branchId);

  return withTransaction(async (session) => {
    const fyCode = financialYear(now).code;
    const { number, fy } = await nextDocumentNumber(
      { branchId, docType: 'order', now, start: settings.numberSeries[`order:${fyCode}`] ?? 1 },
      session,
    );
    const { garments, ...fields } = input;
    const [order] = await Order.create(
      [
        {
          ...fields,
          branchId,
          orderNo: `${branch.prefixes.order}/${fy.code}/${pad(number, 4)}`,
          orderDate,
          originalPickupDate: input.pickupDate,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        },
      ],
      { session },
    );
    const garmentDocs = await Garment.create(buildGarments({ branchId, order, garments, startIndex: 1, settings, actor }), {
      session,
      ordered: true,
    });
    await recordAudit(
      {
        branchId,
        entityType: 'order',
        entityId: order._id,
        action: 'create',
        before: null,
        after: {
          orderNo: order.orderNo,
          customerId: String(order.customerId),
          designerId: String(order.designerId),
          pickupDate: order.pickupDate,
          garments: garmentDocs.map((g) => g.garmentNo),
        },
        actor,
      },
      session,
    );
    return { order: order.toObject(), garments: garmentDocs.map((g) => g.toObject()) };
  });
}

/** The order with its garments (by index) and customer; 404 when outside the user's scope. */
export async function getOrder(branchId, user, orderId) {
  if (!mongoose.isValidObjectId(orderId)) throw notFound();
  const order = await Order.findOne({ _id: orderId, branchId, ...orderScope(user) }).lean();
  if (!order) throw notFound();
  const [garments, customer] = await Promise.all([
    Garment.find({ orderId: order._id }).sort({ index: 1 }).lean(),
    getCustomer(branchId, order.customerId),
  ]);
  return { order, garments, customer };
}

/** A garment of an order in the user's scope; 404 otherwise. */
export async function getGarment(branchId, user, garmentId) {
  if (!mongoose.isValidObjectId(garmentId)) throw notFound();
  const garment = await Garment.findOne({ _id: garmentId, branchId }).lean();
  if (!garment || !(await isOrderInScope(user, garment.orderId))) throw notFound();
  return garment;
}

/** Whether the order belongs to the user's branch and scope. */
export async function isOrderInScope(user, orderId) {
  return Boolean(await Order.exists({ _id: orderId, branchId: user.branchId, ...orderScope(user) }));
}

/** Whether the user may read a garment reference file: they can read an order that uses it. */
export async function canReadGarmentFile(user, key) {
  const garment = await Garment.findOne({ branchId: user.branchId, referenceKeys: key }, { orderId: 1 }).lean();
  if (!garment) return user.permissions.has('orders.write');
  return Boolean(await Order.exists({ _id: garment.orderId, branchId: user.branchId, ...orderScope(user) }));
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const OPEN_GARMENT_LIMIT = 1000;

/**
 * Garments still in work (in progress or ready) on the branch's active orders, in the user's
 * scope (`user` null = the whole branch, for scheduled checks), by due date. Each item is
 * { garment, order, customerName, designerName }; `truncated` when the limit was reached.
 */
export async function listOpenGarments(branchId, user = null, { designerId } = {}) {
  const orders = await Order.find({
    branchId,
    status: 'active',
    $and: [user ? orderScope(user) : {}, designerId ? { designerId: new ObjectId(designerId) } : {}],
  }).lean();
  const garments = await Garment.find({ orderId: { $in: orders.map((o) => o._id) }, status: { $in: ['in_progress', 'ready'] } })
    .sort({ dueDate: 1, garmentNo: 1 })
    .limit(OPEN_GARMENT_LIMIT)
    .lean();
  const truncated = garments.length === OPEN_GARMENT_LIMIT;
  if (truncated) logger.warn({ branchId: String(branchId) }, `open garments capped at ${OPEN_GARMENT_LIMIT}`);
  const [customerNames, designerNames] = await Promise.all([
    getCustomerNames(branchId, orders.map((o) => o.customerId)),
    getUserNames(orders.map((o) => o.designerId)),
  ]);
  const orderById = new Map(orders.map((o) => [String(o._id), o]));
  const items = garments.map((garment) => {
    const order = orderById.get(String(garment.orderId));
    return {
      garment,
      order,
      customerName: customerNames.get(String(order.customerId)) ?? '',
      designerName: designerNames.get(String(order.designerId)) ?? '',
    };
  });
  return { items, truncated };
}

/** Ids of the active orders in the user's scope with a garment late today. */
async function lateOrderIds(branchId, user) {
  const { items } = await listOpenGarments(branchId, user);
  const day = today();
  const late = items.filter(({ garment, order }) => isGarmentLate(garment, order, day));
  return [...new Set(late.map(({ order }) => String(order._id)))].map((id) => new ObjectId(id));
}

/**
 * A page of the branch's orders in the user's scope, by pickup date. `q` matches the end of the
 * order number (e.g. '0012' or the whole number) or the start of the customer's name. Each item
 * is { order, garments, customerName, designerName }. `late` keeps orders with a late garment.
 */
export async function listOrders(
  branchId,
  user,
  { status, designerId, customerId, priority, pickupFrom, pickupTo, q, late, cursor, limit } = {},
) {
  // Both the requested designer and the user's scope must hold, so a designer cannot widen it.
  const filter = {
    branchId,
    ...(status && { status }),
    ...(priority && { priority }),
    ...(customerId && { customerId: new ObjectId(customerId) }),
    $and: [orderScope(user), designerId ? { designerId: new ObjectId(designerId) } : {}],
  };
  if (pickupFrom || pickupTo) {
    filter.pickupDate = { ...(pickupFrom && { $gte: pickupFrom }), ...(pickupTo && { $lte: pickupTo }) };
  }
  if (late) filter._id = { $in: await lateOrderIds(branchId, user) };
  const term = q?.trim();
  if (term) {
    const customerIds = await customerIdsByNamePrefix(branchId, term);
    filter.$or = [{ orderNo: { $regex: `${escapeRegex(term)}$`, $options: 'i' } }, { customerId: { $in: customerIds } }];
  }

  const { items: orders, nextCursor } = await paginate(Order, filter, { sort: ['pickupDate', 1], limit, cursor });
  const ids = orders.map((o) => o._id);
  const [garments, customerNames, designerNames] = await Promise.all([
    Garment.find({ orderId: { $in: ids } }).sort({ index: 1 }).lean(),
    getCustomerNames(branchId, orders.map((o) => o.customerId)),
    getUserNames(orders.map((o) => o.designerId)),
  ]);
  const byOrder = Map.groupBy(garments, (g) => String(g.orderId));
  const items = orders.map((order) => ({
    order,
    garments: byOrder.get(String(order._id)) ?? [],
    customerName: customerNames.get(String(order.customerId)),
    designerName: designerNames.get(String(order.designerId)),
  }));
  return { items, nextCursor };
}

/**
 * The order and its garments (by index) for billing: lean, no user scope (callers hold
 * `money.view`), 404 when the order is not the branch's.
 */
export async function getOrderForBilling(branchId, orderId, session) {
  if (!mongoose.isValidObjectId(orderId)) throw notFound();
  const order = await Order.findOne({ _id: orderId, branchId }).session(session ?? null).lean();
  if (!order) throw notFound();
  const garments = await Garment.find({ orderId: order._id }).sort({ index: 1 }).session(session ?? null).lean();
  return { order, garments };
}

/** Order numbers of the branch's orders by id, as a Map of id string to orderNo (for bill and payment lists). */
export async function getOrderNumbers(branchId, ids) {
  if (!ids.length) return new Map();
  const orders = await Order.find({ branchId, _id: { $in: ids } }, { orderNo: 1 }).lean();
  return new Map(orders.map((o) => [String(o._id), o.orderNo]));
}

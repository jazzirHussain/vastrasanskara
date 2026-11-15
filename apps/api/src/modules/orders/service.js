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
import { markEnquiryConverted } from '../enquiries/service.js';
import { getMeasurement } from '../measurements/service.js';
import { readSettings } from '../settings/service.js';
import { garmentFacts, planNewGarments } from '../stock/service.js';
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
 * N garments sharing a new batchId. Materials are not kept on the garment (the stock module
 * holds them; see planGarmentMaterials).
 */
export function buildGarments({ branchId, order, garments, startIndex, settings, actor }) {
  const docs = [];
  let index = startIndex;
  for (const { quantity, materials, ...line } of garments) {
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

/**
 * Lists each line's materials on the garments made from it (`created` in buildGarments order;
 * every garment of a batch gets the list) and reserves them, in `session`.
 */
export async function planGarmentMaterials(branchId, lines, created, actor, session) {
  const materials = lines.flatMap((line) => Array.from({ length: line.quantity }, () => line.materials ?? []));
  const garments = created.map((g, i) => ({ ...garmentFacts(g), materials: materials[i] }));
  await planNewGarments(branchId, garments, actor, session);
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
    const { garments, enquiryId, ...fields } = input;
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
    await planGarmentMaterials(branchId, garments, garmentDocs, actor, session);
    if (enquiryId) {
      await markEnquiryConverted(
        branchId,
        enquiryId,
        { orderId: order._id, orderNo: order.orderNo, customerId: order.customerId },
        actor,
        session,
      );
    }
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

/** A garment of an order in the user's scope (read in `session` when given); 404 otherwise. */
export async function getGarment(branchId, user, garmentId, session) {
  if (!mongoose.isValidObjectId(garmentId)) throw notFound();
  const garment = await Garment.findOne({ _id: garmentId, branchId }).session(session ?? null).lean();
  if (!garment || !(await isOrderInScope(user, garment.orderId, session))) throw notFound();
  return garment;
}

/** Whether the order belongs to the user's branch and scope. */
export async function isOrderInScope(user, orderId, session) {
  return Boolean(await Order.exists({ _id: orderId, branchId: user.branchId, ...orderScope(user) }).session(session ?? null));
}

/**
 * Writes to the garment in `session` (its materialsSeq, not its version) so a stage action or a
 * cancellation committing at the same moment conflicts and retries, seeing the materials change.
 */
export async function touchGarment(branchId, garmentId, session) {
  await Garment.updateOne({ _id: garmentId, branchId }, { $inc: { materialsSeq: 1 } }).session(session);
}

/** The status of one of the branch's orders (read in `session` when given), or 404. */
export async function getOrderStatus(branchId, orderId, session) {
  const order = await Order.findOne({ _id: orderId, branchId }, { status: 1 }).session(session ?? null).lean();
  if (!order) throw notFound();
  return order.status;
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
  return { items: await orderListItems(branchId, orders), nextCursor };
}

/** listOrders rows { order, garments, customerName, designerName } for a page of lean orders. */
export async function orderListItems(branchId, orders) {
  const ids = orders.map((o) => o._id);
  const [garments, customerNames, designerNames] = await Promise.all([
    Garment.find({ orderId: { $in: ids } }).sort({ index: 1 }).lean(),
    getCustomerNames(branchId, orders.map((o) => o.customerId)),
    getUserNames(orders.map((o) => o.designerId)),
  ]);
  const byOrder = Map.groupBy(garments, (g) => String(g.orderId));
  return orders.map((order) => ({
    order,
    garments: byOrder.get(String(order._id)) ?? [],
    customerName: customerNames.get(String(order.customerId)),
    designerName: designerNames.get(String(order.designerId)),
  }));
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

/**
 * The branch's garments with their order's customer and designer, for naming them on a fitting
 * (no user scope: the caller holds appointments.write). Unknown ids are left out.
 */
export async function getGarmentsForAppointment(branchId, garmentIds, session) {
  const ids = [...new Set(garmentIds.map(String))].filter((id) => mongoose.isValidObjectId(id));
  if (!ids.length) return [];
  const garments = await Garment.find({ branchId, _id: { $in: ids } }, { garmentNo: 1, description: 1, status: 1, orderId: 1 })
    .session(session ?? null)
    .lean();
  const orders = await Order.find({ _id: { $in: [...new Set(garments.map((g) => String(g.orderId)))] } }, { customerId: 1, designerId: 1 })
    .session(session ?? null)
    .lean();
  const byId = new Map(orders.map((o) => [String(o._id), o]));
  return garments.map((g) => ({
    id: String(g._id),
    garmentNo: g.garmentNo,
    description: g.description,
    status: g.status,
    orderId: String(g.orderId),
    customerId: String(byId.get(String(g.orderId))?.customerId ?? ''),
    designerId: String(byId.get(String(g.orderId))?.designerId ?? ''),
  }));
}

/** Order numbers of the branch's orders by id, as a Map of id string to orderNo (for bill and payment lists). */
export async function getOrderNumbers(branchId, ids) {
  if (!ids.length) return new Map();
  const orders = await Order.find({ branchId, _id: { $in: ids } }, { orderNo: 1 }).lean();
  return new Map(orders.map((o) => [String(o._id), o.orderNo]));
}

// --- Expense links and costing (callers hold expenses.view / expenses.write; no user scope) -------

const notFoundLink = () => validationError([{ path: 'link.id', message: 'Not found' }]);
const oid = (id) => new ObjectId(String(id));

/**
 * The stored form of an expense link to a garment, a batch or an order of the branch:
 * { kind, orderId, garmentId, batchId }. 400 on `link.id` when it does not exist. Cancelled
 * orders and garments may be linked.
 */
export async function resolveCostLink(branchId, { kind, id }, session) {
  if (!mongoose.isValidObjectId(id)) throw notFoundLink();
  const s = session ?? null;
  if (kind === 'garment') {
    const g = await Garment.findOne({ _id: id, branchId }, { orderId: 1 }).session(s).lean();
    if (!g) throw notFoundLink();
    return { kind, orderId: g.orderId, garmentId: g._id, batchId: null };
  }
  if (kind === 'batch') {
    const g = await Garment.findOne({ branchId, batchId: oid(id) }, { orderId: 1, batchId: 1 }).session(s).lean();
    if (!g) throw notFoundLink();
    return { kind, orderId: g.orderId, garmentId: null, batchId: g.batchId };
  }
  const order = await Order.findOne({ _id: id, branchId }, { _id: 1 }).session(s).lean();
  if (!order) throw notFoundLink();
  return { kind: 'order', orderId: order._id, garmentId: null, batchId: null };
}

/** The id an expense link points at (garment, batch or order). */
const linkedId = (link) => String(link.garmentId ?? link.batchId ?? link.orderId);

/**
 * Labels for stored expense links, as a Map of 'kind:id' to { orderNo, label }:
 * "Order VS/ORD/2627/0012", "Blouse — red silk (…/0012-02)", "Batch of 20 Kurta on VS/ORD/2627/0012".
 */
export async function getCostLinkLabels(branchId, links) {
  const result = new Map();
  if (!links.length) return result;
  const garmentIds = links.filter((l) => l.kind === 'garment').map((l) => l.garmentId);
  const batchIds = links.filter((l) => l.kind === 'batch').map((l) => l.batchId);
  const [orders, garments, batches, settings] = await Promise.all([
    Order.find({ branchId, _id: { $in: links.map((l) => l.orderId) } }, { orderNo: 1 }).lean(),
    garmentIds.length
      ? Garment.find({ branchId, _id: { $in: garmentIds } }, { type: 1, description: 1, garmentNo: 1 }).lean()
      : [],
    batchIds.length
      ? Garment.aggregate([
          { $match: { branchId: oid(branchId), batchId: { $in: batchIds.map(oid) } } },
          { $group: { _id: '$batchId', count: { $sum: 1 }, type: { $first: '$type' } } },
        ])
      : [],
    readSettings(branchId),
  ]);
  const orderNo = new Map(orders.map((o) => [String(o._id), o.orderNo]));
  const garmentById = new Map(garments.map((g) => [String(g._id), g]));
  const batchById = new Map(batches.map((b) => [String(b._id), b]));
  const typeLabel = (key) => settings.garmentTypes.find((t) => t.key === key)?.label ?? key;
  for (const link of links) {
    const id = linkedId(link);
    const no = orderNo.get(String(link.orderId)) ?? null;
    let label = no ? `Order ${no}` : null;
    if (link.kind === 'garment') {
      const g = garmentById.get(id);
      label = g ? `${typeLabel(g.type)} — ${g.description} (…/${g.garmentNo.split('/').pop()})` : null;
    } else if (link.kind === 'batch') {
      const b = batchById.get(id);
      label = b && no ? `Batch of ${b.count} ${typeLabel(b.type)} on ${no}` : null;
    }
    result.set(`${link.kind}:${id}`, { orderNo: no, label });
  }
  return result;
}

/** The garment filter for costing: the branch's garments matching any of the ids. */
export function costingGarmentFilter(branchId, { garmentIds = [], orderIds = [], batchIds = [] } = {}) {
  const or = [];
  if (garmentIds.length) or.push({ _id: { $in: garmentIds.map(oid) } });
  if (orderIds.length) or.push({ orderId: { $in: orderIds.map(oid) } });
  if (batchIds.length) or.push({ batchId: { $in: batchIds.map(oid) } });
  return { branchId: oid(branchId), $or: or };
}

/**
 * The branch's garments with any of the ids, or in any of the orders or batches, as
 * [{ id, orderId, batchId, index, status }] by order then index (ids as strings).
 */
export async function listCostingGarments(branchId, ids, session) {
  const filter = costingGarmentFilter(branchId, ids);
  if (!filter.$or.length) return [];
  const garments = await Garment.find(filter, { orderId: 1, batchId: 1, index: 1, status: 1 })
    .sort({ orderId: 1, index: 1 })
    .session(session ?? null)
    .lean();
  return garments.map((g) => ({
    id: String(g._id),
    orderId: String(g.orderId),
    batchId: g.batchId ? String(g.batchId) : null,
    index: g.index,
    status: g.status,
  }));
}

export {
  activeOrderCount,
  activeOrdersMatch,
  countOrdersByStatus,
  garmentsReadyBetween,
  garmentsReadyFilter,
  iterateGarmentsReady,
  listOrdersByStatus,
  listOrdersPlaced,
  onHoldOrders,
  orderCounts,
  ordersByStatusMatch,
  ordersPlacedMatch,
} from './reports.js';

import mongoose from 'mongoose';
import { expenseCost } from '@vs/shared/expenses.js';
import { allocateProRata } from '@vs/shared/money.js';
import { listCostingGarments } from '../orders/service.js';
import { Expense } from './model.js';

const { ObjectId } = mongoose.Types;
const oid = (id) => new ObjectId(String(id));
const unique = (values) => [...new Set(values.filter(Boolean))];

/**
 * Active expenses of the branch linked to any of the garments, any of the batches, or (as an
 * order expense) any of the orders. Each branch of the `$or` uses by_garment, by_batch, by_order.
 */
export function expenseLinkFilter(branchId, { garmentIds = [], batchIds = [], orderIds = [] }) {
  const or = [];
  if (garmentIds.length) or.push({ 'link.garmentId': { $in: garmentIds.map(oid) } });
  if (batchIds.length) or.push({ 'link.batchId': { $in: batchIds.map(oid) } });
  if (orderIds.length) or.push({ 'link.orderId': { $in: orderIds.map(oid) }, 'link.kind': 'order' });
  return { branchId: oid(branchId), status: 'active', $or: or };
}

/**
 * What the branch's expenses add to each garment's cost (spec §6.3), for M6: a Map of garment id
 * to { cost, expenses: [{ expenseId, number, kind, share }] }. A garment expense goes whole to its
 * garment; a batch or order expense is split equally, in garment order, across the batch's or
 * order's garments that are not cancelled (rejected ones keep their share), so the parts sum
 * exactly. Voided expenses count nothing; an expense with no garment left to carry it counts
 * nowhere.
 */
export async function expenseCostForGarments(branchId, garmentIds, session) {
  const result = new Map();
  if (!garmentIds.length) return result;
  const garments = await listCostingGarments(branchId, { garmentIds }, session);
  for (const g of garments) result.set(g.id, { cost: 0, expenses: [] });
  if (!garments.length) return result;

  const expenses = await Expense.find(
    expenseLinkFilter(branchId, {
      garmentIds: garments.map((g) => g.id),
      batchIds: unique(garments.map((g) => g.batchId)),
      orderIds: unique(garments.map((g) => g.orderId)),
    }),
    { number: 1, status: 1, total: 1, gst: 1, link: 1, date: 1 },
  )
    .sort({ date: 1, _id: 1 })
    .session(session ?? null)
    .lean();

  const shared = expenses.filter((e) => e.link.kind !== 'garment');
  const members = await listCostingGarments(
    branchId,
    {
      batchIds: unique(shared.filter((e) => e.link.kind === 'batch').map((e) => String(e.link.batchId))),
      orderIds: unique(shared.filter((e) => e.link.kind === 'order').map((e) => String(e.link.orderId))),
    },
    session,
  );
  const carrying = members.filter((m) => m.status !== 'cancelled');
  const byBatch = Map.groupBy(carrying.filter((m) => m.batchId), (m) => m.batchId);
  const byOrder = Map.groupBy(carrying, (m) => m.orderId);

  const credit = (garmentId, expense, share) => {
    const entry = result.get(garmentId);
    if (!entry) return;
    entry.cost += share;
    entry.expenses.push({ expenseId: String(expense._id), number: expense.number, kind: expense.link.kind, share });
  };

  for (const expense of expenses) {
    const cost = expenseCost(expense);
    const { link } = expense;
    if (link.kind === 'garment') {
      credit(String(link.garmentId), expense, cost);
      continue;
    }
    const group = link.kind === 'batch' ? byBatch.get(String(link.batchId)) : byOrder.get(String(link.orderId));
    if (!group?.length) continue;
    const shares = allocateProRata(cost, group.map(() => 1));
    group.forEach((m, i) => credit(m.id, expense, shares[i]));
  }
  return result;
}

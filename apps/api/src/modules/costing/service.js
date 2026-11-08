import { allocateProRata } from '@vs/shared/money.js';
import { validationError } from '../../core/errors.js';
import { orderRevenueLines } from '../billing/service.js';
import { expenseCostForGarments } from '../expenses/service.js';
import { getOrderForBilling } from '../orders/service.js';
import { materialCostForGarments, saleCostForInvoices } from '../stock/service.js';

const MAX_ORDERS = 100;

/** The garments that carry the order's shared figures: those not cancelled (all when every one is). */
function carriersOf(garments) {
  const live = garments.filter((g) => g.status !== 'cancelled');
  return live.length ? live : garments;
}

/** `amount` split equally in garment order across the carriers: a Map of garment id to paise. */
function shareOut(garments, amount) {
  const shares = new Map(garments.map((g) => [String(g._id), 0]));
  if (amount && garments.length) {
    const carriers = carriersOf(garments);
    allocateProRata(amount, carriers.map(() => 1)).forEach((share, i) => shares.set(String(carriers[i]._id), share));
  }
  return shares;
}

/**
 * Billed value per garment (spec §6.3, Decision 16): each garment's own lines (garment and charge
 * lines, net of credit notes) plus an equal share of the order's lines without a garment, split in
 * garment order across garments that are not cancelled (all garments when every one is).
 */
function revenueByGarment(garments, lines) {
  const own = new Map(garments.map((g) => [String(g._id), 0]));
  let unattributed = 0;
  for (const l of lines) {
    if (l.garmentId && own.has(l.garmentId)) own.set(l.garmentId, own.get(l.garmentId) + l.taxable);
    else unattributed += l.taxable;
  }
  return { own, shared: shareOut(garments, unattributed) };
}

/**
 * The order's garments with what each was billed, what its materials and other costs were, and its
 * margin; the order's figures are the exact sums (cancelled garments included, so their costs are
 * not lost). 404 when the order is not the branch's.
 */
export async function garmentCosts(branchId, orderId) {
  const { order, garments } = await getOrderForBilling(branchId, orderId);
  const ids = garments.map((g) => String(g._id));
  const [lines, materials, expenses] = await Promise.all([
    orderRevenueLines(branchId, order._id),
    materialCostForGarments(branchId, ids),
    expenseCostForGarments(branchId, ids),
  ]);
  const { own, shared } = revenueByGarment(garments, lines);
  // Stock sold on the order's bills (material lines without a garment) is shared like their revenue.
  const soldCost = await saleCostForInvoices(branchId, [...new Set(lines.map((l) => l.invoiceId))]);
  const sharedMaterial = shareOut(garments, soldCost);

  const rows = garments.map((g) => {
    const id = String(g._id);
    const sharedRevenue = shared.get(id);
    const revenue = own.get(id) + sharedRevenue;
    const mat = materials.get(id) ?? { cost: 0, lines: [] };
    const exp = expenses.get(id) ?? { cost: 0, expenses: [] };
    const soldShare = sharedMaterial.get(id);
    const material = mat.cost + soldShare;
    return {
      id,
      garmentNo: g.garmentNo,
      description: g.description,
      status: g.status,
      revenue,
      sharedRevenue,
      material,
      sharedMaterial: soldShare,
      expense: exp.cost,
      margin: revenue - material - exp.cost,
      materials: mat.lines,
      expenses: exp.expenses,
    };
  });
  const sum = (key) => rows.reduce((s, r) => s + r[key], 0);
  return {
    order: {
      id: String(order._id),
      orderNo: order.orderNo,
      status: order.status,
      revenue: sum('revenue'),
      material: sum('material'),
      expense: sum('expense'),
      margin: sum('margin'),
    },
    garments: rows,
  };
}

/**
 * Profit of each order (M8 order profitability): a Map of order id to { revenue, material, expense,
 * profit }. At most 100 orders; each is read on its own by index.
 */
export async function orderProfits(branchId, orderIds) {
  if (orderIds.length > MAX_ORDERS) throw validationError([{ path: 'orderIds', message: `At most ${MAX_ORDERS} orders` }]);
  const result = new Map();
  for (const id of orderIds) {
    const { order } = await garmentCosts(branchId, id);
    result.set(String(id), { revenue: order.revenue, material: order.material, expense: order.expense, profit: order.margin });
  }
  return result;
}

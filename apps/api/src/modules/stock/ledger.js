import mongoose from 'mongoose';
import { istDate } from '@vs/shared/fy.js';
import { StockError, applyMovement, avgCostOf, formatQty, isLow } from '@vs/shared/stock.js';
import { clock } from '../../clock.js';
import { businessRule, conflict, notFound } from '../../core/errors.js';
import { emit } from '../../core/notify/emit.js';
import './notifications.js';
import { StockItem, StockMovement } from './model.js';

const REFS = ['garmentId', 'orderId', 'purchaseRequestId', 'expenseId', 'invoiceId'];

/** 422 STOCK_INSUFFICIENT for an item, with what is free now. */
export const stockInsufficient = (item, free = item.onHand - item.reserved) =>
  businessRule('STOCK_INSUFFICIENT', 'Not enough free stock', { stockItemId: String(item._id), name: item.name, free });

/** The branch's item read inside `session`, or 404. */
export async function readItemForMove(branchId, stockItemId, session) {
  if (!mongoose.isValidObjectId(stockItemId)) throw notFound();
  const item = await StockItem.findOne({ _id: stockItemId, branchId }).session(session).lean();
  if (!item) throw notFound();
  return item;
}

/**
 * The only writer of stock balances: one append-only movement plus a guarded update of the item's
 * cached balance, in the caller's transaction (required). `quantity` is signed milli as entered
 * (see applyMovement for directions); `cost` (paise) is needed to put stock in. Refuses with 422
 * STOCK_INSUFFICIENT when anything would go negative, and 409 when the item changed since it was
 * read. When free stock falls below the reorder level, `stock.low` is queued once per dip.
 * Answers the movement and the item as now stored.
 */
export async function moveStock(
  branchId,
  { stockItemId, type, quantity, fromReserved = 0, cost, refs = {}, reason = '' },
  actor,
  session,
) {
  if (!session?.inTransaction?.()) throw new Error('moveStock must run inside a transaction');
  const item = await readItemForMove(branchId, stockItemId, session);

  let next;
  let valueChange;
  try {
    ({ balance: next, valueChange } = applyMovement(
      { onHand: item.onHand, reserved: item.reserved, value: item.value },
      { type, quantity, fromReserved, cost },
    ));
  } catch (err) {
    if (err instanceof StockError) throw stockInsufficient(item, err.free);
    throw err;
  }

  const onHandChange = next.onHand - item.onHand;
  const reservedChange = next.reserved - item.reserved;
  const low = isLow({ ...next, reorderLevel: item.reorderLevel });
  const turnsLow = low && !item.low;
  const lowSeq = turnsLow ? item.lowSeq + 1 : item.lowSeq;
  const now = clock.now();
  const movementId = new mongoose.Types.ObjectId();

  const set = {
    ...next,
    avgCost: avgCostOf(next),
    low,
    lowSeq,
    hasMovements: true,
    ...(valueChange !== 0 || onHandChange !== 0 ? { lastValueMovementId: movementId } : {}),
  };
  const result = await StockItem.updateOne(
    { _id: item._id, balanceSeq: item.balanceSeq },
    { $set: set, $inc: { balanceSeq: 1 } },
    { session, runValidators: true },
  );
  if (result.matchedCount === 0) throw conflict();

  const [movement] = await StockMovement.create(
    [
      {
        _id: movementId,
        branchId: item.branchId,
        stockItemId: item._id,
        type,
        quantity,
        onHandChange,
        reservedChange,
        valueChange,
        onHandAfter: next.onHand,
        reservedAfter: next.reserved,
        valueAfter: next.value,
        ...Object.fromEntries(REFS.map((k) => [k, refs[k] ?? null])),
        reason,
        by: actor?.userId ?? null,
        at: now,
        date: istDate(now),
      },
    ],
    { session },
  );

  const stored = { ...item, ...set, balanceSeq: item.balanceSeq + 1 };
  if (turnsLow) {
    await emit(
      'stock.low',
      {
        branchId: item.branchId,
        refId: String(item._id),
        sequence: lowSeq,
        vars: {
          name: item.name,
          free: formatQty(next.onHand - next.reserved, item.usageUnit),
          reorderLevel: formatQty(item.reorderLevel, item.usageUnit),
          link: `/stock/items/${item._id}`,
        },
      },
      { session },
    );
  }
  return { movement: movement.toObject(), item: stored };
}

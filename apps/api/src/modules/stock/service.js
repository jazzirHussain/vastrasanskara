import { costAtAverage, isLow, unitCostToValue } from '@vs/shared/stock.js';
import { diff } from '../../core/audit/diff.js';
import { recordAudit } from '../../core/audit/service.js';
import { withTransaction } from '../../core/db.js';
import { businessRule, conflict, validationError } from '../../core/errors.js';
import { moveStock } from './ledger.js';
import { StockItem } from './model.js';
import { getItem } from './queries.js';

export { moveStock } from './ledger.js';
export { garmentMaterialsView, getItem, listItems, listMovements, lowStockItems, pickerItems } from './queries.js';
export {
  addShortfall,
  changeUsedMaterials,
  consumeAtMaterialsReady,
  copyGarmentMaterials,
  dropNeeds,
  garmentFacts,
  planNewGarments,
  releaseGarments,
  setGarmentMaterials,
} from './reservations.js';

const EDITABLE = [
  'name', 'brand', 'category', 'colour', 'usageUnit', 'purchaseUnit', 'factor', 'step', 'reorderLevel', 'sellingPrice', 'active',
];
const auditView = (item) => Object.fromEntries(EDITABLE.map((f) => [f, item[f] ?? null]));

/**
 * Adds a stock item; `opening` stock (quantity at a cost per usage unit) goes in as its first
 * movement. Creating an item never sends a low-stock alert: `low` starts as the empty item's.
 */
export function createItem(branchId, input, actor) {
  const { opening, ...fields } = input;
  return withTransaction(async (session) => {
    const [created] = await StockItem.create(
      [
        {
          ...fields,
          branchId,
          searchName: fields.name.toLowerCase(),
          low: isLow({ onHand: 0, reserved: 0, reorderLevel: fields.reorderLevel ?? 0 }),
          createdBy: actor.userId ?? null,
          updatedBy: actor.userId ?? null,
        },
      ],
      { session },
    );
    let item = created.toObject();
    if (opening) {
      ({ item } = await moveStock(
        branchId,
        { stockItemId: item._id, type: 'opening', quantity: opening.quantity, cost: unitCostToValue(opening.unitCost, opening.quantity) },
        actor,
        session,
      ));
    }
    await recordAudit(
      {
        branchId,
        entityType: 'stock_item',
        entityId: item._id,
        action: 'create',
        before: null,
        after: { ...auditView(item), opening: opening ?? null },
        actor,
      },
      session,
    );
    return item;
  });
}

/**
 * Edits an item at `version` (409 when someone else saved first). The usage unit and conversion
 * are fixed once stock has moved (422 UNIT_FIXED). A new reorder level recomputes `low` without
 * an alert. Audited when something changed; nothing changed writes nothing.
 */
export function updateItem(branchId, id, { version, patch }, actor) {
  return withTransaction(async (session) => {
    const current = await getItem(branchId, id, session);
    if (current.__v !== version) throw conflict();
    const unitChanged = ['usageUnit', 'factor'].some((f) => patch[f] !== undefined && patch[f] !== current[f]);
    if (unitChanged && current.hasMovements) {
      throw businessRule('UNIT_FIXED', 'The unit cannot change once stock has moved');
    }
    const before = auditView(current);
    const after = auditView({ ...current, ...patch });
    if (!diff(before, after).length) return current;

    const set = { ...patch, updatedBy: actor.userId ?? null };
    if (patch.name !== undefined) set.searchName = patch.name.toLowerCase();
    if (patch.reorderLevel !== undefined) set.low = isLow({ ...current, reorderLevel: patch.reorderLevel });
    const updated = await StockItem.findOneAndUpdate(
      { _id: current._id, branchId: current.branchId, __v: version },
      { $set: set, $inc: { __v: 1 } },
      { session, new: true, runValidators: true },
    ).lean();
    if (!updated) throw conflict();
    await recordAudit({ branchId, entityType: 'stock_item', entityId: current._id, action: 'update', before, after, actor }, session);
    return updated;
  });
}

const fieldError = (path, message) => validationError([{ path, message }]);

/**
 * Records a shelf count. `expectedOnHand` is what the screen showed: if stock moved since, 409.
 * The difference is one `adjust` movement: up is valued at `unitCost` when given (required when
 * the shelf was empty), else at the average; down is taken out at the average. Audited.
 */
export function countStock(branchId, id, { counted, expectedOnHand, unitCost, reason }, actor) {
  return withTransaction(async (session) => {
    const current = await getItem(branchId, id, session);
    if (current.onHand !== expectedOnHand) throw conflict();
    const change = counted - current.onHand;
    if (change === 0) throw businessRule('NOTHING_TO_CHANGE', 'The count matches what is in stock');
    let cost;
    if (change > 0) {
      if (unitCost === undefined && current.onHand === 0) throw fieldError('unitCost', 'Enter the cost per unit');
      cost = unitCost !== undefined ? unitCostToValue(unitCost, change) : costAtAverage(current.avgCost, change);
    }
    const { movement, item } = await moveStock(
      branchId,
      { stockItemId: current._id, type: 'adjust', quantity: change, cost, reason },
      actor,
      session,
    );
    await recordAudit(
      {
        branchId,
        entityType: 'stock_item',
        entityId: current._id,
        action: 'count',
        before: { onHand: current.onHand },
        after: { onHand: counted, reason, valueChange: movement.valueChange },
        actor,
      },
      session,
    );
    return item;
  });
}


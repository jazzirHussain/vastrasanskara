const idOf = (id) => (id ? String(id) : null);

/** A stock item as the API answers; money fields only with `money` (money.view). */
export function toItemJson(item, { money = false } = {}) {
  return {
    id: String(item._id),
    name: item.name,
    brand: item.brand ?? '',
    category: item.category ?? '',
    colour: item.colour ?? '',
    usageUnit: item.usageUnit,
    purchaseUnit: item.purchaseUnit,
    factor: item.factor,
    step: item.step,
    reorderLevel: item.reorderLevel,
    onHand: item.onHand,
    reserved: item.reserved,
    free: item.onHand - item.reserved,
    low: Boolean(item.low),
    active: item.active,
    version: item.__v,
    ...(money && { value: item.value, avgCost: item.avgCost, sellingPrice: item.sellingPrice ?? null }),
  };
}

/** A stock movement as the API answers; `names` are user names by id; value only with `money`. */
export function toMovementJson(m, { names, money = false } = {}) {
  return {
    id: String(m._id),
    type: m.type,
    quantity: m.quantity,
    onHandChange: m.onHandChange,
    reservedChange: m.reservedChange,
    onHandAfter: m.onHandAfter,
    reservedAfter: m.reservedAfter,
    ref: {
      garmentId: idOf(m.garmentId),
      orderId: idOf(m.orderId),
      purchaseRequestId: idOf(m.purchaseRequestId),
      expenseId: idOf(m.expenseId),
      invoiceId: idOf(m.invoiceId),
    },
    reason: m.reason ?? '',
    by: m.by ? { id: String(m.by), name: names?.get(String(m.by)) ?? '' } : null,
    at: m.at,
    date: m.date,
    ...(money && { valueChange: m.valueChange, valueAfter: m.valueAfter }),
  };
}

/**
 * A "to buy" request as the API answers. `names` are vendor names by id, `item` the request's
 * stock item; the receipt's value only with `money`.
 */
export function toRequestJson(r, { names, item, money = false } = {}) {
  const { receipt, cancellation } = r;
  return {
    id: String(r._id),
    stockItem: {
      id: String(r.stockItemId),
      name: item?.name ?? '',
      usageUnit: item?.usageUnit ?? '',
      purchaseUnit: item?.purchaseUnit ?? '',
      factor: item?.factor ?? 1000,
    },
    quantity: r.quantity,
    reason: r.reason,
    needs: (r.needs ?? []).map((n) => ({
      garmentId: String(n.garmentId),
      garmentNo: n.garmentNo,
      orderId: String(n.orderId),
      quantity: n.quantity,
    })),
    note: r.note ?? '',
    status: r.status,
    vendor: r.vendorId ? { id: String(r.vendorId), name: names?.get(String(r.vendorId)) ?? '' } : null,
    orderedAt: r.orderedAt ?? null,
    receipt: receipt
      ? { quantity: receipt.quantity, date: receipt.date, expenseId: String(receipt.expenseId), ...(money && { value: receipt.value }) }
      : null,
    cancellation: cancellation ? { reason: cancellation.reason, at: cancellation.at, by: idOf(cancellation.by) } : null,
    version: r.__v,
  };
}

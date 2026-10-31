import { expenseCost } from '@vs/shared/expenses.js';

const idOf = (id) => (id ? String(id) : null);

// A hidden category keeps its label; a key no longer in settings shows the key.
function categoryOf(key, categories = []) {
  const found = categories.find((c) => c.key === key);
  return { key, label: found?.label ?? key };
}

const userOf = (id, names) => (id ? { id: String(id), name: names?.get(String(id)) ?? '' } : null);

function linkOf(link, linkLabels) {
  if (!link) return null;
  const id = link.garmentId ?? link.batchId ?? link.orderId;
  const label = linkLabels?.get(String(id)) ?? {};
  return {
    kind: link.kind,
    id: String(id),
    orderId: String(link.orderId),
    orderNo: label.orderNo ?? null,
    label: label.label ?? null,
  };
}

function gstOf(gst) {
  if (!gst) return null;
  return {
    billNo: gst.billNo,
    billDate: gst.billDate,
    rateBp: gst.rateBp ?? null,
    taxable: gst.taxable,
    cgst: gst.cgst,
    sgst: gst.sgst,
    igst: gst.igst,
    tax: gst.cgst + gst.sgst + gst.igst,
    interState: Boolean(gst.interState),
    itcEligible: Boolean(gst.itcEligible),
  };
}

/**
 * An expense as the API answers. `categories` are the settings' expense categories, `names` user
 * names by id, `linkLabels` { orderNo, label } by linked id, `monthLocked` whether its month is locked.
 */
export function toExpenseJson(expense, { categories, names, linkLabels, monthLocked = false } = {}) {
  return {
    id: String(expense._id),
    number: expense.number,
    date: expense.date,
    month: expense.month,
    category: categoryOf(expense.category, categories),
    note: expense.note ?? '',
    payee: {
      vendorId: idOf(expense.payee.vendorId),
      name: expense.payee.name,
      gstin: expense.payee.gstin ?? null,
      stateCode: expense.payee.stateCode ?? null,
    },
    total: expense.total,
    mode: expense.mode,
    reference: expense.reference ?? '',
    gst: gstOf(expense.gst),
    cost: expenseCost(expense),
    attachments: (expense.attachments ?? []).map((a) => ({ key: a.key, name: a.name, contentType: a.contentType, size: a.size })),
    link: linkOf(expense.link, linkLabels),
    status: expense.status,
    void: expense.void ? { reason: expense.void.reason, at: expense.void.at, by: userOf(expense.void.by, names) } : null,
    monthLocked: Boolean(monthLocked),
    source: expense.source,
    createdBy: userOf(expense.createdBy, names),
    createdAt: expense.createdAt,
    updatedAt: expense.updatedAt,
    version: expense.__v,
  };
}

/** A row of the expense list. */
export function toExpenseRowJson(expense, { categories } = {}) {
  return {
    id: String(expense._id),
    number: expense.number,
    date: expense.date,
    category: categoryOf(expense.category, categories),
    payee: { name: expense.payee.name },
    total: expense.total,
    mode: expense.mode,
    hasGst: Boolean(expense.gst),
    photos: (expense.attachments ?? []).length,
    linked: Boolean(expense.link),
    status: expense.status,
  };
}

import { computeInvoice, GstError, toMilli } from '@vs/shared/gst.js';
import { mulDivRound, rupeesToPaise } from '@vs/shared/money.js';

// The draft bill as the person edits it: prices and discounts as typed (rupees or %), turned into
// paise only for saving and for the live totals, with the same maths as the server.

/** 4500 → '45', 4550 → '45.50' (no float division). */
export function paiseToInput(paise) {
  const rupees = Math.floor(paise / 100);
  const rest = paise % 100;
  return rest ? `${rupees}.${String(rest).padStart(2, '0')}` : String(rupees);
}

/** Typed rupees → paise; '' is 0; null when it is not an amount. */
export function parsePaise(value) {
  if (value === '' || value === null || value === undefined) return 0;
  try {
    const paise = rupeesToPaise(String(value));
    return paise >= 0 ? paise : null;
  } catch {
    return null;
  }
}

function parseQuantity(value) {
  try {
    const milli = toMilli(value);
    return milli > 0 && milli <= 9_999_000 ? milli : null;
  } catch {
    return null;
  }
}

const emptyDiscount = (reason = '') => ({ mode: 'amount', value: '', reason });
const discountFrom = (paise, reason) => (paise ? { mode: 'amount', value: paiseToInput(paise), reason } : emptyDiscount(reason));

/** Discount in paise on `base` paise; null when it is not a valid amount or percentage. */
export function discountPaise(discount, base) {
  if (discount.mode === 'amount') return parsePaise(discount.value);
  const bp = parsePaise(discount.value); // hundredths of a percent, the same parse as rupees
  if (bp === null || bp > 10000) return null;
  return mulDivRound(base, bp, 10000);
}

/** The same discount in the other mode (₹ ↔ %), so switching keeps what was given. */
export function switchDiscountMode(discount, base) {
  const mode = discount.mode === 'amount' ? 'percent' : 'amount';
  const paise = discountPaise(discount, base);
  if (!paise || !base) return { ...discount, mode, value: '' };
  if (mode === 'amount') return { ...discount, mode, value: paiseToInput(paise) };
  return { ...discount, mode, value: paiseToInput(mulDivRound(paise, 10000, base)) };
}

const lineForm = (l) => ({
  key: l.key,
  itemId: l.itemId,
  garmentId: l.garmentId,
  stageEventId: l.stageEventId,
  source: l.source,
  description: l.description,
  quantity: l.quantity,
  price: paiseToInput(l.rate),
  discount: discountFrom(l.discount, l.discountReason ?? ''),
});

export function formFrom(invoice) {
  return {
    lines: invoice.lines.map(lineForm),
    billDiscount: discountFrom(invoice.invoiceDiscount?.amount ?? 0, invoice.invoiceDiscount?.reason ?? ''),
    notes: invoice.notes ?? '',
  };
}

/** A new line for a price-list item, at its usual price. */
export function lineForItem(item) {
  return {
    key: `m-${crypto.randomUUID().slice(0, 8)}`,
    itemId: item.id,
    garmentId: null,
    stageEventId: null,
    source: 'manual',
    description: item.name,
    quantity: 1,
    price: paiseToInput(item.defaultPrice),
    discount: emptyDiscount(),
  };
}

/**
 * A line's figures and what is wrong with it. `errors` stop the draft being saved (it would be
 * refused); `warnings` only stop it being issued.
 */
export function checkLine(line) {
  const rate = parsePaise(line.price);
  const qtyMilli = parseQuantity(line.quantity);
  const gross = rate !== null && qtyMilli !== null ? mulDivRound(rate, qtyMilli, 1000) : null;
  const discount = gross === null ? null : discountPaise(line.discount, gross);
  const errors = {};
  const warnings = {};
  if (!line.description.trim()) errors.description = 'Say what this line is';
  if (rate === null) errors.price = 'Enter the price in rupees';
  if (qtyMilli === null) errors.quantity = 'Enter how many';
  if (gross !== null && discount === null) errors.discount = line.discount.mode === 'percent' ? 'Enter a percentage up to 100' : 'Enter the discount in rupees';
  else if (discount !== null && discount > gross) errors.discount = 'The discount is more than the price';
  if (discount > 0 && !line.discount.reason.trim()) errors.reason = 'Say why there is a discount';
  if (!line.itemId) warnings.item = 'Choose what to bill this as';
  if (rate === 0) warnings.price = 'Enter the price';
  return { rate, gross, discount, amount: gross !== null && discount !== null ? gross - discount : null, errors, warnings };
}

const hasAny = (o) => Object.keys(o).length > 0;

/** The whole form checked: per-line results, the bill discount, and whether it can be saved / issued. */
export function checkForm(form) {
  const lines = form.lines.map(checkLine);
  const base = lines.every((l) => l.amount !== null) ? lines.reduce((s, l) => s + l.amount, 0) : null;
  const billDiscount = base === null ? null : discountPaise(form.billDiscount, base);
  const billErrors = {};
  if (base !== null && billDiscount === null) billErrors.discount = 'Enter the discount in rupees or %';
  else if (billDiscount !== null && billDiscount > base) billErrors.discount = 'The discount is more than the bill';
  if (billDiscount > 0 && !form.billDiscount.reason.trim()) billErrors.reason = 'Say why there is a discount';
  const canSave = lines.every((l) => !hasAny(l.errors)) && !hasAny(billErrors);
  const canIssue = canSave && lines.length > 0 && lines.every((l) => !hasAny(l.warnings));
  return { lines, billDiscount, billErrors, canSave, canIssue };
}

/** The PUT body without `version` (only for a form that can be saved). */
export function toBody(form, checked = checkForm(form)) {
  return {
    lines: form.lines.map((l, i) => {
      const c = checked.lines[i];
      return {
        key: l.key,
        itemId: l.itemId,
        garmentId: l.garmentId,
        stageEventId: l.stageEventId,
        source: l.source,
        description: l.description.trim(),
        quantity: Number(l.quantity),
        rate: c.rate,
        discount: c.discount,
        discountReason: c.discount > 0 ? l.discount.reason.trim() : '',
      };
    }),
    invoiceDiscount: checked.billDiscount > 0 ? { amount: checked.billDiscount, reason: form.billDiscount.reason.trim() } : null,
    notes: form.notes.trim(),
  };
}

/**
 * Live totals with the server's maths: { calc } or { missing: 'item' } while a line has no
 * item, or { code } for an error the server would refuse it with.
 */
export function previewTotals(form, checked, itemsById, interState) {
  if (!form.lines.length) return { code: 'NO_LINES' };
  if (form.lines.some((l) => !itemsById.has(l.itemId))) return { missing: 'item' };
  if (!checked.canSave) return { code: 'INVALID_AMOUNT' };
  try {
    const calc = computeInvoice({
      lines: form.lines.map((l, i) => {
        const item = itemsById.get(l.itemId);
        return { key: l.key, quantity: Number(l.quantity), rate: checked.lines[i].rate, discount: checked.lines[i].discount, hsnSac: item.hsnSac, gstSlabs: item.gstSlabs };
      }),
      invoiceDiscount: checked.billDiscount ?? 0,
      interState,
    });
    return { calc };
  } catch (error) {
    return { code: error instanceof GstError ? error.code : 'INVALID_AMOUNT' };
  }
}

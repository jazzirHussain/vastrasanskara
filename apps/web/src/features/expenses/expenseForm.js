import { payeeInterState, splitGstFromTotal } from '@vs/shared/expenses.js';
import { rupeesToPaise } from '@vs/shared/money.js';
import { paiseOf, rupeeText } from '../billing/rupees.js';

const NO_PAYEE = { vendorId: null, name: '', gstin: null, stateCode: null };

/** A fresh form for a new expense paid on `today`. */
export function emptyExpenseForm(today) {
  return {
    amount: '',
    category: '',
    payee: { ...NO_PAYEE },
    mode: 'cash',
    reference: '',
    photos: [],
    date: today,
    note: '',
    gstOpen: false,
    gst: { gstin: '', billNo: '', billDate: '', rateBp: 1800, interState: null, edited: null, itcEligible: true },
    link: null,
  };
}

const figureText = (paise) => (paise > 0 ? rupeeText(paise) : '');

/** The form for an expense as the API returns it. */
export function expenseToForm(expense) {
  const gst = expense.gst;
  return {
    amount: rupeeText(expense.total),
    category: expense.category.key,
    payee: { vendorId: expense.payee.vendorId, name: expense.payee.name, gstin: expense.payee.gstin, stateCode: expense.payee.stateCode },
    mode: expense.mode,
    reference: expense.reference,
    photos: expense.attachments.map((a) => ({ id: a.key, key: a.key, name: a.name, status: 'done' })),
    date: expense.date,
    note: expense.note,
    gstOpen: Boolean(gst),
    gst: {
      gstin: expense.payee.gstin ?? '',
      billNo: gst?.billNo ?? '',
      billDate: gst?.billDate ?? '',
      rateBp: gst ? gst.rateBp : 1800,
      interState: gst ? gst.interState : null,
      // The stored figures are kept as typed so an edit that does not touch them sends them unchanged.
      edited: gst ? { taxable: figureText(gst.taxable), cgst: figureText(gst.cgst), igst: figureText(gst.igst) } : null,
      itcEligible: gst ? gst.itcEligible : true,
    },
    link: expense.link ? { kind: expense.link.kind, id: expense.link.id, label: linkText(expense.link) } : null,
  };
}

const typedPaise = (text) => {
  if (text === '' || text === undefined || text === null) return 0;
  try {
    return Math.max(0, rupeesToPaise(text));
  } catch {
    return 0;
  }
};

/**
 * The GST split of a total. Computed from the total and the rate unless `edited`
 * ({ taxable, cgst, igst } as typed rupee text) holds the figures from the paper bill.
 * "Mixed rates" (`rateBp` null) has no rate to compute from: staff type the figures.
 */
export function gstFigures({ totalPaise, rateBp, interState, edited = null }) {
  if (edited) {
    const cgst = typedPaise(edited.cgst);
    return { taxable: typedPaise(edited.taxable), cgst, sgst: cgst, igst: typedPaise(edited.igst) };
  }
  if (rateBp === null || rateBp === undefined) return { taxable: totalPaise, cgst: 0, sgst: 0, igst: 0 };
  const { taxable, cgst, sgst, igst } = splitGstFromTotal({ total: totalPaise, rateBp, interState });
  return { taxable, cgst, sgst, igst };
}

/** The supplier's GSTIN: the vendor's, else the one typed in the GST section, else a remembered one. */
export function payeeGstin(form) {
  if (form.payee.vendorId) return form.payee.gstin ?? '';
  return (form.gstOpen ? form.gst.gstin : (form.payee.gstin ?? '')).trim().toUpperCase();
}

/** Whether the bill defaults to (or is switched to) IGST. */
export function isInterState(form, branchStateCode) {
  if (form.gst.interState !== null) return form.gst.interState;
  // A half-typed GSTIN or an unknown state code cannot say where the supplier is: assume the same state.
  try {
    const gstin = payeeGstin(form);
    return payeeInterState({ branchStateCode, payee: { gstin: gstin.length === 15 ? gstin : null, stateCode: form.payee.stateCode } });
  } catch {
    return false;
  }
}

/** The figures the GST section shows for this form. */
export function figuresOf(form, branchStateCode) {
  return gstFigures({
    totalPaise: paiseOf(form.amount) ?? 0,
    rateBp: form.gst.rateBp,
    interState: isInterState(form, branchStateCode),
    edited: form.gst.edited,
  });
}

/** The expenseSchema input for this form (paise; `gst` null when the GST section is folded). */
export function formToBody(form, { branchStateCode }) {
  const total = paiseOf(form.amount) ?? 0;
  const name = form.payee.name.trim();
  let payee;
  if (form.payee.vendorId) {
    payee = { vendorId: form.payee.vendorId, name };
  } else {
    const gstin = payeeGstin(form) || null;
    payee = { vendorId: null, name, gstin, stateCode: gstin?.length === 15 ? gstin.slice(0, 2) : form.payee.stateCode };
  }
  let gst = null;
  if (form.gstOpen) {
    const figures = figuresOf(form, branchStateCode);
    gst = {
      billNo: form.gst.billNo.trim(),
      billDate: form.gst.billDate || form.date,
      rateBp: form.gst.rateBp,
      ...figures,
      itcEligible: form.gst.itcEligible,
    };
  }
  return {
    date: form.date,
    category: form.category,
    note: form.note.trim(),
    payee,
    total,
    mode: form.mode,
    reference: form.mode === 'cash' ? '' : form.reference.trim(),
    gst,
    attachments: form.photos.filter((p) => p.status === 'done').map((p) => ({ key: p.key, name: p.name })),
    link: form.link ? { kind: form.link.kind, id: form.link.id } : null,
  };
}

/** What an edit sends: only the top-level fields that differ from the saved expense. */
export function changedFields(form, original, options) {
  const now = formToBody(form, options);
  const then = formToBody(expenseToForm(original), options);
  return Object.fromEntries(Object.entries(now).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(then[key])));
}

/** 'VS/ORD/0001 · Bridal lehenga'; the label may already name the order, so it is not repeated. */
function linkText({ orderNo, label }) {
  if (orderNo && label && label.includes(orderNo)) return label;
  return [orderNo, label].filter(Boolean).join(' · ');
}

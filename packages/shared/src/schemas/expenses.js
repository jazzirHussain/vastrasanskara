import { z } from 'zod';
import { billingAmount, categoryKey, gstin, objectId, stateCode } from './common.js';
import { ymd } from './orders.js';
import { PAYMENT_MODES } from './billing.js';
import { GST_RATES_BP } from '../gst.js';
import { checkExpenseTax, EXPENSE_LINK_KINDS, MAX_EXPENSE_ATTACHMENTS } from '../expenses.js';

export { categoryKey };

const text = (max) => z.string().trim().max(max);

const payeeFields = {
  vendorId: objectId.nullable(),
  name: text(100),
  gstin: gstin.nullable(),
  stateCode: stateCode.nullable(),
};

const gstFields = {
  billNo: z.string().trim().min(1).max(16).regex(/^[A-Za-z0-9/-]+$/, 'Use letters, digits, / and -'),
  billDate: ymd,
  rateBp: z.union(GST_RATES_BP.map((r) => z.literal(r))).nullable(),
  taxable: billingAmount,
  cgst: billingAmount,
  sgst: billingAmount,
  igst: billingAmount,
  itcEligible: z.boolean(),
};

const attachments = z
  .array(z.strictObject({ key: z.string().min(1).max(300), name: text(120) }))
  .max(MAX_EXPENSE_ATTACHMENTS)
  .refine((rows) => new Set(rows.map((r) => r.key)).size === rows.length, 'Each photo can be added once');

// The fields shared by create and patch, without defaults.
const fields = {
  date: ymd,
  category: categoryKey,
  note: text(300),
  payee: z.strictObject(payeeFields),
  total: billingAmount.positive(),
  mode: z.enum(PAYMENT_MODES),
  reference: text(100),
  gst: z.strictObject(gstFields).nullable(),
  attachments,
  link: z.strictObject({ kind: z.enum(EXPENSE_LINK_KINDS), id: objectId }).nullable(),
};

/** Rules that need several fields at once. Exported so the service re-checks merged edits. */
export function checkExpenseRules(value, ctx) {
  const { payee, gst } = value;
  if (payee && !payee.vendorId && !payee.name) {
    ctx.addIssue({ code: 'custom', path: ['payee', 'name'], message: 'Say who was paid' });
  }
  if (payee?.gstin && payee.stateCode && payee.gstin.slice(0, 2) !== payee.stateCode) {
    ctx.addIssue({ code: 'custom', path: ['payee', 'stateCode'], message: 'State code must match the GSTIN' });
  }
  if (gst && value.total !== undefined) {
    for (const issue of checkExpenseTax({ total: value.total, gst })) {
      ctx.addIssue({ code: 'custom', path: issue.path.split('.'), message: issue.message });
    }
  }
  if (gst && value.date && gst.billDate > value.date) {
    ctx.addIssue({ code: 'custom', path: ['gst', 'billDate'], message: 'The bill date cannot be after the payment date' });
  }
}

/** POST /v1/expenses. */
export const expenseSchema = z
  .strictObject({
    ...fields,
    note: fields.note.default(''),
    payee: z.strictObject({
      vendorId: payeeFields.vendorId.default(null),
      name: payeeFields.name.default(''),
      gstin: payeeFields.gstin.default(null),
      stateCode: payeeFields.stateCode.default(null),
    }),
    reference: fields.reference.default(''),
    gst: z.strictObject({ ...gstFields, itcEligible: gstFields.itcEligible.default(true) }).nullable().default(null),
    attachments: attachments.default([]),
    link: fields.link.default(null),
  })
  .superRefine(checkExpenseRules);

/** PATCH /v1/expenses/:id (with `version`): any subset; the service re-checks the merged expense. */
export const expensePatchSchema = z
  .strictObject(fields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

export const expenseVoidSchema = z.strictObject({ reason: z.string().trim().min(1).max(300) });

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export const expenseListQuery = z
  .strictObject({
    month: month.optional(),
    from: ymd.optional(),
    to: ymd.optional(),
    category: categoryKey.optional(),
    vendorId: objectId.optional(),
    orderId: objectId.optional(),
    status: z.enum(['active', 'voided', 'all']).default('active'),
    noBill: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
    q: z.string().max(30).optional(),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .refine((v) => !(v.month && (v.from || v.to)), 'Choose a month or a date range, not both');

export const expenseSummaryQuery = z.strictObject({ month });

export const payeesQuery = z.strictObject({ q: z.string().trim().max(50).optional() });

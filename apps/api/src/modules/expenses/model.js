import mongoose from 'mongoose';
import { PAYMENT_MODES } from '@vs/shared/schemas/billing.js';
import { EXPENSE_LINK_KINDS } from '@vs/shared/expenses.js';
import { commonFields } from '../../core/commonFields.js';

const { ObjectId } = mongoose.Schema.Types;

/** Thrown by the model when an expense would be deleted, replaced, bulk-updated or changed after voiding. */
export class ExpenseImmutableError extends Error {
  constructor(message = 'Expenses cannot be deleted, and a voided expense cannot change') {
    super(message);
    this.name = 'ExpenseImmutableError';
  }
}

const paise = (required = false) => ({
  type: Number,
  ...(required ? { required: true } : { default: 0 }),
  min: 0,
  validate: { validator: Number.isSafeInteger, message: 'amounts are whole paise' },
});

const sub = (fields) => new mongoose.Schema(fields, { _id: false });

// Who was paid, as it was at the time (later vendor edits do not change it).
const payeeSchema = sub({
  vendorId: { type: ObjectId, ref: 'Vendor', default: null },
  name: { type: String, default: '' },
  // Lower-case name, for "recent payees" and search.
  searchName: { type: String, default: '' },
  gstin: { type: String, default: null },
  stateCode: { type: String, default: null },
});

const gstSchema = sub({
  billNo: { type: String, required: true },
  billDate: { type: String, required: true },
  rateBp: { type: Number, default: null },
  taxable: paise(),
  cgst: paise(),
  sgst: paise(),
  igst: paise(),
  interState: { type: Boolean, default: false },
  itcEligible: { type: Boolean, default: true },
});

const attachmentSchema = sub({
  key: { type: String, required: true },
  name: { type: String, default: '' },
  contentType: { type: String, required: true },
  size: { type: Number, required: true },
  // The photo's SHA-256 when it was saved, for "Check records"; null for older photos.
  sha256: { type: String, default: null },
});

const linkSchema = sub({
  kind: { type: String, enum: EXPENSE_LINK_KINDS, required: true },
  orderId: { type: ObjectId, ref: 'Order', required: true },
  garmentId: { type: ObjectId, default: null },
  batchId: { type: ObjectId, default: null },
});

const voidSchema = sub({
  reason: { type: String, required: true },
  at: { type: Date, required: true },
  by: { type: ObjectId, ref: 'User', required: true },
});

// Money the branch paid out (spec §6.1). Never deleted: a mistake is voided with a reason.
// Business dates ('YYYY-MM-DD', IST) are strings; `fyCode` is the financial year of `date`.
const expenseSchema = new mongoose.Schema(
  {
    branchId: { type: ObjectId, ref: 'Branch', required: true },
    number: { type: String, required: true },
    fyCode: { type: String, required: true },
    date: { type: String, required: true },
    month: { type: String, required: true },
    category: { type: String, required: true },
    note: { type: String, default: '' },
    payee: { type: payeeSchema, required: true },
    // What was paid, GST included.
    total: paise(true),
    mode: { type: String, enum: PAYMENT_MODES, required: true },
    reference: { type: String, default: '' },
    gst: { type: gstSchema, default: null },
    attachments: { type: [attachmentSchema], default: [] },
    link: { type: linkSchema, default: null },
    status: { type: String, enum: ['active', 'voided'], default: 'active' },
    void: { type: voidSchema, default: null },
    source: { type: String, enum: ['manual', 'purchase'], default: 'manual' },
    sourceRef: { type: String, default: null },
  },
  { collection: 'expenses', minimize: false },
);
expenseSchema.plugin(commonFields);

const objectIdOnly = (path) => ({ [path]: { $type: 'objectId' } });
expenseSchema.index({ branchId: 1, fyCode: 1, number: 1 }, { name: 'number_unique', unique: true });
expenseSchema.index({ branchId: 1, date: 1, _id: 1 }, { name: 'by_date' });
expenseSchema.index({ branchId: 1, category: 1, date: 1, _id: 1 }, { name: 'by_category' });
expenseSchema.index(
  { branchId: 1, 'payee.vendorId': 1, date: 1 },
  { name: 'by_vendor', partialFilterExpression: objectIdOnly('payee.vendorId') },
);
expenseSchema.index({ 'link.orderId': 1 }, { name: 'by_order', partialFilterExpression: objectIdOnly('link.orderId') });
expenseSchema.index({ 'link.garmentId': 1 }, { name: 'by_garment', partialFilterExpression: objectIdOnly('link.garmentId') });
expenseSchema.index({ 'link.batchId': 1 }, { name: 'by_batch', partialFilterExpression: objectIdOnly('link.batchId') });
expenseSchema.index({ branchId: 1, 'attachments.key': 1 }, { name: 'attachments' });

// --- Never deleted; a voided expense never changes -----------------------------------------------

expenseSchema.post('init', function rememberStatus() {
  this.$locals.wasStatus = this.status;
});
expenseSchema.post('save', function rememberStatus() {
  this.$locals.wasStatus = this.status;
});
expenseSchema.pre('save', function refuseVoidedChanges() {
  if (!this.isNew && this.$locals.wasStatus === 'voided') {
    throw new ExpenseImmutableError('A voided expense cannot change');
  }
});

const refuse = function refuse() {
  throw new ExpenseImmutableError('Expenses cannot be deleted, replaced or changed in bulk');
};
for (const op of ['deleteOne', 'deleteMany', 'findOneAndDelete', 'replaceOne', 'findOneAndReplace', 'updateMany']) {
  expenseSchema.pre(op, { document: false, query: true }, refuse);
}
expenseSchema.pre('deleteOne', { document: true, query: false }, refuse);

export const Expense = mongoose.models.Expense ?? mongoose.model('Expense', expenseSchema);

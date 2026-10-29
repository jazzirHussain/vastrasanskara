import mongoose from 'mongoose';
import { PAYMENT_MODES } from '@vs/shared/schemas/billing.js';
import { commonFields } from '../../core/commonFields.js';

const { ObjectId, Mixed } = mongoose.Schema.Types;

/** Thrown by the model when an issued or cancelled document would change (services → 422). */
export class ImmutableDocumentError extends Error {
  constructor(message = 'Issued documents cannot be changed') {
    super(message);
    this.name = 'ImmutableDocumentError';
  }
}

// The only paths that may change once a document is issued (spec §5.3).
export const MUTABLE_PATHS = ['status', 'cancellation', 'pdf', 'settlement', 'remindersPaused', 'updatedAt', 'updatedBy', '__v'];
const isMutablePath = (path) => MUTABLE_PATHS.some((p) => path === p || path.startsWith(`${p}.`));

const money = { type: Number, default: 0 };
// Money that moves (a receipt or refund): whole paise, at least 1.
const amountPaid = {
  type: Number,
  required: true,
  min: 1,
  validate: { validator: Number.isSafeInteger, message: 'amount must be whole paise' },
};
const taxSplit = { gross: money, taxable: money, cgst: money, sgst: money, igst: money };
const totalsFields = () => ({
  gross: money,
  discount: money,
  taxable: money,
  cgst: money,
  sgst: money,
  igst: money,
  tax: money,
  roundOff: money,
  total: money,
});

const cancellationSchema = new mongoose.Schema(
  {
    reason: { type: String, required: true },
    at: { type: Date, required: true },
    by: { type: ObjectId, ref: 'User', required: true },
  },
  { _id: false },
);

// Bills, credit notes, receipts, receipt vouchers and refunds: one collection, one guard.
// Business dates ('YYYY-MM-DD', IST) are strings; drafts have no number, date or snapshot.
const billingDocumentSchema = new mongoose.Schema(
  {
    branchId: { type: ObjectId, ref: 'Branch', required: true },
    customerId: { type: ObjectId, ref: 'Customer', required: true },
    orderId: { type: ObjectId, ref: 'Order', default: null },
    status: { type: String, enum: ['draft', 'issued', 'cancelled'], default: 'draft' },
    number: { type: String, default: null },
    fyCode: { type: String, default: null },
    date: { type: String, default: null },
    month: { type: String, default: null },
    // Seller, customer, lines and figures as printed; fixed at issue.
    snapshot: { type: Mixed, default: null },
    pdf: {
      key: { type: String, default: null },
      status: { type: String, enum: ['none', 'pending', 'rendering', 'ready'], default: 'none' },
      sha256: { type: String, default: null },
      size: { type: Number, default: null },
      attempts: { type: Number, default: 0 },
      nextAttemptAt: { type: Date, default: null },
      lockedAt: { type: Date, default: null },
      renderedAt: { type: Date, default: null },
      lastError: { type: String, default: null },
    },
    issuedAt: { type: Date, default: null },
    issuedBy: { type: ObjectId, ref: 'User', default: null },
    cancellation: { type: cancellationSchema, default: null },
  },
  { collection: 'billingDocuments', discriminatorKey: 'type', minimize: false },
);
billingDocumentSchema.plugin(commonFields);

const issuedInvoices = { type: 'invoice', status: 'issued' };
billingDocumentSchema.index(
  { branchId: 1, type: 1, fyCode: 1, number: 1 },
  { name: 'number_unique', unique: true, partialFilterExpression: { number: { $type: 'string' } } },
);
billingDocumentSchema.index({ branchId: 1, customerId: 1, date: 1, _id: 1 }, { name: 'ledger' });
billingDocumentSchema.index({ branchId: 1, type: 1, status: 1, date: 1 }, { name: 'register' });
billingDocumentSchema.index(
  { branchId: 1, type: 1, status: 1, dueDate: 1 },
  { name: 'receivables', partialFilterExpression: { type: 'invoice', 'settlement.balance': { $gt: 0 } } },
);
billingDocumentSchema.index({ orderId: 1, type: 1, status: 1 }, { name: 'order_docs' });
billingDocumentSchema.index(
  { orderId: 1 },
  {
    name: 'one_draft_per_order',
    unique: true,
    partialFilterExpression: { type: 'invoice', status: 'draft', orderId: { $type: 'objectId' } },
  },
);
billingDocumentSchema.index(
  { 'pdf.status': 1, 'pdf.nextAttemptAt': 1 },
  { name: 'pdf_queue', partialFilterExpression: { 'pdf.status': { $in: ['pending', 'rendering'] } } },
);
billingDocumentSchema.index({ garmentIds: 1 }, { name: 'billed_garments', partialFilterExpression: issuedInvoices });
billingDocumentSchema.index({ stageEventIds: 1 }, { name: 'billed_events', partialFilterExpression: issuedInvoices });
billingDocumentSchema.index({ invoiceId: 1 }, { name: 'credit_notes', partialFilterExpression: { type: 'credit_note' } });
billingDocumentSchema.index({ 'pdf.key': 1 }, { name: 'pdf_key', sparse: true });

// --- Immutability -------------------------------------------------------------------------

billingDocumentSchema.post('init', function rememberStatus() {
  this.$locals.wasStatus = this.status;
});
billingDocumentSchema.post('save', function rememberStatus() {
  this.$locals.wasStatus = this.status;
});

// A stored document whose status was not loaded (a partial select, or a document built in memory
// and marked as stored) is treated as issued: only the mutable paths may change.
billingDocumentSchema.pre('save', function refuseFixedChanges() {
  if (this.isNew) return;
  const was = this.$locals.wasStatus;
  if (was === 'draft') {
    if (this.isModified('status') && this.status === 'cancelled') {
      throw new ImmutableDocumentError('A draft is deleted, not cancelled');
    }
    return;
  }
  const fixed = this.modifiedPaths().filter((p) => !isMutablePath(p));
  if (fixed.length) throw new ImmutableDocumentError(`Issued documents cannot be changed (${fixed.join(', ')})`);
  if (this.isModified('status') && !(was === 'issued' && this.status === 'cancelled')) {
    throw new ImmutableDocumentError(`A ${was ?? 'stored'} document cannot become ${this.status}`);
  }
});

// Paths an update writes, whatever the operator ($set, $inc, $unset, …, or a bare field).
function updatedPaths(update) {
  return Object.entries(update).flatMap(([key, value]) =>
    key.startsWith('$') && value && typeof value === 'object' ? Object.keys(value) : [key],
  );
}

// Timestamps add createdAt under $setOnInsert; it only applies to an insert, never to a stored document.
const IGNORED_ON_INSERT = new Set(['createdAt']);

function checkQueryUpdate() {
  const update = this.getUpdate() ?? {};
  if (Array.isArray(update)) throw new ImmutableDocumentError('Billing documents cannot take pipeline updates');
  // $rename writes its target (a value), not its keys: refuse it rather than parse both sides.
  if ('$rename' in update) throw new ImmutableDocumentError('Billing documents cannot take $rename');
  const paths = Object.entries(update).flatMap(([key, value]) =>
    key === '$setOnInsert' ? updatedPaths({ [key]: value }).filter((p) => !IGNORED_ON_INSERT.has(p)) : updatedPaths({ [key]: value }),
  );
  const fixed = paths.filter((p) => !isMutablePath(p));
  if (fixed.length) throw new ImmutableDocumentError(`Billing documents cannot be updated this way (${fixed.join(', ')})`);
  // A query cannot see the stored status, so a status change must name it: issued → cancelled only.
  const statusSet = paths.includes('status');
  if (statusSet) {
    const to = update.$set?.status ?? update.status;
    if (to !== 'cancelled' || this.getFilter().status !== 'issued') {
      throw new ImmutableDocumentError('Only an issued document can be cancelled');
    }
  }
}
billingDocumentSchema.pre(['updateOne', 'findOneAndUpdate'], { document: false, query: true }, checkQueryUpdate);

const refuse = function refuse() {
  throw new ImmutableDocumentError('Billing documents cannot be replaced or deleted this way');
};
for (const op of ['updateMany', 'replaceOne', 'findOneAndReplace', 'deleteMany', 'findOneAndDelete']) {
  billingDocumentSchema.pre(op, { document: false, query: true }, refuse);
}
// Only a draft can be deleted, and the filter must say so.
billingDocumentSchema.pre('deleteOne', { document: false, query: true }, function onlyDrafts() {
  if (this.getFilter().status !== 'draft') {
    throw new ImmutableDocumentError('Only a draft can be deleted (filter on status: draft)');
  }
});
billingDocumentSchema.pre('deleteOne', { document: true, query: false }, function onlyDraftDocs() {
  if (this.$locals.wasStatus !== 'draft') throw new ImmutableDocumentError('Only a draft can be deleted');
  // Mongoose adds `$where` to the delete's filter: it deletes only while the stored document is
  // still a draft, and lets the query hook above see that it is.
  this.$where = { ...this.$where, status: 'draft' };
});
billingDocumentSchema.pre('updateOne', { document: true, query: false }, function noDocUpdateOne() {
  throw new ImmutableDocumentError('Change billing documents with save() or a query update');
});

export const BillingDocument =
  mongoose.models.BillingDocument ?? mongoose.model('BillingDocument', billingDocumentSchema);

// --- Document types --------------------------------------------------------------------------

const discriminator = (name, fields) =>
  BillingDocument.discriminators?.[name] ??
  BillingDocument.discriminator(name, new mongoose.Schema(fields, { discriminatorKey: 'type', minimize: false }));

export const Invoice = discriminator('invoice', {
  // What staff are editing; the issued figures live in snapshot and totals.
  draft: {
    lines: { type: [Mixed], default: [] },
    invoiceDiscount: money,
    invoiceDiscountReason: { type: String, default: '' },
    notes: { type: String, default: '' },
  },
  dueDate: { type: String, default: null },
  totals: totalsFields(),
  interState: { type: Boolean, default: false },
  // Cache recomputed from allocations and credit notes in every transaction that changes them.
  settlement: {
    advanceApplied: money,
    paid: money,
    credited: money,
    balance: money,
  },
  remindersPaused: { type: Boolean, default: false },
  advanceAdjustments: {
    type: [
      new mongoose.Schema(
        { receiptVoucherId: { type: ObjectId, required: true }, number: { type: String, required: true }, ...taxSplit },
        { _id: false },
      ),
    ],
    default: [],
  },
  garmentIds: { type: [ObjectId], default: [] },
  stageEventIds: { type: [ObjectId], default: [] },
});

export const CreditNote = discriminator('credit_note', {
  invoiceId: { type: ObjectId, required: true },
  totals: totalsFields(),
  reason: { type: String, default: '' },
  lineCredits: {
    type: [new mongoose.Schema({ key: { type: String, required: true }, taxable: money }, { _id: false })],
    default: [],
  },
});

export const Receipt = discriminator('receipt', {
  amount: amountPaid,
  mode: { type: String, enum: PAYMENT_MODES, required: true },
  reference: { type: String, default: '' },
  // When the money actually came in, as staff noted it (the document is dated the day it is made).
  receivedOn: { type: String, default: null },
  note: { type: String, default: '' },
  receiptVoucherId: { type: ObjectId, default: null },
});

export const ReceiptVoucher = discriminator('receipt_voucher', {
  receiptId: { type: ObjectId, required: true },
  ...taxSplit,
});

export const Refund = discriminator('refund', {
  amount: amountPaid,
  mode: { type: String, enum: PAYMENT_MODES, required: true },
  reference: { type: String, default: '' },
  reason: { type: String, default: '' },
  rvReversal: {
    type: new mongoose.Schema(taxSplit, { _id: false }),
    default: null,
  },
});

// --- Allocations -----------------------------------------------------------------------------

// Signed paise moving a receipt's money onto a bill (or out as a refund). Append-only: money
// released from a bill is a negative row. A receipt's unallocated advance = amount − Σ its rows.
const allocationSchema = new mongoose.Schema(
  {
    branchId: { type: ObjectId, ref: 'Branch', required: true },
    customerId: { type: ObjectId, ref: 'Customer', required: true },
    receiptId: { type: ObjectId, required: true },
    invoiceId: { type: ObjectId, default: null },
    refundId: { type: ObjectId, default: null },
    amount: { type: Number, required: true },
    reason: {
      type: String,
      enum: ['payment', 'advance_applied', 'release_cancel', 'release_credit', 'release_receipt_cancel', 'refund'],
      required: true,
    },
    date: { type: String, required: true },
    at: { type: Date, required: true },
    by: { type: ObjectId, ref: 'User', required: true },
  },
  { collection: 'allocations', versionKey: false },
);
allocationSchema.index({ receiptId: 1 });
allocationSchema.index({ invoiceId: 1 });
allocationSchema.index({ refundId: 1 });
allocationSchema.index({ branchId: 1, customerId: 1, date: 1 });

const refuseAllocationChange = () => {
  throw new Error('allocations is append-only');
};
allocationSchema.pre('save', function onlyInserts() {
  if (!this.isNew) refuseAllocationChange();
});
for (const op of [
  'updateOne',
  'updateMany',
  'replaceOne',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'deleteOne',
  'deleteMany',
]) {
  allocationSchema.pre(op, { document: false, query: true }, refuseAllocationChange);
}
allocationSchema.pre(['updateOne', 'deleteOne'], { document: true, query: false }, refuseAllocationChange);

export const Allocation = mongoose.models.Allocation ?? mongoose.model('Allocation', allocationSchema);

// --- Customer money guard ---------------------------------------------------------------------

// `_id` = '<branchId>:<customerId>'; every money write for the customer bumps `seq` first.
const billingGuardSchema = new mongoose.Schema(
  { _id: { type: String }, seq: { type: Number, default: 0 } },
  { collection: 'billingGuards', versionKey: false },
);

export const BillingGuard = mongoose.models.BillingGuard ?? mongoose.model('BillingGuard', billingGuardSchema);

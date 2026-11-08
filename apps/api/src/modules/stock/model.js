import mongoose from 'mongoose';
import { MOVEMENT_TYPES } from '@vs/shared/stock.js';
import { commonFields } from '../../core/commonFields.js';

const { ObjectId } = mongoose.Schema.Types;

/** Thrown by the model when a stored stock movement would be changed or deleted. */
export class StockMovementImmutableError extends Error {
  constructor(message = 'Stock movements cannot be changed or deleted') {
    super(message);
    this.name = 'StockMovementImmutableError';
  }
}

const whole = { validator: Number.isSafeInteger, message: '{PATH} must be a whole number' };
// Quantities are thousandths of the usage unit; money is paise.
const int = (fields = {}) => ({ type: Number, validate: whole, ...fields });
const balance = () => int({ default: 0, min: 0 });
const ref = (name) => ({ type: ObjectId, ref: name, default: null });

// --- Stock items: cached balances, written only by ledger.js --------------------------------------

const stockItemSchema = new mongoose.Schema(
  {
    branchId: { type: ObjectId, ref: 'Branch', required: true },
    name: { type: String, required: true, trim: true },
    // Lower-case name for sorting and search.
    searchName: { type: String, required: true },
    brand: { type: String, default: '' },
    category: { type: String, default: '' },
    colour: { type: String, default: '' },
    usageUnit: { type: String, required: true },
    purchaseUnit: { type: String, required: true },
    // Thousandths of the usage unit in one purchase unit (a packet of 144 = 144000).
    factor: int({ required: true, min: 1 }),
    // The +/− step on screens.
    step: int({ default: 1000, min: 1 }),
    reorderLevel: int({ default: 0, min: 0 }),
    sellingPrice: {
      type: Number,
      default: null,
      min: 0,
      validate: { validator: (v) => v === null || Number.isSafeInteger(v), message: 'sellingPrice is whole paise' },
    },
    active: { type: Boolean, default: true },
    onHand: balance(),
    reserved: balance(),
    // Paise; the valuation pool (authoritative). avgCost is milli-paise per unit, for display.
    value: balance(),
    avgCost: int({ default: 0, min: 0 }),
    low: { type: Boolean, default: false },
    // Bumped each time `low` turns true, so an item alerts once per dip.
    lowSeq: int({ default: 0 }),
    // Bumped by every movement; the guard of the balance update.
    balanceSeq: int({ default: 0 }),
    lastValueMovementId: ref('StockMovement'),
    hasMovements: { type: Boolean, default: false },
  },
  { collection: 'stockItems', minimize: false },
);
stockItemSchema.plugin(commonFields);
stockItemSchema.index({ branchId: 1, active: 1, searchName: 1 }, { name: 'by_name' });
stockItemSchema.index({ branchId: 1, searchName: 1 }, { name: 'low', partialFilterExpression: { low: true } });

export const StockItem = mongoose.models.StockItem ?? mongoose.model('StockItem', stockItemSchema);

// --- Stock movements: append-only ----------------------------------------------------------------

const objectIdOnly = (path) => ({ partialFilterExpression: { [path]: { $type: 'objectId' } } });

const stockMovementSchema = new mongoose.Schema(
  {
    branchId: { type: ObjectId, ref: 'Branch', required: true },
    stockItemId: { type: ObjectId, ref: 'StockItem', required: true },
    type: { type: String, enum: MOVEMENT_TYPES, required: true },
    // Signed, as entered (a count down is negative).
    quantity: int({ required: true }),
    onHandChange: int({ required: true }),
    reservedChange: int({ required: true }),
    valueChange: int({ required: true }),
    onHandAfter: int({ required: true, min: 0 }),
    reservedAfter: int({ required: true, min: 0 }),
    valueAfter: int({ required: true, min: 0 }),
    garmentId: ref('Garment'),
    orderId: ref('Order'),
    purchaseRequestId: ref('PurchaseRequest'),
    expenseId: ref('Expense'),
    invoiceId: ref('Invoice'),
    reason: { type: String, default: '' },
    by: ref('User'),
    at: { type: Date, required: true },
    // IST business date.
    date: { type: String, required: true },
  },
  { collection: 'stockMovements', versionKey: false },
);
stockMovementSchema.index({ branchId: 1, stockItemId: 1, at: 1, _id: 1 }, { name: 'by_item' });
stockMovementSchema.index({ branchId: 1, date: 1, type: 1 }, { name: 'by_date' });
stockMovementSchema.index({ garmentId: 1, type: 1 }, { name: 'by_garment', ...objectIdOnly('garmentId') });
stockMovementSchema.index({ purchaseRequestId: 1 }, { name: 'by_request', ...objectIdOnly('purchaseRequestId') });
stockMovementSchema.index({ invoiceId: 1 }, { name: 'by_invoice', ...objectIdOnly('invoiceId') });

const refuse = function refuse() {
  throw new StockMovementImmutableError();
};
for (const op of [
  'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'findOneAndUpdate', 'findOneAndDelete', 'replaceOne', 'findOneAndReplace',
]) {
  stockMovementSchema.pre(op, { document: false, query: true }, refuse);
}
stockMovementSchema.pre(['deleteOne', 'updateOne'], { document: true, query: false }, refuse);
stockMovementSchema.pre('save', function refuseChanges() {
  if (!this.isNew) throw new StockMovementImmutableError();
});

export const StockMovement = mongoose.models.StockMovement ?? mongoose.model('StockMovement', stockMovementSchema);

// --- Materials planned per garment (Decision 5) --------------------------------------------------

const materialLineSchema = new mongoose.Schema(
  {
    stockItemId: { type: ObjectId, ref: 'StockItem', required: true },
    planned: int({ default: 0, min: 0 }),
    reserved: int({ default: 0, min: 0 }),
    used: int({ default: 0, min: 0 }),
    usedCost: int({ default: 0 }),
    state: { type: String, enum: ['planned', 'used', 'released'], default: 'planned' },
  },
  { _id: false },
);

const garmentMaterialsSchema = new mongoose.Schema(
  {
    branchId: { type: ObjectId, ref: 'Branch', required: true },
    orderId: { type: ObjectId, ref: 'Order', required: true },
    garmentId: { type: ObjectId, ref: 'Garment', required: true },
    garmentNo: { type: String, required: true },
    lines: { type: [materialLineSchema], default: [] },
  },
  { collection: 'garmentMaterials', minimize: false },
);
garmentMaterialsSchema.plugin(commonFields);
garmentMaterialsSchema.index({ garmentId: 1 }, { name: 'garment_unique', unique: true });
garmentMaterialsSchema.index({ branchId: 1, orderId: 1 }, { name: 'by_order' });
garmentMaterialsSchema.index({ branchId: 1, 'lines.stockItemId': 1 }, { name: 'by_item' });

export const GarmentMaterials = mongoose.models.GarmentMaterials ?? mongoose.model('GarmentMaterials', garmentMaterialsSchema);

// --- "To buy" requests ---------------------------------------------------------------------------

const needSchema = new mongoose.Schema(
  {
    garmentId: { type: ObjectId, ref: 'Garment', required: true },
    garmentNo: { type: String, required: true },
    orderId: { type: ObjectId, ref: 'Order', required: true },
    quantity: int({ required: true, min: 1 }),
    reservedOnReceipt: int({ default: 0, min: 0 }),
  },
  { _id: false },
);

const receiptSchema = new mongoose.Schema(
  {
    quantity: int({ required: true }),
    value: int({ required: true, min: 0 }),
    expenseId: { type: ObjectId, ref: 'Expense', required: true },
    movementId: { type: ObjectId, ref: 'StockMovement', required: true },
    date: { type: String, required: true },
    at: { type: Date, required: true },
    by: ref('User'),
  },
  { _id: false },
);

const cancellationSchema = new mongoose.Schema(
  { reason: { type: String, required: true }, at: { type: Date, required: true }, by: ref('User') },
  { _id: false },
);

const purchaseRequestSchema = new mongoose.Schema(
  {
    branchId: { type: ObjectId, ref: 'Branch', required: true },
    stockItemId: { type: ObjectId, ref: 'StockItem', required: true },
    quantity: int({ required: true, min: 1 }),
    reason: { type: String, enum: ['shortfall', 'low_stock', 'manual'], required: true },
    needs: { type: [needSchema], default: [] },
    note: { type: String, default: '' },
    status: { type: String, enum: ['requested', 'ordered', 'received', 'cancelled'], default: 'requested' },
    vendorId: ref('Vendor'),
    orderedAt: { type: Date, default: null },
    orderedBy: ref('User'),
    receipt: { type: receiptSchema, default: null },
    cancellation: { type: cancellationSchema, default: null },
  },
  { collection: 'purchaseRequests', minimize: false },
);
purchaseRequestSchema.plugin(commonFields);
purchaseRequestSchema.index({ branchId: 1, status: 1, createdAt: 1, _id: 1 }, { name: 'by_status' });
purchaseRequestSchema.index({ branchId: 1, stockItemId: 1, status: 1 }, { name: 'open_for_item' });
purchaseRequestSchema.index({ 'needs.garmentId': 1 }, { name: 'needs' });
// At most one open shortfall request per item, so two reservations at once cannot open two.
purchaseRequestSchema.index(
  { branchId: 1, stockItemId: 1 },
  { name: 'one_open_shortfall', unique: true, partialFilterExpression: { status: 'requested', reason: 'shortfall' } },
);

export const PurchaseRequest = mongoose.models.PurchaseRequest ?? mongoose.model('PurchaseRequest', purchaseRequestSchema);

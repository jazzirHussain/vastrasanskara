import mongoose from 'mongoose';
import { commonFields } from '../../core/commonFields.js';

// The price list: what the house bills, with the tax codes and GST slabs each line needs.
const slabSchema = new mongoose.Schema(
  {
    // Highest taxable value per unit this rate applies to, in paise; null for the open top slab.
    upToUnitPrice: { type: Number, default: null },
    rateBp: { type: Number, required: true },
  },
  { _id: false },
);

const catalogItemSchema = new mongoose.Schema({
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  name: { type: String, required: true, trim: true },
  // Lower-case name for sorting and search.
  searchName: { type: String, required: true },
  kind: { type: String, enum: ['garment', 'stitching_service', 'material', 'extra_charge'], required: true },
  supplyType: { type: String, enum: ['goods', 'service'], required: true },
  hsnSac: { type: String, required: true },
  unit: { type: String, enum: ['PCS', 'MTR', 'SET', 'NOS', 'OTH'], default: 'PCS' },
  // Before GST, in paise.
  defaultPrice: { type: Number, default: 0 },
  gstSlabs: { type: [slabSchema], required: true },
  // Garment types this item bills (one active item per type).
  garmentTypes: { type: [String], default: [] },
  // Which extra charge this item bills (one active item per charge).
  chargeFor: { type: String, enum: ['rush', 'alteration', 'rework', null], default: null },
  active: { type: Boolean, default: true },
});
catalogItemSchema.plugin(commonFields);
catalogItemSchema.index({ branchId: 1, searchName: 1 });
catalogItemSchema.index({ branchId: 1, active: 1, garmentTypes: 1 });
catalogItemSchema.index({ branchId: 1, active: 1, chargeFor: 1 });

export const CatalogItem = mongoose.models.CatalogItem ?? mongoose.model('CatalogItem', catalogItemSchema);

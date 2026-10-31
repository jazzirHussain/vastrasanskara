import { z } from 'zod';
import { billingAmount } from './common.js';
import { garmentTypeKey } from './settings.js';
import { GST_RATES_BP } from '../gst.js';

export const ITEM_KINDS = ['garment', 'stitching_service', 'material', 'extra_charge'];
export const UNITS = ['PCS', 'MTR', 'SET', 'NOS', 'OTH'];
export const CHARGE_FOR = ['rush', 'alteration', 'rework'];

const slab = z.strictObject({
  upToUnitPrice: billingAmount.positive().nullable(),
  rateBp: z.int().refine((v) => GST_RATES_BP.includes(v), 'Not a GST rate'),
});

const fields = {
  name: z.string().trim().min(1).max(100),
  kind: z.enum(ITEM_KINDS),
  supplyType: z.enum(['goods', 'service']),
  hsnSac: z.string().regex(/^\d{4}(\d{2}){0,2}$/, 'HSN or SAC must be 4, 6 or 8 digits'),
  unit: z.enum(UNITS),
  defaultPrice: billingAmount,
  gstSlabs: z.array(slab).min(1).max(5),
  garmentTypes: z.array(garmentTypeKey).max(50),
  chargeFor: z.enum(CHARGE_FOR).nullable(),
  active: z.boolean(),
};

/** Cross-field rules; the service also runs this on the merged item for a patch. */
export function checkCatalogItemRules(value, ctx) {
  const add = (path, message) => ctx.addIssue({ code: 'custom', path: [path], message });
  const slabs = value.gstSlabs;
  if (slabs?.length) {
    const last = slabs.length - 1;
    const limits = slabs.slice(0, last).map((s) => s.upToUnitPrice);
    const ascending = limits.every((l, i) => l !== null && (i === 0 || l > limits[i - 1]));
    if (slabs[last].upToUnitPrice !== null || !ascending) {
      add('gstSlabs', 'Slabs must go from the lowest price up, ending with one open slab');
    }
  }
  if (value.hsnSac && value.supplyType && (value.supplyType === 'service') !== value.hsnSac.startsWith('99')) {
    add('hsnSac', 'SAC codes start with 99; goods use HSN codes');
  }
  if (value.garmentTypes?.length && value.kind && !['garment', 'stitching_service'].includes(value.kind)) {
    add('garmentTypes', 'Garment types only apply to garments and stitching');
  }
  if (value.chargeFor && value.kind && value.kind !== 'extra_charge') {
    add('chargeFor', 'Charge type only applies to extra charges');
  }
}

export const catalogItemSchema = z
  .strictObject({
    ...fields,
    unit: fields.unit.default('PCS'),
    defaultPrice: fields.defaultPrice.default(0),
    garmentTypes: fields.garmentTypes.default([]),
    chargeFor: fields.chargeFor.default(null),
    active: fields.active.default(true),
  })
  .superRefine(checkCatalogItemRules);

/** PATCH: any subset, no defaults; the service re-checks the merged item with checkCatalogItemRules. */
export const catalogItemPatchSchema = z
  .strictObject(fields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

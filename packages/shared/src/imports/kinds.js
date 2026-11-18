// What each kind of old record looks like in a spreadsheet: its columns (header, aliases, help,
// example, how a cell is read) and how a row becomes the record the owning module expects.
// Pure, so the template, the preview and the import all read a row the same way.
import { z } from 'zod';
import { billingAmount, objectId, phone, ymd } from '../schemas/common.js';
import { CUSTOMER_SOURCES, CUSTOMER_TYPES, customerSchema } from '../schemas/customers.js';
import { vendorSchema, workerSchema } from '../schemas/workshop.js';
import { ITEM_KINDS, UNITS, catalogItemSchema } from '../schemas/catalog.js';
import { stockItemSchema } from '../schemas/stock.js';
import { garmentInputSchema } from '../schemas/orders.js';
import { STAGES } from '../stages.js';
import {
  isBlankCell,
  parseChoice,
  parseDate,
  parseEmail,
  parseList,
  parsePercent,
  parsePhone,
  parseQty,
  parseRupees,
  parseState,
  parseText,
  parseYesNo,
} from './values.js';

export const IMPORT_MAX_BYTES = 5_242_880;
export const IMPORT_MAX_ROWS = 5000;
/** Files with at most this many rows are checked and added at once, larger ones in the background. */
export const IMPORT_LIGHT_ROWS = 200;
export const IMPORT_MAX_COLUMNS = 60;

const labelled = (keys, labels) => keys.map((key) => ({ key, label: labels[key] }));
const TYPE_CHOICES = labelled(CUSTOMER_TYPES, { individual: 'Individual', business: 'Business', film_production: 'Film production' });
const SOURCE_CHOICES = labelled(CUSTOMER_SOURCES, {
  instagram: 'Instagram',
  referral: 'Referral',
  walk_in: 'Walk-in',
  website: 'Website',
  film_industry: 'Film industry',
  other: 'Other',
});
const ITEM_KIND_CHOICES = labelled(ITEM_KINDS, {
  garment: 'Garment',
  stitching_service: 'Stitching service',
  material: 'Material',
  extra_charge: 'Extra charge',
});
const SUPPLY_CHOICES = [{ key: 'goods', label: 'Goods' }, { key: 'service', label: 'Service' }];
const UNIT_CHOICES = UNITS.map((u) => ({ key: u, label: u }));
const PRIORITY_CHOICES = [{ key: 'normal', label: 'Normal' }, { key: 'rush', label: 'Rush' }];
const STAGE_CHOICES = STAGES.filter((s) => s.key !== 'picked_up').map(({ key, label }) => ({ key, label }));

/** Choices of a column: fixed, or taken from settings (garment types, designers). */
export function columnChoices(column, ctx = {}) {
  if (column.choices) return column.choices;
  if (column.choicesFrom === 'garmentTypes') return (ctx.garmentTypes ?? []).map(({ key, label }) => ({ key, label }));
  if (column.choicesFrom === 'designers') return (ctx.designers ?? []).map(({ id, name }) => ({ key: id, label: name }));
  return null;
}

// Column builders. `path` is where the value goes in the record (and where its errors come from).
const col = (key, header, spec) => ({ key, header, aliases: [], required: false, path: [key], ...spec });
const text = (key, header, max, spec = {}) => col(key, header, { parse: (raw) => parseText(raw, { max }), ...spec });
const phoneCol = (key, header, spec = {}) => col(key, header, { parse: parsePhone, textFormat: true, example: '9876543210', ...spec });
const choice = (key, header, choices, spec = {}) => col(key, header, { choices, parse: (raw) => parseChoice(raw, choices), ...spec });
const fromSettings = (key, header, source, spec = {}) =>
  col(key, header, { choicesFrom: source, parse: (raw, ctx) => parseChoice(raw, columnChoices({ choicesFrom: source }, ctx)), ...spec });
const yesNo = (key, header, spec) => col(key, header, { parse: parseYesNo, choices: [{ key: true, label: 'Yes' }, { key: false, label: 'No' }], example: 'No', ...spec });
const gstinCol = (spec = {}) =>
  col('gstin', 'GSTIN', {
    parse: (raw) => {
      const result = parseText(raw, { max: 20 });
      return result.value ? { value: result.value.replace(/\s/g, '').toUpperCase() } : result;
    },
    textFormat: true,
    example: '',
    help: 'Only for registered businesses. 15 characters.',
    ...spec,
  });
const stateCol = () => col('state', 'State', { path: ['stateCode'], parse: parseState, example: 'Karnataka', help: 'State name or its 2-digit GST code. Leave blank for this branch’s state.' });

const omitNull = (values) => Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null && v !== undefined));

const customers = {
  kind: 'customers',
  label: 'Customers',
  help: 'Everyone who has ordered or might order. One row per customer; the phone number tells them apart.',
  needsAsOf: false,
  columns: [
    text('name', 'Name', 100, { required: true, aliases: ['Customer name', 'Full name', 'Customer'], example: 'Asha Rao', help: 'Customer’s full name.' }),
    phoneCol('phone', 'Phone', { required: true, aliases: ['Mobile', 'Mobile number', 'Phone number', 'Contact', 'Contact number', 'Cell'], help: '10-digit mobile number. +91 or 0 in front is fine.' }),
    col('email', 'Email', { parse: parseEmail, aliases: ['Email address', 'Email id', 'Mail'], example: 'asha@example.com', help: 'Optional.' }),
    choice('type', 'Customer type', TYPE_CHOICES, { aliases: ['Type'], example: 'Individual', help: 'Leave blank for Individual.' }),
    gstinCol(),
    stateCol(),
    text('line1', 'Address line 1', 200, { path: ['billingAddress', 'line1'], aliases: ['Address'], example: '12 MG Road', help: 'Billing address, optional.' }),
    text('line2', 'Address line 2', 200, { path: ['billingAddress', 'line2'], example: '', help: 'Optional.' }),
    text('city', 'City', 100, { path: ['billingAddress', 'city'], aliases: ['Town'], example: 'Bengaluru', help: 'Optional.' }),
    text('pincode', 'Pincode', 6, { path: ['billingAddress', 'pincode'], aliases: ['Pin', 'Pin code', 'Postal code'], textFormat: true, example: '560001', help: '6 digits, optional.' }),
    choice('source', 'How they found us', SOURCE_CHOICES, { aliases: ['Source', 'Found us'], example: 'Walk-in', help: 'Leave blank for Walk-in.' }),
    yesNo('consentEmail', 'Email OK?', { path: ['consent', 'email'], help: 'Yes if they agreed to get emails from you.' }),
    yesNo('consentWhatsapp', 'WhatsApp OK?', { path: ['consent', 'whatsapp'], help: 'Yes if they agreed to get WhatsApp messages.' }),
    yesNo('consentSms', 'SMS OK?', { path: ['consent', 'sms'], help: 'Yes if they agreed to get text messages.' }),
    text('consentNote', 'How consent was given', 300, { aliases: ['Consent note'], example: 'Said yes at the counter', help: 'Needed when any of the three above is Yes.' }),
  ],
  schema: customerSchema,
  build(v) {
    const address = [v.line1, v.line2, v.city, v.pincode].some((x) => x !== null)
      ? { billingAddress: { line1: v.line1 ?? '', line2: v.line2 ?? '', city: v.city ?? '', pincode: v.pincode ?? '' } }
      : {};
    return omitNull({
      name: v.name,
      phone: v.phone,
      email: v.email,
      type: v.type,
      gstin: v.gstin,
      stateCode: v.state ?? v.gstin?.slice(0, 2),
      ...address,
      source: v.source,
      consent: { email: v.consentEmail ?? false, whatsapp: v.consentWhatsapp ?? false, sms: v.consentSms ?? false },
      consentNote: v.consentNote,
    });
  },
  key: (d) => d.phone,
};

const vendors = {
  kind: 'vendors',
  label: 'Vendors',
  help: 'Dyers, embroiderers and suppliers you send work to or buy from. One row per vendor.',
  needsAsOf: false,
  columns: [
    text('name', 'Name', 100, { required: true, aliases: ['Vendor', 'Vendor name', 'Supplier'], example: 'Lakshmi Dyers', help: 'The vendor’s name.' }),
    phoneCol('phone', 'Phone', { aliases: ['Mobile', 'Phone number', 'Contact'], help: '10-digit mobile number, optional.' }),
    gstinCol(),
    stateCol(),
    col('services', 'Services', { parse: parseList, aliases: ['Work', 'Services offered'], example: 'Dyeing, Embroidery', help: 'What they do, separated by commas.' }),
  ],
  schema: vendorSchema,
  build: (v) => omitNull({ name: v.name, phone: v.phone, gstin: v.gstin, stateCode: v.state ?? v.gstin?.slice(0, 2), services: v.services }),
  key: (d) => norm(d.name),
};

const workers = {
  kind: 'workers',
  label: 'Workers',
  help: 'Tailors, masters and artisans (they do not sign in). One row per person.',
  needsAsOf: false,
  columns: [
    text('name', 'Name', 100, { required: true, aliases: ['Worker', 'Worker name'], example: 'Ravi', help: 'The worker’s name.' }),
    text('skill', 'Skill', 100, { aliases: ['Role', 'Work'], example: 'Master tailor', help: 'Optional.' }),
    phoneCol('phone', 'Phone', { aliases: ['Mobile', 'Phone number'], help: '10-digit mobile number, optional.' }),
  ],
  schema: workerSchema,
  build: (v) => omitNull({ name: v.name, skill: v.skill, phone: v.phone }),
  key: (d) => norm(d.name),
};

const catalog = {
  kind: 'catalog',
  label: 'Price list',
  help: 'What you sell and charge for, with HSN/SAC codes and GST rates. One row per item.',
  needsAsOf: false,
  columns: [
    text('name', 'Name', 100, { required: true, aliases: ['Item', 'Item name'], example: 'Blouse stitching', help: 'As it should appear on bills.' }),
    choice('kind', 'Kind', ITEM_KIND_CHOICES, { required: true, aliases: ['Item kind'], example: 'Stitching service', help: 'Garment, Stitching service, Material or Extra charge.' }),
    choice('supplyType', 'Goods or service', SUPPLY_CHOICES, { required: true, aliases: ['Supply type'], example: 'Service', help: 'Goods use HSN codes; services use SAC codes starting 99.' }),
    text('hsnSac', 'HSN or SAC', 8, { required: true, aliases: ['HSN', 'SAC', 'HSN code', 'SAC code', 'HSN/SAC'], textFormat: true, example: '998821', help: '4, 6 or 8 digits.' }),
    choice('unit', 'Unit', UNIT_CHOICES, { example: 'PCS', help: 'PCS, MTR, SET, NOS or OTH. Leave blank for PCS.' }),
    col('price', 'Price', { path: ['defaultPrice'], parse: parseRupees, aliases: ['Rate', 'Default price', 'MRP'], example: '1500', help: 'In rupees, before GST. Leave blank to type it on each bill.' }),
    col('rate', 'GST rate %', { required: true, path: ['gstSlabs'], parse: parsePercent, aliases: ['GST', 'GST rate', 'Tax rate'], example: '5', help: 'For example 5, 12 or 18.' }),
    col('higherRate', 'Higher GST rate %', { path: ['gstSlabs'], parse: parsePercent, example: '', help: 'Only if the rate goes up above a price (for example 18 above ₹2,500).' }),
    col('higherAbove', 'Higher rate above price', { path: ['gstSlabs'], parse: parseRupees, example: '', help: 'The price per piece above which the higher rate applies.' }),
    col('garmentTypes', 'Garment types', {
      choicesFrom: 'garmentTypes',
      parse: (raw, ctx) => {
        const list = parseList(raw);
        if (!list.value) return list;
        const choices = columnChoices({ choicesFrom: 'garmentTypes' }, ctx);
        const keys = [];
        for (const item of list.value) {
          const one = parseChoice(item, choices);
          if (one.error) return one;
          keys.push(one.value);
        }
        return { value: keys };
      },
      example: '',
      help: 'For garments and stitching only: the garment types it is for, separated by commas.',
    }),
  ],
  schema: catalogItemSchema,
  build(v, addError) {
    if (v.higherRate !== null && v.higherAbove === null) addError('higherAbove', 'Fill this in when there is a higher GST rate.');
    if (v.higherAbove !== null && v.higherRate === null) addError('higherRate', 'Fill this in when there is a price above which it applies.');
    const gstSlabs =
      v.higherRate !== null && v.higherAbove !== null
        ? [{ upToUnitPrice: v.higherAbove, rateBp: v.rate }, { upToUnitPrice: null, rateBp: v.higherRate }]
        : [{ upToUnitPrice: null, rateBp: v.rate }];
    return omitNull({
      name: v.name,
      kind: v.kind,
      supplyType: v.supplyType,
      hsnSac: v.hsnSac,
      unit: v.unit,
      defaultPrice: v.price,
      gstSlabs,
      garmentTypes: v.garmentTypes,
    });
  },
  key: (d) => norm(d.name),
};

const stock = {
  kind: 'stock',
  label: 'Stock',
  help: 'Fabric, thread and other materials on the shelf, with what is in stock today and what it cost.',
  needsAsOf: false,
  columns: [
    text('name', 'Name', 80, { required: true, aliases: ['Item', 'Item name', 'Material'], example: 'Raw silk', help: 'The material’s name.' }),
    text('brand', 'Brand', 60, { example: 'Mysore Silk', help: 'Optional.' }),
    text('category', 'Category', 40, { example: 'Fabric', help: 'Optional, for grouping.' }),
    text('colour', 'Colour', 40, { aliases: ['Color', 'Shade'], example: 'Red', help: 'Optional. Same name in another colour is another item.' }),
    text('usageUnit', 'Unit', 20, { required: true, aliases: ['Usage unit'], example: 'm', help: 'How you use it: m, piece, spool…' }),
    text('purchaseUnit', 'Bought in', 20, { required: true, aliases: ['Purchase unit'], example: 'roll', help: 'How you buy it: roll, box, packet…' }),
    col('factor', 'Units in one', { required: true, parse: parseQty, aliases: ['Units per purchase'], example: '25', help: 'How many of the unit come in one of what you buy (25 m in a roll).' }),
    col('reorderLevel', 'Reorder at', { parse: parseQty, aliases: ['Reorder level', 'Minimum'], example: '10', help: 'Warn when stock falls to this. Optional.' }),
    col('sellingPrice', 'Selling price per unit', { parse: parseRupees, aliases: ['Selling price'], example: '', help: 'In rupees, if you sell it as is. Optional.' }),
    col('quantity', 'Quantity in stock', { path: ['opening', 'quantity'], parse: parseQty, aliases: ['Stock', 'In stock', 'Quantity'], example: '12.5', help: 'What is on the shelf today, in the unit above.' }),
    col('unitCost', 'Cost per unit', { path: ['opening', 'unitCost'], parse: parseRupees, aliases: ['Cost', 'Unit cost'], example: '410', help: 'What one unit cost you, in rupees. Needed when there is stock.' }),
  ],
  schema: stockItemSchema,
  build(v, addError) {
    const has = v.quantity !== null && v.quantity > 0;
    if (has && v.unitCost === null) addError('unitCost', 'Fill this in when there is stock.');
    return omitNull({
      name: v.name,
      brand: v.brand,
      category: v.category,
      colour: v.colour,
      usageUnit: v.usageUnit,
      purchaseUnit: v.purchaseUnit,
      factor: v.factor,
      reorderLevel: v.reorderLevel,
      sellingPrice: v.sellingPrice,
      opening: has ? { quantity: v.quantity, unitCost: v.unitCost ?? 0 } : null,
    });
  },
  key: (d) => [d.name, d.brand ?? '', d.colour ?? ''].map(norm).join('|'),
};

// A designer by name (case and spacing ignored) or by email; two with one name need the email.
function parseDesigner(raw, ctx = {}) {
  const designers = ctx.designers ?? [];
  const text = String(raw).trim();
  if (text.includes('@')) {
    const found = designers.find((d) => d.email && d.email.toLowerCase() === text.toLowerCase());
    if (found) return { value: found.id };
  }
  const named = designers.filter((d) => norm(d.name) === norm(text));
  if (named.length > 1) return { error: `Two designers are called ${named[0].name} — use their email.` };
  if (named.length === 1) return { value: named[0].id };
  const names = [...new Set(designers.map((d) => d.name))];
  return { error: `'${text}' is not one of your designers. Choose one of: ${names.join(', ')}.` };
}

const orderRowSchema = z.strictObject({
  legacyRef: z.string().trim().min(1).max(40),
  customerPhone: phone,
  designerId: objectId,
  orderDate: ymd.nullable(),
  pickupDate: ymd,
  priority: z.enum(['normal', 'rush']).default('normal'),
  garment: garmentInputSchema,
  stage: z.enum(STAGE_CHOICES.map((s) => s.key)),
});

const wholeQty = (raw) => {
  const result = parseQty(raw);
  if (result.error || result.value === null) return result;
  if (result.value % 1000 !== 0) return { error: `'${String(raw).trim()}' is not a whole number.` };
  return { value: result.value / 1000 };
};

const orders = {
  kind: 'orders',
  label: 'Open orders',
  help: 'Orders not yet picked up. One row per garment; rows with the same old order number make one order.',
  needsAsOf: false,
  columns: [
    text('legacyRef', 'Old order no.', 40, { required: true, aliases: ['Order no', 'Order number', 'Old order number', 'Bill no'], textFormat: true, example: '1234', help: 'The number in your old book. Kept as “Old no.” on the order.' }),
    phoneCol('customerPhone', 'Customer phone', { required: true, aliases: ['Phone', 'Mobile', 'Customer mobile'], help: 'Must match a customer already brought in.' }),
    col('designer', 'Designer', {
      required: true,
      path: ['designerId'],
      choicesFrom: 'designers',
      parse: parseDesigner,
      example: 'Meera',
      help: 'The designer’s name as in Staff (or their email, when two share a name).',
    }),
    col('orderDate', 'Order date', { parse: parseDate, example: '01/11/2026', help: 'Day/month/year. Leave blank for today.' }),
    col('pickupDate', 'Pickup date', { required: true, parse: parseDate, aliases: ['Delivery date', 'Due on'], example: '20/12/2026', help: 'Day/month/year.' }),
    choice('priority', 'Priority', PRIORITY_CHOICES, { example: 'Normal', help: 'Normal or Rush. Leave blank for Normal.' }),
    fromSettings('garmentType', 'Garment type', 'garmentTypes', { required: true, path: ['garment', 'type'], aliases: ['Garment'], example: 'Saree blouse', help: 'One of your garment types in Settings.' }),
    text('description', 'Description', 500, { required: true, path: ['garment', 'description'], aliases: ['Details', 'Work'], example: 'Boat neck, puff sleeves', help: 'What is being made.' }),
    text('fabric', 'Fabric', 300, { path: ['garment', 'fabric'], example: 'Customer’s silk', help: 'Optional.' }),
    col('price', 'Price', { required: true, path: ['garment', 'agreedPrice'], parse: parseRupees, aliases: ['Amount', 'Agreed price'], example: '4500', help: 'Agreed price for this line, in rupees.' }),
    col('quantity', 'Quantity', { path: ['garment', 'quantity'], parse: wholeQty, aliases: ['Qty', 'Pieces'], example: '1', help: 'How many identical pieces. Leave blank for 1.' }),
    col('dueDate', 'Due date', { path: ['garment', 'dueDate'], parse: parseDate, example: '', help: 'Only if this garment is due before the pickup date.' }),
    col('stage', 'Stage', {
      required: true,
      choices: STAGE_CHOICES,
      parse: (raw) => {
        if (parseChoice(raw, [{ key: 'picked_up', label: 'Picked up' }]).value) {
          return { error: 'Picked-up orders are not open. Leave this row out.' };
        }
        return parseChoice(raw, STAGE_CHOICES);
      },
      aliases: ['Status', 'Current stage'],
      example: 'Tailors',
      help: 'Where the garment is now, as on the production board.',
    }),
  ],
  schema: orderRowSchema,
  build: (v) => ({
    legacyRef: v.legacyRef,
    customerPhone: v.customerPhone,
    designerId: v.designer,
    orderDate: v.orderDate,
    pickupDate: v.pickupDate,
    ...(v.priority !== null && { priority: v.priority }),
    garment: omitNull({ type: v.garmentType, description: v.description, fabric: v.fabric, agreedPrice: v.price, quantity: v.quantity, dueDate: v.dueDate }),
    stage: v.stage,
  }),
  key: (d) => norm(d.legacyRef),
  // The order a row belongs to, read from the raw cell (also for rows that need fixing).
  groupOfCells: (cells) => (isBlankCell(cells.legacyRef) ? null : norm(cells.legacyRef)),
};

const openingRowSchema = z
  .strictObject({
    customerPhone: phone,
    owed: billingAmount,
    advance: billingAmount,
    legacyRef: z.string().trim().min(1).max(40).nullable(),
    note: z.string().trim().max(300),
  })
  .superRefine((value, ctx) => {
    if (value.owed + value.advance <= 0) {
      ctx.addIssue({ code: 'custom', path: ['owed'], message: 'Fill in the amount owed, the advance held, or both' });
    }
  });

const openingBalances = {
  kind: 'opening_balances',
  label: 'Opening balances',
  help: 'What customers owed you, and advances you were holding, on the cut-over date. One row per customer.',
  needsAsOf: true,
  columns: [
    phoneCol('customerPhone', 'Customer phone', { required: true, aliases: ['Phone', 'Mobile'], help: 'Must match a customer already brought in.' }),
    col('owed', 'Amount owed', { parse: parseRupees, aliases: ['Owed', 'Balance', 'Due', 'Outstanding'], example: '2500', help: 'What the customer still owed you, in rupees.' }),
    col('advance', 'Advance held', { parse: parseRupees, aliases: ['Advance'], example: '0', help: 'Advance you were holding for future work, in rupees.' }),
    text('legacyRef', 'Old order no.', 40, { aliases: ['Order no', 'Old order number'], textFormat: true, example: '', help: 'Optional: the open order the advance is for (bring in open orders first).' }),
    text('note', 'Note', 300, { aliases: ['Remarks'], example: '', help: 'Optional.' }),
  ],
  schema: openingRowSchema,
  build: (v) => ({ customerPhone: v.customerPhone, owed: v.owed ?? 0, advance: v.advance ?? 0, legacyRef: v.legacyRef, note: v.note ?? '' }),
  key: (d) => d.customerPhone,
};

export const IMPORT_KINDS = Object.freeze([customers, vendors, workers, catalog, stock, orders, openingBalances].map((k) => Object.freeze(k)));
export const IMPORT_KIND_KEYS = Object.freeze(IMPORT_KINDS.map((k) => k.kind));

export function getImportKind(kind) {
  const found = IMPORT_KINDS.find((k) => k.kind === kind);
  if (!found) throw new RangeError(`Unknown import kind: ${kind}`);
  return found;
}

const squash = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const norm = (text) => String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** The header row → which column holds which field, required headers missing, headers not used. */
export function matchHeaders(kind, headerRow) {
  const { columns } = getImportKind(kind);
  const lookup = new Map();
  for (const column of columns) {
    for (const name of [column.header, ...column.aliases]) if (!lookup.has(squash(name))) lookup.set(squash(name), column.key);
  }
  const map = {};
  const taken = new Set();
  const unused = [];
  headerRow.forEach((cell, index) => {
    const header = String(cell ?? '').trim();
    if (!header) return;
    const key = lookup.get(squash(header));
    if (key && !taken.has(key)) {
      map[index] = key;
      taken.add(key);
    } else unused.push(header);
  });
  const missing = columns.filter((c) => c.required && !taken.has(c.key)).map((c) => c.header);
  return { map, missing, unused };
}

/** A data row as an array → { key: raw } using matchHeaders' map. */
export function cellsByKey(map, row) {
  const cells = {};
  for (const [index, key] of Object.entries(map)) cells[key] = row[Number(index)] ?? null;
  return cells;
}

const sentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);

// A zod issue in plain words.
function plainMessage(issue) {
  switch (issue.code) {
    case 'too_big':
      if (issue.origin === 'string') return `Keep this to ${issue.maximum} characters or fewer.`;
      if (issue.origin === 'array') return `List at most ${issue.maximum}.`;
      return 'This is too large.';
    case 'too_small':
      if (issue.origin === 'string' || issue.origin === 'array') return 'Fill this in.';
      return 'This must be more than zero.';
    case 'invalid_value':
      return 'This is not one of the allowed values.';
    case 'invalid_type':
      return issue.input === undefined || issue.input === null ? 'Fill this in.' : 'This is not a valid value.';
    default: {
      const message = String(issue.message ?? '');
      const invalid = /^Invalid (.+)$/.exec(message);
      return invalid ? `This is not a valid ${invalid[1]}.` : sentence(message || 'This is not a valid value.');
    }
  }
}

// The column a zod issue belongs to: the one whose path is the longest prefix of the issue's.
function columnFor(columns, path) {
  let best = null;
  for (const column of columns) {
    const p = column.path;
    if (p.length <= path.length && p.every((part, i) => part === path[i]) && (!best || p.length > best.path.length)) best = column;
  }
  return best;
}

/**
 * One data row ({ key: raw }) → { data, errors: [{ column, message }] }. `data` is the record as
 * the kind's schema outputs it (null when there are errors). `ctx` = { garmentTypes, designers }.
 */
export function parseRow(kind, cells, ctx = {}) {
  const def = getImportKind(kind);
  const errors = [];
  const values = {};
  for (const column of def.columns) {
    const raw = cells[column.key] ?? null;
    if (isBlankCell(raw)) {
      if (column.required) errors.push({ column: column.header, message: 'Fill this in.' });
      values[column.key] = null;
      continue;
    }
    const result = column.parse(raw, ctx);
    if (result.error) errors.push({ column: column.header, message: result.error });
    values[column.key] = result.error ? null : result.value;
  }
  if (errors.length) return { data: null, errors };

  const addError = (key, message) => errors.push({ column: def.columns.find((c) => c.key === key).header, message });
  const input = def.build(values, addError);
  if (errors.length) return { data: null, errors };

  const parsed = def.schema.safeParse(input);
  if (parsed.success) return { data: parsed.data, errors: [] };
  const seen = new Set();
  for (const issue of parsed.error.issues) {
    const header = columnFor(def.columns, issue.path)?.header ?? null;
    const message = plainMessage(issue);
    const id = `${header}|${message}`;
    if (seen.has(id)) continue;
    seen.add(id);
    errors.push({ column: header, message });
  }
  return { data: null, errors };
}

/** For kinds whose rows add one record together (open orders): the group of a raw row, or null. */
export function rowGroup(kind, cells) {
  const def = getImportKind(kind);
  return def.groupOfCells ? def.groupOfCells(cells) : null;
}

/** The natural key of a parsed record (Decision 3): equal keys are the same record. */
export function rowKey(kind, data) {
  return getImportKind(kind).key(data);
}

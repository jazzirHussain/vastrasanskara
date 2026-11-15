// GSTR-1 sheets in the GST offline tool's layout, built from billing document views. Pure.
import { stateName } from '../states.js';

const col = (key, label, kind = 'text') => ({ key, label, kind });

const HSN_COLUMNS = [
  col('hsn', 'HSN'),
  col('description', 'Description'),
  col('uqc', 'UQC'),
  col('totalQuantity', 'Total Quantity', 'number'),
  col('totalValue', 'Total Value', 'money'),
  col('rate', 'Rate', 'number'),
  col('taxableValue', 'Taxable Value', 'money'),
  col('integratedTax', 'Integrated Tax Amount', 'money'),
  col('centralTax', 'Central Tax Amount', 'money'),
  col('stateTax', 'State/UT Tax Amount', 'money'),
  col('cessAmount', 'Cess Amount', 'money'),
];

/** Sheet → column descriptors; labels are verbatim from the GST offline tool. */
export const GSTR1_COLUMNS = Object.freeze({
  b2b: [
    col('gstin', 'GSTIN/UIN of Recipient'),
    col('receiverName', 'Receiver Name'),
    col('invoiceNumber', 'Invoice Number'),
    col('invoiceDate', 'Invoice date'),
    col('invoiceValue', 'Invoice Value', 'money'),
    col('placeOfSupply', 'Place Of Supply'),
    col('reverseCharge', 'Reverse Charge'),
    col('applicablePercent', 'Applicable % of Tax Rate'),
    col('invoiceType', 'Invoice Type'),
    col('ecommerceGstin', 'E-Commerce GSTIN'),
    col('rate', 'Rate', 'number'),
    col('taxableValue', 'Taxable Value', 'money'),
    col('cessAmount', 'Cess Amount', 'money'),
  ],
  b2cl: [
    col('invoiceNumber', 'Invoice Number'),
    col('invoiceDate', 'Invoice date'),
    col('invoiceValue', 'Invoice Value', 'money'),
    col('placeOfSupply', 'Place Of Supply'),
    col('applicablePercent', 'Applicable % of Tax Rate'),
    col('rate', 'Rate', 'number'),
    col('taxableValue', 'Taxable Value', 'money'),
    col('cessAmount', 'Cess Amount', 'money'),
    col('ecommerceGstin', 'E-Commerce GSTIN'),
  ],
  b2cs: [
    col('type', 'Type'),
    col('placeOfSupply', 'Place Of Supply'),
    col('applicablePercent', 'Applicable % of Tax Rate'),
    col('rate', 'Rate', 'number'),
    col('taxableValue', 'Taxable Value', 'money'),
    col('cessAmount', 'Cess Amount', 'money'),
    col('ecommerceGstin', 'E-Commerce GSTIN'),
  ],
  cdnr: [
    col('gstin', 'GSTIN/UIN of Recipient'),
    col('receiverName', 'Receiver Name'),
    col('noteNumber', 'Note Number'),
    col('noteDate', 'Note Date'),
    col('noteType', 'Note Type'),
    col('placeOfSupply', 'Place Of Supply'),
    col('reverseCharge', 'Reverse Charge'),
    col('noteSupplyType', 'Note Supply Type'),
    col('noteValue', 'Note Value', 'money'),
    col('applicablePercent', 'Applicable % of Tax Rate'),
    col('rate', 'Rate', 'number'),
    col('taxableValue', 'Taxable Value', 'money'),
    col('cessAmount', 'Cess Amount', 'money'),
  ],
  cdnur: [
    col('urType', 'UR Type'),
    col('noteNumber', 'Note Number'),
    col('noteDate', 'Note Date'),
    col('noteType', 'Note Type'),
    col('placeOfSupply', 'Place Of Supply'),
    col('noteValue', 'Note Value', 'money'),
    col('applicablePercent', 'Applicable % of Tax Rate'),
    col('rate', 'Rate', 'number'),
    col('taxableValue', 'Taxable Value', 'money'),
    col('cessAmount', 'Cess Amount', 'money'),
  ],
  at: [
    col('placeOfSupply', 'Place Of Supply'),
    col('applicablePercent', 'Applicable % of Tax Rate'),
    col('rate', 'Rate', 'number'),
    col('grossAdvanceReceived', 'Gross Advance Received', 'money'),
    col('cessAmount', 'Cess Amount', 'money'),
  ],
  atadj: [
    col('placeOfSupply', 'Place Of Supply'),
    col('applicablePercent', 'Applicable % of Tax Rate'),
    col('rate', 'Rate', 'number'),
    col('grossAdvanceAdjusted', 'Gross Advance Adjusted', 'money'),
    col('cessAmount', 'Cess Amount', 'money'),
  ],
  'hsn(b2b)': HSN_COLUMNS,
  'hsn(b2c)': HSN_COLUMNS,
  docs: [
    col('nature', 'Nature of Document'),
    col('from', 'Sr. No. From'),
    col('to', 'Sr. No. To'),
    col('totalNumber', 'Total Number', 'number'),
    col('cancelled', 'Cancelled', 'number'),
  ],
});

/** Catalog unit → GST unit quantity code (Decision 14). Services report `NA`. */
export const UQC_BY_UNIT = Object.freeze({
  PCS: 'PCS-PIECES',
  MTR: 'MTR-METERS',
  SET: 'SET-SETS',
  NOS: 'NOS-NUMBERS',
  OTH: 'OTH-OTHERS',
});

const DOC_NATURES = Object.freeze({
  invoice: 'Invoices for outward supply',
  credit_note: 'Credit Note',
  receipt_voucher: 'Receipt Voucher',
  refund: 'Refund Voucher',
});
const NATURE_ORDER = Object.keys(DOC_NATURES);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-10-05' → '05-Oct-2026', the offline tool's date format. */
export function gstDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ''));
  if (!m) throw new RangeError(`Invalid date: ${ymd}`);
  return `${m[3]}-${MONTHS[Number(m[2]) - 1]}-${m[1]}`;
}

/** '29' → '29-Karnataka'. */
export function gstPlace(stateCode) {
  return `${stateCode}-${stateName(stateCode)}`;
}

const percent = (rateBp) => rateBp / 100;
const byNumber = (a, b) => a.localeCompare(b, 'en', { numeric: true });
const byDateNumber = (a, b) => (a.date === b.date ? byNumber(a.number, b.number) : a.date < b.date ? -1 : 1);

/** 'b2b' | 'b2cl' | 'b2cs' for an invoice view (Decision 14; B2CL needs total strictly above the threshold). */
export function classifyInvoice(view, b2clThreshold) {
  if (view.customer.registered) return 'b2b';
  if (view.placeOfSupply?.interState && view.totals.total > b2clThreshold) return 'b2cl';
  return 'b2cs';
}

function noteClass(note, b2clThreshold) {
  const o = note.original;
  if (o.registered) return 'cdnr';
  if (o.interState && o.total > b2clThreshold) return 'cdnur';
  return 'b2cs';
}

/** Taxable per rate, ascending by rate. */
function taxableByRate(lines) {
  const m = new Map();
  for (const l of lines) m.set(l.gstRateBp, (m.get(l.gstRateBp) ?? 0) + l.taxable);
  return [...m.entries()].sort((a, b) => a[0] - b[0]);
}

/** Sums `amount` into buckets keyed by state × rate; returns them ordered by state then rate. */
function bucketSum() {
  const m = new Map();
  return {
    add(stateCode, rateBp, amount) {
      const key = `${stateCode}|${rateBp}`;
      const b = m.get(key) ?? { stateCode, rateBp, amount: 0 };
      b.amount += amount;
      m.set(key, b);
    },
    list() {
      return [...m.values()].sort((a, b) => (a.stateCode === b.stateCode ? a.rateBp - b.rateBp : a.stateCode < b.stateCode ? -1 : 1));
    },
  };
}

function hsnSummary() {
  const m = new Map();
  return {
    add(line, sign) {
      const key = `${line.hsnSac}|${line.gstRateBp}`;
      const service = line.supplyType === 'service';
      const r = m.get(key) ?? {
        hsn: line.hsnSac,
        description: line.description,
        uqc: service ? 'NA' : (UQC_BY_UNIT[line.unit] ?? UQC_BY_UNIT.OTH),
        totalQuantity: 0,
        totalValue: 0,
        rate: percent(line.gstRateBp),
        taxableValue: 0,
        integratedTax: 0,
        centralTax: 0,
        stateTax: 0,
        cessAmount: 0,
      };
      // Credit notes net value and tax but not quantity: a credit is often a price allowance with no goods back.
      if (sign > 0 && !service) r.totalQuantity = Math.round((r.totalQuantity + line.quantity) * 1000) / 1000;
      r.taxableValue += sign * line.taxable;
      r.integratedTax += sign * line.igst;
      r.centralTax += sign * line.cgst;
      r.stateTax += sign * line.sgst;
      r.totalValue += sign * (line.taxable + line.igst + line.cgst + line.sgst);
      m.set(key, r);
    },
    list() {
      return [...m.values()].sort((a, b) => (a.hsn === b.hsn ? a.rate - b.rate : byNumber(a.hsn, b.hsn)));
    },
  };
}

function docsRows(series) {
  for (const s of series) {
    if (!Object.hasOwn(DOC_NATURES, s.nature)) throw new RangeError(`Unknown document nature: ${s.nature}`);
  }
  return [...series]
    .sort((a, b) => NATURE_ORDER.indexOf(a.nature) - NATURE_ORDER.indexOf(b.nature) || byNumber(a.prefix ?? a.from, b.prefix ?? b.from))
    .map((s) => ({ nature: DOC_NATURES[s.nature], from: s.from, to: s.to, totalNumber: s.total, cancelled: s.cancelled }));
}

const sheetTotals = (rows, key) => ({ rows: rows.length, taxable: rows.reduce((a, r) => a + r[key], 0) });

/**
 * The GSTR-1 workbook for `month` ('YYYY-MM'). `docs` are billing document views; documents dated
 * outside the month and cancelled documents are skipped (cancelled ones count only in `series`,
 * the document summary input). Rows are one per document × rate; B2CS and AT/ATADJ are summed per
 * place of supply × rate.
 */
export function gstr1Sheets({ docs, series = [], b2clThreshold, month }) {
  const live = docs.filter((d) => d.status === 'issued' && String(d.date).startsWith(`${month}-`)).sort(byDateNumber);

  const b2b = [];
  const b2cl = [];
  const cdnr = [];
  const cdnur = [];
  const b2cs = bucketSum();
  const at = bucketSum();
  const atadj = bucketSum();
  const hsnB2b = hsnSummary();
  const hsnB2c = hsnSummary();

  for (const d of live) {
    if (d.type === 'invoice') {
      const kind = classifyInvoice(d, b2clThreshold);
      const pos = d.placeOfSupply.stateCode;
      for (const [rateBp, taxable] of taxableByRate(d.lines)) {
        if (kind === 'b2b') {
          b2b.push({
            gstin: d.customer.gstin, receiverName: d.customer.name, invoiceNumber: d.number, invoiceDate: gstDate(d.date),
            invoiceValue: d.totals.total, placeOfSupply: gstPlace(pos), reverseCharge: 'N', applicablePercent: '',
            invoiceType: 'Regular B2B', ecommerceGstin: '', rate: percent(rateBp), taxableValue: taxable, cessAmount: 0,
          });
        } else if (kind === 'b2cl') {
          b2cl.push({
            invoiceNumber: d.number, invoiceDate: gstDate(d.date), invoiceValue: d.totals.total, placeOfSupply: gstPlace(pos),
            applicablePercent: '', rate: percent(rateBp), taxableValue: taxable, cessAmount: 0, ecommerceGstin: '',
          });
        } else {
          b2cs.add(pos, rateBp, taxable);
        }
      }
      const hsn = d.customer.registered ? hsnB2b : hsnB2c;
      for (const l of d.lines) hsn.add(l, 1);
      for (const a of d.advanceAdjustments ?? []) atadj.add(a.stateCode, a.gstRateBp, a.taxable);
    } else if (d.type === 'credit_note') {
      const kind = noteClass(d, b2clThreshold);
      const pos = d.placeOfSupply.stateCode;
      for (const [rateBp, taxable] of taxableByRate(d.lines)) {
        if (kind === 'cdnr') {
          cdnr.push({
            gstin: d.customer.gstin, receiverName: d.customer.name, noteNumber: d.number, noteDate: gstDate(d.date),
            noteType: 'C', placeOfSupply: gstPlace(pos), reverseCharge: 'N', noteSupplyType: 'Regular B2B',
            noteValue: d.totals.total, applicablePercent: '', rate: percent(rateBp), taxableValue: taxable, cessAmount: 0,
          });
        } else if (kind === 'cdnur') {
          cdnur.push({
            urType: 'B2CL', noteNumber: d.number, noteDate: gstDate(d.date), noteType: 'C', placeOfSupply: gstPlace(pos),
            noteValue: d.totals.total, applicablePercent: '', rate: percent(rateBp), taxableValue: taxable, cessAmount: 0,
          });
        } else {
          b2cs.add(pos, rateBp, -taxable);
        }
      }
      const hsn = d.original.registered ? hsnB2b : hsnB2c;
      for (const l of d.lines) hsn.add(l, -1);
    } else if (d.type === 'receipt_voucher') {
      for (const l of d.lines) at.add(d.placeOfSupply.stateCode, l.gstRateBp, l.taxable);
    } else if (d.type === 'refund' && d.rvReversal) {
      const r = d.rvReversal;
      atadj.add(r.stateCode, r.gstRateBp, r.taxable);
    }
  }

  const b2csRows = b2cs.list().map((b) => ({
    type: 'OE', placeOfSupply: gstPlace(b.stateCode), applicablePercent: '', rate: percent(b.rateBp),
    taxableValue: b.amount, cessAmount: 0, ecommerceGstin: '',
  }));
  const atRows = at.list().map((b) => ({
    placeOfSupply: gstPlace(b.stateCode), applicablePercent: '', rate: percent(b.rateBp), grossAdvanceReceived: b.amount, cessAmount: 0,
  }));
  const atadjRows = atadj.list().map((b) => ({
    placeOfSupply: gstPlace(b.stateCode), applicablePercent: '', rate: percent(b.rateBp), grossAdvanceAdjusted: b.amount, cessAmount: 0,
  }));

  const rowsBySheet = {
    b2b,
    b2cl,
    b2cs: b2csRows,
    cdnr,
    cdnur,
    at: atRows,
    atadj: atadjRows,
    'hsn(b2b)': hsnB2b.list(),
    'hsn(b2c)': hsnB2c.list(),
    docs: docsRows(series),
  };

  return {
    sheets: Object.keys(GSTR1_COLUMNS).map((name) => ({ name, columns: GSTR1_COLUMNS[name], rows: rowsBySheet[name] })),
    totals: {
      b2b: sheetTotals(b2b, 'taxableValue'),
      b2cl: sheetTotals(b2cl, 'taxableValue'),
      b2cs: sheetTotals(b2csRows, 'taxableValue'),
      cdnr: sheetTotals(cdnr, 'taxableValue'),
      cdnur: sheetTotals(cdnur, 'taxableValue'),
      at: sheetTotals(atRows, 'grossAdvanceReceived'),
      atadj: sheetTotals(atadjRows, 'grossAdvanceAdjusted'),
    },
  };
}

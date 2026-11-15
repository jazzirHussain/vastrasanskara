import { test, expect } from 'vitest';
import { GSTR1_COLUMNS, UQC_BY_UNIT, classifyInvoice, gstDate, gstr1Sheets } from '../src/reports/gstr1.js';
import * as shared from '../src/index.js';
import { creditNote, invoice, line, receiptVoucher, refund } from './gst-views.js';

const THRESHOLD = 10000000; // ₹1,00,000 in paise
const MONTH = '2026-10';

const build = (docs, series = []) => gstr1Sheets({ docs, series, b2clThreshold: THRESHOLD, month: MONTH });
const sheet = (out, name) => out.sheets.find((s) => s.name === name);
const rows = (out, name) => sheet(out, name).rows;

test('the GSTR-1 pieces are exported from the package', () => {
  expect(shared.gstr1Sheets).toBe(gstr1Sheets);
  expect(shared.GSTR1_COLUMNS).toBe(GSTR1_COLUMNS);
  expect(typeof shared.gstr3bSummary).toBe('function');
  expect(typeof shared.gstSetOff).toBe('function');
  expect(typeof shared.salesRegisterRows).toBe('function');
});

test('a registered customer\'s bill goes to B2B, one row per rate', () => {
  const bill = invoice({
    number: 'INV-10',
    gstin: '29ABCDE1234F1Z5',
    name: 'Sri Silks',
    lines: [line(500, 100000), line(1800, 300000), line(500, 50000)],
  });
  expect(classifyInvoice(bill, THRESHOLD)).toBe('b2b');
  const out = build([bill]);
  expect(rows(out, 'b2b')).toEqual([
    {
      gstin: '29ABCDE1234F1Z5', receiverName: 'Sri Silks', invoiceNumber: 'INV-10', invoiceDate: '05-Oct-2026',
      invoiceValue: bill.totals.total, placeOfSupply: '29-Karnataka', reverseCharge: 'N', applicablePercent: '',
      invoiceType: 'Regular B2B', ecommerceGstin: '', rate: 5, taxableValue: 150000, cessAmount: 0,
    },
    expect.objectContaining({ invoiceNumber: 'INV-10', rate: 18, taxableValue: 300000 }),
  ]);
  expect(out.totals.b2b).toEqual({ rows: 2, taxable: 450000 });
  expect(rows(out, 'b2cs')).toEqual([]);
});

test('the B2CL threshold is strictly greater than', () => {
  const at = invoice({ stateCode: '32', lines: [line(500, THRESHOLD, { stateCode: '32' })], total: THRESHOLD });
  const over = invoice({ stateCode: '32', lines: [line(500, THRESHOLD, { stateCode: '32' })], total: THRESHOLD + 100 });
  expect(classifyInvoice(at, THRESHOLD)).toBe('b2cs');
  expect(classifyInvoice(over, THRESHOLD)).toBe('b2cl');

  const out = build([at, over]);
  expect(rows(out, 'b2cl')).toEqual([
    {
      invoiceNumber: over.number, invoiceDate: '05-Oct-2026', invoiceValue: THRESHOLD + 100,
      placeOfSupply: '32-Kerala', applicablePercent: '', rate: 5, taxableValue: THRESHOLD, cessAmount: 0, ecommerceGstin: '',
    },
  ]);
  expect(rows(out, 'b2cs')).toEqual([
    { type: 'OE', placeOfSupply: '32-Kerala', applicablePercent: '', rate: 5, taxableValue: THRESHOLD, cessAmount: 0, ecommerceGstin: '' },
  ]);
});

test('an intra-state bill of any size is B2CS', () => {
  const big = invoice({ lines: [line(1800, 50000000)] });
  expect(classifyInvoice(big, THRESHOLD)).toBe('b2cs');
  expect(rows(build([big]), 'b2cs')).toEqual([expect.objectContaining({ placeOfSupply: '29-Karnataka', rate: 18, taxableValue: 50000000 })]);
});

test('B2CS is summed by place of supply and rate', () => {
  const out = build([
    invoice({ lines: [line(500, 100000), line(1800, 20000)] }),
    invoice({ lines: [line(500, 30000)] }),
    invoice({ stateCode: '33', lines: [line(500, 7000, { stateCode: '33' })] }),
  ]);
  expect(rows(out, 'b2cs').map((r) => [r.placeOfSupply, r.rate, r.taxableValue])).toEqual([
    ['29-Karnataka', 5, 130000],
    ['29-Karnataka', 18, 20000],
    ['33-Tamil Nadu', 5, 7000],
  ]);
  expect(out.totals.b2cs).toEqual({ rows: 3, taxable: 157000 });
});

test('an inter-state B2CL row and a B2CS row each read their own state', () => {
  const kerala = invoice({ stateCode: '32', lines: [line(500, 20000000, { stateCode: '32' })] });
  const goa = invoice({ stateCode: '30', lines: [line(1200, 40000, { stateCode: '30' })] });
  const out = build([kerala, goa]);
  expect(rows(out, 'b2cl')[0].placeOfSupply).toBe('32-Kerala');
  expect(rows(out, 'b2cs')[0].placeOfSupply).toBe('30-Goa');
});

test('credit notes on small bills reduce B2CS', () => {
  const bill = invoice({ lines: [line(500, 100000)] });
  const note = creditNote(bill, { lines: [line(500, 40000)] });
  const out = build([bill, note]);
  expect(rows(out, 'b2cs')).toEqual([expect.objectContaining({ placeOfSupply: '29-Karnataka', rate: 5, taxableValue: 60000 })]);
  expect(rows(out, 'cdnr')).toEqual([]);
  expect(rows(out, 'cdnur')).toEqual([]);
});

test('a credit note on a small bill from an earlier month still reduces this month\'s B2CS', () => {
  const september = invoice({ date: '2026-09-28', lines: [line(500, 100000)] });
  const note = creditNote(september, { lines: [line(500, 10000)] });
  expect(rows(build([note]), 'b2cs')).toEqual([expect.objectContaining({ rate: 5, taxableValue: -10000 })]);
});

test('a credit note for a registered customer goes to CDNR; on a B2CL bill to CDNUR', () => {
  const b2b = invoice({ number: 'INV-20', gstin: '27AAACB1234C1Z2', name: 'Film Co', stateCode: '27', lines: [line(1800, 500000, { stateCode: '27' })] });
  const b2cl = invoice({ number: 'INV-21', stateCode: '32', lines: [line(500, 30000000, { stateCode: '32' })] });
  const n1 = creditNote(b2b, { number: 'CN-1', date: '2026-10-09', lines: [line(1800, 100000, { stateCode: '27' })] });
  const n2 = creditNote(b2cl, { number: 'CN-2', date: '2026-10-10', lines: [line(500, 200000, { stateCode: '32' })] });
  const out = build([b2b, b2cl, n1, n2]);

  expect(rows(out, 'cdnr')).toEqual([
    {
      gstin: '27AAACB1234C1Z2', receiverName: 'Film Co', noteNumber: 'CN-1', noteDate: '09-Oct-2026', noteType: 'C',
      placeOfSupply: '27-Maharashtra', reverseCharge: 'N', noteSupplyType: 'Regular B2B', noteValue: n1.totals.total,
      applicablePercent: '', rate: 18, taxableValue: 100000, cessAmount: 0,
    },
  ]);
  expect(rows(out, 'cdnur')).toEqual([
    {
      urType: 'B2CL', noteNumber: 'CN-2', noteDate: '10-Oct-2026', noteType: 'C', placeOfSupply: '32-Kerala',
      noteValue: n2.totals.total, applicablePercent: '', rate: 5, taxableValue: 200000, cessAmount: 0,
    },
  ]);
  // The notes do not change the bills' own rows.
  expect(rows(out, 'b2b')[0].taxableValue).toBe(500000);
  expect(rows(out, 'b2cl')[0].taxableValue).toBe(30000000);
});

test('cancelled bills appear only in the document summary', () => {
  const cancelled = invoice({ number: 'INV-3', status: 'cancelled', gstin: '29ABCDE1234F1Z5', lines: [line(500, 100000)] });
  const cancelledSmall = invoice({ number: 'INV-4', status: 'cancelled', lines: [line(500, 100000)] });
  const series = [
    { nature: 'invoice', prefix: 'INV-', from: 'INV-1', to: 'INV-4', total: 4, cancelled: 2 },
    { nature: 'credit_note', prefix: 'CN-', from: 'CN-1', to: 'CN-1', total: 1, cancelled: 0 },
    { nature: 'receipt_voucher', prefix: 'RV-', from: 'RV-1', to: 'RV-2', total: 2, cancelled: 0 },
    { nature: 'refund', prefix: 'RF-', from: 'RF-1', to: 'RF-1', total: 1, cancelled: 1 },
  ];
  const out = build([cancelled, cancelledSmall], series);
  for (const name of ['b2b', 'b2cl', 'b2cs', 'cdnr', 'cdnur', 'at', 'atadj', 'hsn(b2b)', 'hsn(b2c)']) {
    expect(rows(out, name)).toEqual([]);
  }
  expect(rows(out, 'docs')).toEqual([
    { nature: 'Invoices for outward supply', from: 'INV-1', to: 'INV-4', totalNumber: 4, cancelled: 2 },
    { nature: 'Credit Note', from: 'CN-1', to: 'CN-1', totalNumber: 1, cancelled: 0 },
    { nature: 'Receipt Voucher', from: 'RV-1', to: 'RV-2', totalNumber: 2, cancelled: 0 },
    { nature: 'Refund Voucher', from: 'RF-1', to: 'RF-1', totalNumber: 1, cancelled: 1 },
  ]);
});

test('the document summary lists each series of a nature in order', () => {
  const series = [
    { nature: 'refund', prefix: 'RF-', from: 'RF-1', to: 'RF-1', total: 1, cancelled: 0 },
    { nature: 'invoice', prefix: 'INV-B-', from: 'INV-B-1', to: 'INV-B-3', total: 3, cancelled: 0 },
    { nature: 'invoice', prefix: 'INV-A-', from: 'INV-A-1', to: 'INV-A-2', total: 2, cancelled: 1 },
  ];
  expect(rows(build([], series), 'docs').map((r) => [r.nature, r.from])).toEqual([
    ['Invoices for outward supply', 'INV-A-1'],
    ['Invoices for outward supply', 'INV-B-1'],
    ['Refund Voucher', 'RF-1'],
  ]);
  expect(() => build([], [{ nature: 'quote', prefix: 'Q', from: 'Q1', to: 'Q1', total: 1, cancelled: 0 }])).toThrow(RangeError);
});

test('advances and their adjustments fill AT and ATADJ', () => {
  const docs = [
    receiptVoucher({ lines: [line(500, 100000), line(1800, 50000)] }),
    receiptVoucher({ lines: [line(500, 20000)] }),
    receiptVoucher({ stateCode: '32', lines: [line(500, 9000, { stateCode: '32' })] }),
    receiptVoucher({ status: 'cancelled', lines: [line(500, 777700)] }),
    invoice({
      lines: [line(500, 300000)],
      advanceAdjustments: [
        { stateCode: '29', gstRateBp: 500, taxable: 60000, cgst: 1500, sgst: 1500, igst: 0 },
        { stateCode: '29', gstRateBp: 1800, taxable: 10000, cgst: 900, sgst: 900, igst: 0 },
      ],
    }),
    invoice({ status: 'cancelled', advanceAdjustments: [{ stateCode: '29', gstRateBp: 500, taxable: 999900, cgst: 0, sgst: 0, igst: 0 }] }),
    refund({ amount: 21000, rvReversal: { stateCode: '29', gstRateBp: 500, taxable: 20000, cgst: 500, sgst: 500, igst: 0 } }),
    refund({ amount: 5000, rvReversal: null }),
  ];
  const out = build(docs);
  expect(rows(out, 'at')).toEqual([
    { placeOfSupply: '29-Karnataka', applicablePercent: '', rate: 5, grossAdvanceReceived: 120000, cessAmount: 0 },
    { placeOfSupply: '29-Karnataka', applicablePercent: '', rate: 18, grossAdvanceReceived: 50000, cessAmount: 0 },
    { placeOfSupply: '32-Kerala', applicablePercent: '', rate: 5, grossAdvanceReceived: 9000, cessAmount: 0 },
  ]);
  expect(rows(out, 'atadj')).toEqual([
    { placeOfSupply: '29-Karnataka', applicablePercent: '', rate: 5, grossAdvanceAdjusted: 80000, cessAmount: 0 },
    { placeOfSupply: '29-Karnataka', applicablePercent: '', rate: 18, grossAdvanceAdjusted: 10000, cessAmount: 0 },
  ]);
  expect(out.totals.at).toEqual({ rows: 3, taxable: 179000 });
  expect(out.totals.atadj).toEqual({ rows: 2, taxable: 90000 });
});

test('HSN summary splits B2B and B2C, nets credit notes and maps units', () => {
  expect(UQC_BY_UNIT).toEqual({ PCS: 'PCS-PIECES', MTR: 'MTR-METERS', SET: 'SET-SETS', NOS: 'NOS-NUMBERS', OTH: 'OTH-OTHERS' });
  const registered = invoice({
    gstin: '29ABCDE1234F1Z5',
    lines: [line(500, 100000, { hsnSac: '6204', unit: 'PCS', quantity: 2 }), line(1800, 40000, { hsnSac: '998821', unit: 'NOS', quantity: 1, supplyType: 'service', description: 'Stitching' })],
  });
  const small1 = invoice({ lines: [line(500, 50000, { hsnSac: '5208', unit: 'MTR', quantity: 2.5, description: 'Cotton' })] });
  const small2 = invoice({ lines: [line(500, 30000, { hsnSac: '5208', unit: 'MTR', quantity: 1.25, description: 'Cotton' })] });
  const note = creditNote(small1, { lines: [line(500, 10000, { hsnSac: '5208', unit: 'MTR', quantity: 1, description: 'Cotton' })] });
  const out = build([registered, small1, small2, note]);

  expect(rows(out, 'hsn(b2b)')).toEqual([
    {
      hsn: '6204', description: 'Kurta', uqc: 'PCS-PIECES', totalQuantity: 2, totalValue: 105000, rate: 5,
      taxableValue: 100000, integratedTax: 0, centralTax: 2500, stateTax: 2500, cessAmount: 0,
    },
    {
      hsn: '998821', description: 'Stitching', uqc: 'NA', totalQuantity: 0, totalValue: 47200, rate: 18,
      taxableValue: 40000, integratedTax: 0, centralTax: 3600, stateTax: 3600, cessAmount: 0,
    },
  ]);
  expect(rows(out, 'hsn(b2c)')).toEqual([
    {
      hsn: '5208', description: 'Cotton', uqc: 'MTR-METERS', totalQuantity: 3.75, totalValue: 73500, rate: 5,
      taxableValue: 70000, integratedTax: 0, centralTax: 1750, stateTax: 1750, cessAmount: 0,
    },
  ]);
});

test('headers match the offline tool exactly', () => {
  const labels = (name) => GSTR1_COLUMNS[name].map((c) => c.label);
  expect(Object.keys(GSTR1_COLUMNS)).toEqual(['b2b', 'b2cl', 'b2cs', 'cdnr', 'cdnur', 'at', 'atadj', 'hsn(b2b)', 'hsn(b2c)', 'docs']);
  expect(labels('b2b')).toEqual([
    'GSTIN/UIN of Recipient', 'Receiver Name', 'Invoice Number', 'Invoice date', 'Invoice Value', 'Place Of Supply',
    'Reverse Charge', 'Applicable % of Tax Rate', 'Invoice Type', 'E-Commerce GSTIN', 'Rate', 'Taxable Value', 'Cess Amount',
  ]);
  expect(labels('b2cl')).toEqual([
    'Invoice Number', 'Invoice date', 'Invoice Value', 'Place Of Supply', 'Applicable % of Tax Rate', 'Rate',
    'Taxable Value', 'Cess Amount', 'E-Commerce GSTIN',
  ]);
  expect(labels('b2cs')).toEqual([
    'Type', 'Place Of Supply', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount', 'E-Commerce GSTIN',
  ]);
  expect(labels('cdnr')).toEqual([
    'GSTIN/UIN of Recipient', 'Receiver Name', 'Note Number', 'Note Date', 'Note Type', 'Place Of Supply', 'Reverse Charge',
    'Note Supply Type', 'Note Value', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount',
  ]);
  expect(labels('cdnur')).toEqual([
    'UR Type', 'Note Number', 'Note Date', 'Note Type', 'Place Of Supply', 'Note Value', 'Applicable % of Tax Rate', 'Rate',
    'Taxable Value', 'Cess Amount',
  ]);
  expect(labels('at')).toEqual(['Place Of Supply', 'Applicable % of Tax Rate', 'Rate', 'Gross Advance Received', 'Cess Amount']);
  expect(labels('atadj')).toEqual(['Place Of Supply', 'Applicable % of Tax Rate', 'Rate', 'Gross Advance Adjusted', 'Cess Amount']);
  const hsn = [
    'HSN', 'Description', 'UQC', 'Total Quantity', 'Total Value', 'Rate', 'Taxable Value', 'Integrated Tax Amount',
    'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount',
  ];
  expect(labels('hsn(b2b)')).toEqual(hsn);
  expect(labels('hsn(b2c)')).toEqual(hsn);
  expect(labels('docs')).toEqual(['Nature of Document', 'Sr. No. From', 'Sr. No. To', 'Total Number', 'Cancelled']);

  // Every column is a Task 1 descriptor, and every sheet carries its own columns.
  const kinds = new Set(['money', 'date', 'number', 'text']);
  for (const cols of Object.values(GSTR1_COLUMNS)) {
    for (const c of cols) expect(Object.keys(c).sort()).toEqual(['key', 'kind', 'label']);
    for (const c of cols) expect(kinds.has(c.kind)).toBe(true);
  }
  const out = build([]);
  expect(out.sheets.map((s) => s.name)).toEqual(Object.keys(GSTR1_COLUMNS));
  for (const s of out.sheets) expect(s.columns).toBe(GSTR1_COLUMNS[s.name]);
  expect(GSTR1_COLUMNS.b2b.find((c) => c.label === 'Invoice Value').kind).toBe('money');
  expect(GSTR1_COLUMNS.b2b.find((c) => c.label === 'Rate').kind).toBe('number');
});

test('place of supply reads 29-Karnataka; dates read 05-Oct-2026', () => {
  expect(gstDate('2026-10-05')).toBe('05-Oct-2026');
  expect(gstDate('2027-01-31')).toBe('31-Jan-2027');
  const out = build([invoice({ gstin: '29ABCDE1234F1Z5', date: '2026-10-05' })]);
  expect(rows(out, 'b2b')[0]).toMatchObject({ placeOfSupply: '29-Karnataka', invoiceDate: '05-Oct-2026' });
});

test('documents dated outside the month are left out', () => {
  const out = build([invoice({ date: '2026-11-01' }), invoice({ date: '2026-09-30' }), invoice({ date: '2026-10-31' })]);
  expect(out.totals.b2cs).toEqual({ rows: 1, taxable: 100000 });
});

test('rows are in a fixed order whatever order the documents come in', () => {
  const a = invoice({ number: 'INV-2', date: '2026-10-03', gstin: '29ABCDE1234F1Z5' });
  const b = invoice({ number: 'INV-1', date: '2026-10-03', gstin: '29ABCDE1234F1Z5' });
  const c = invoice({ number: 'INV-0', date: '2026-10-07', gstin: '29ABCDE1234F1Z5' });
  expect(rows(build([c, a, b]), 'b2b').map((r) => r.invoiceNumber)).toEqual(['INV-1', 'INV-2', 'INV-0']);
});

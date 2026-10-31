import { displayDate } from '@vs/shared/fy.js';
import { formatINR } from '@vs/shared/money.js';

// Pure: a stored snapshot in, a pdfmake document definition out. Nothing here reads the database,
// so a document prints as it was issued, whatever has changed since.

// "Blouse — Blouse (GN)" reads better as "Blouse (GN)".
const tidy = (text) => String(text ?? '').replace(/^(.+?) — \1(?= \(|$)/, '$1');
const inr = (paise) => formatINR(paise ?? 0);
const pct = (bp) => `${(bp ?? 0) / 100}%`;
const GREY = '#555555';
const LINE = '#bbbbbb';
const MODES = { cash: 'Cash', upi: 'UPI', card: 'Card', bank_transfer: 'Bank transfer', cheque: 'Cheque' };
const modeName = (mode) => MODES[mode] ?? String(mode ?? '').replace(/_/g, ' ');

const cell = (text, extra = {}) => ({ text: String(text ?? ''), ...extra });
const right = (text, extra = {}) => cell(text, { alignment: 'right', ...extra });
const head = (text, alignment) => cell(text, { bold: true, fillColor: '#f1f1f1', alignment });
const hr = () => ({
  canvas: [{ type: 'line', x1: 0, y1: 0, x2: 523, y2: 0, lineWidth: 0.7, lineColor: LINE }],
  margin: [0, 6, 0, 6],
});

const addressLines = (a = {}) => [a.line1, a.line2, [a.city, a.pincode].filter(Boolean).join(' ')].filter(Boolean);

function sellerBlock(seller, logo) {
  const contact = [seller.phone && `Phone: ${seller.phone}`, seller.email && `Email: ${seller.email}`].filter(Boolean);
  const stack = [
    { text: seller.legalName, bold: true, fontSize: 13 },
    ...addressLines(seller.address).map((text) => ({ text })),
    { text: [seller.stateName, seller.stateCode && `(${seller.stateCode})`].filter(Boolean).join(' ') },
    ...(seller.gstin ? [{ text: `GSTIN: ${seller.gstin}`, bold: true }] : []),
    ...contact.map((text) => ({ text })),
  ];
  const columns = [];
  if (logo) columns.push({ image: logo, fit: [60, 60], width: 66 });
  columns.push({ stack, width: '*' });
  return { columns, columnGap: 8 };
}

function titleBlock(snapshot, subtitle) {
  return {
    columns: [
      {
        stack: [{ text: snapshot.title, bold: true, fontSize: 20 }, ...(subtitle ? [{ text: subtitle, color: GREY }] : [])],
        width: '*',
      },
      {
        stack: [
          { text: `No. ${snapshot.number}`, bold: true, fontSize: 12, alignment: 'right' },
          { text: `Date: ${displayDate(snapshot.date)}`, alignment: 'right' },
          ...(snapshot.dueDate ? [{ text: `Due date: ${displayDate(snapshot.dueDate)}`, alignment: 'right' }] : []),
        ],
        width: 'auto',
      },
    ],
    margin: [0, 8, 0, 4],
  };
}

function customerBlock(customer, label = 'Bill to') {
  if (!customer) return { text: '' };
  return {
    stack: [
      { text: label, color: GREY, fontSize: 8 },
      { text: customer.name, bold: true, fontSize: 11 },
      ...addressLines(customer.address).map((text) => ({ text })),
      ...(customer.stateName ? [{ text: customer.stateName }] : []),
      ...(customer.gstin ? [{ text: `GSTIN: ${customer.gstin}`, bold: true }] : []),
    ],
  };
}

function placeBlock(snapshot, { reverseCharge = false } = {}) {
  const place = snapshot.placeOfSupply;
  if (!place) return { text: '' };
  return {
    stack: [
      { text: 'Place of supply', color: GREY, fontSize: 8 },
      { text: `${place.stateName} (${place.stateCode})`, bold: true },
      ...(reverseCharge ? [{ text: `Reverse charge: ${snapshot.reverseCharge ? 'Yes' : 'No'}` }] : []),
    ],
  };
}

const partiesRow = (snapshot, opts) => ({
  columns: [customerBlock(snapshot.customer), placeBlock(snapshot, opts)],
  columnGap: 12,
  margin: [0, 6, 0, 8],
});

const tableLayout = {
  hLineWidth: (i, node) => (i === 0 || i === 1 || i === node.table.body.length ? 0.7 : 0.3),
  vLineWidth: () => 0,
  hLineColor: () => LINE,
  paddingLeft: () => 3,
  paddingRight: () => 3,
  paddingTop: () => 3,
  paddingBottom: () => 3,
};

// rows: [label, value, bold]; grand: the big figure under them.
function totalsTable(rows, grand) {
  const stack = [
    {
      table: { widths: [150, 90], body: rows.map(([label, value, bold]) => [cell(label, { bold }), right(value, { bold })]) },
      layout: 'noBorders',
      margin: [0, 0, 0, 4],
    },
    {
      table: {
        widths: [150, 90],
        body: [[cell(grand.label, { bold: true, fontSize: 12 }), right(grand.value, { bold: true, fontSize: 14 })]],
      },
      layout: { hLineWidth: () => 1, vLineWidth: () => 0, hLineColor: () => '#222222', paddingTop: () => 4, paddingBottom: () => 4 },
    },
  ];
  return { columns: [{ text: '', width: '*' }, { stack, width: 'auto' }], unbreakable: true };
}

const taxRows = (t, inter) => [
  ['Taxable value', inr(t.taxable), false],
  ...(inter ? [['IGST', inr(t.igst), false]] : [['CGST', inr(t.cgst), false], ['SGST', inr(t.sgst), false]]),
  ['Round off', inr(t.roundOff), false],
];

const taxHeads = (inter) => (inter ? [head('IGST', 'right')] : [head('CGST', 'right'), head('SGST', 'right')]);
const taxCells = (l, inter) => (inter ? [right(inr(l.igst))] : [right(inr(l.cgst)), right(inr(l.sgst))]);

const wordsBlock = (words) => ({
  stack: [{ text: 'Amount in words', color: GREY, fontSize: 8 }, { text: words, bold: true }],
  margin: [0, 8, 0, 4],
});

const signatory = (seller, name) => ({
  stack: [
    { text: `For ${name ?? seller.legalName}`, bold: true, alignment: 'right', margin: [0, 24, 0, 24] },
    { text: 'Authorised signatory', alignment: 'right', color: GREY },
  ],
  unbreakable: true,
});

const footer = (snapshot) => (currentPage, pageCount) => {
  const s = snapshot.seller ?? {};
  return {
    columns: [
      { text: [s.legalName, s.phone, s.email].filter(Boolean).join('  |  '), color: GREY, fontSize: 8, margin: [36, 0, 0, 0] },
      { text: `Page ${currentPage} of ${pageCount}`, alignment: 'right', color: GREY, fontSize: 8, margin: [0, 0, 36, 0] },
    ],
  };
};

const base = (snapshot, content) => ({
  info: { title: `${snapshot.title} ${snapshot.number}` },
  content,
  footer: footer(snapshot),
});

const spacer = { text: '', margin: [0, 6, 0, 0] };

// --- Documents ---------------------------------------------------------------------------------

function linesTable(snapshot) {
  const inter = Boolean(snapshot.placeOfSupply?.interState);
  const header = [
    head('HSN/SAC'), head('Description'), head('Qty', 'right'), head('Rate', 'right'), head('Disc.', 'right'),
    head('Taxable', 'right'), head('GST', 'right'), ...taxHeads(inter), head('Total', 'right'),
  ];
  const body = (snapshot.lines ?? []).map((l) => [
    cell(l.item?.hsnSac ?? l.hsnSac ?? ''),
    cell(tidy(l.description)),
    right(`${l.quantity}${l.item?.unit ? ` ${l.item.unit}` : ''}`),
    right(inr(l.rate)),
    right(l.discount ? inr(l.discount) : '-'),
    right(inr(l.taxable)),
    right(pct(l.gstRateBp)),
    ...taxCells(l, inter),
    right(inr(l.total), { bold: true }),
  ]);
  const widths = inter ? [38, '*', 34, 48, 40, 52, 28, 46, 54] : [38, '*', 34, 46, 38, 48, 26, 40, 40, 52];
  return { table: { headerRows: 1, widths, body: [header, ...body] }, layout: tableLayout, fontSize: 8 };
}

function taxSummaryTable(snapshot) {
  const rows = snapshot.taxSummary ?? [];
  if (!rows.length) return { text: '' };
  const inter = Boolean(snapshot.placeOfSupply?.interState);
  const header = [head('HSN/SAC'), head('GST rate', 'right'), head('Taxable', 'right'), ...taxHeads(inter)];
  const body = rows.map((r) => [cell(r.hsnSac ?? ''), right(pct(r.rateBp)), right(inr(r.taxable)), ...taxCells(r, inter)]);
  return {
    stack: [
      { text: 'Tax summary', bold: true, margin: [0, 10, 0, 3] },
      {
        table: { headerRows: 1, widths: inter ? [70, 60, 80, 70] : [70, 60, 80, 70, 70], body: [header, ...body] },
        layout: tableLayout,
        fontSize: 8,
      },
    ],
    unbreakable: true,
  };
}

function invoiceDefinition(snapshot, { logo }) {
  const t = snapshot.totals;
  const inter = Boolean(snapshot.placeOfSupply?.interState);
  const rows = taxRows(t, inter);
  if (snapshot.invoiceDiscount?.amount) rows.unshift(['Bill discount', `-${inr(snapshot.invoiceDiscount.amount)}`, false]);
  const advance = snapshot.advanceApplied ?? 0;
  const totals =
    advance > 0
      ? totalsTable([...rows, ['Total', inr(t.total), true], ['Advance received', `-${inr(advance)}`, false]], {
          label: 'Balance due',
          value: inr(snapshot.balanceDue ?? t.total - advance),
        })
      : totalsTable(rows, { label: 'Total to pay', value: inr(t.total) });

  return base(snapshot, [
    sellerBlock(snapshot.seller, logo),
    titleBlock(snapshot, 'Original for recipient'),
    hr(),
    partiesRow(snapshot, { reverseCharge: true }),
    ...(snapshot.order ? [{ text: `Order: ${snapshot.order.orderNo}`, color: GREY, margin: [0, 0, 0, 4] }] : []),
    linesTable(snapshot),
    spacer,
    totals,
    wordsBlock(snapshot.amountInWords),
    taxSummaryTable(snapshot),
    ...(snapshot.notes ? [{ text: 'Notes', color: GREY, fontSize: 8, margin: [0, 8, 0, 0] }, { text: snapshot.notes }] : []),
    signatory(snapshot.seller, snapshot.signatory),
  ]);
}

function creditNoteDefinition(snapshot, { logo }) {
  const inter = Boolean(snapshot.placeOfSupply?.interState);
  const header = [head('HSN/SAC'), head('Description'), head('Taxable', 'right'), head('GST', 'right'), ...taxHeads(inter), head('Total', 'right')];
  const body = (snapshot.lines ?? []).map((l) => [
    cell(l.hsnSac ?? ''), cell(tidy(l.description)), right(inr(l.taxable)), right(pct(l.gstRateBp)),
    ...taxCells(l, inter), right(inr(l.total), { bold: true }),
  ]);
  return base(snapshot, [
    sellerBlock(snapshot.seller, logo),
    titleBlock(snapshot),
    hr(),
    partiesRow(snapshot),
    {
      stack: [
        { text: `Against bill ${snapshot.original?.number} dated ${displayDate(snapshot.original?.date)}`, bold: true },
        { text: `Reason: ${snapshot.reason || '-'}` },
      ],
      margin: [0, 0, 0, 8],
    },
    {
      table: { headerRows: 1, widths: inter ? [44, '*', 56, 30, 52, 58] : [44, '*', 52, 28, 44, 44, 56], body: [header, ...body] },
      layout: tableLayout,
      fontSize: 8,
    },
    spacer,
    totalsTable(taxRows(snapshot.totals, inter), { label: 'Credit total', value: inr(snapshot.totals.total) }),
    wordsBlock(snapshot.amountInWords),
    signatory(snapshot.seller),
  ]);
}

const detailTable = (rows) => ({
  table: { widths: [150, '*'], body: rows.map(([k, v]) => [cell(k, { color: GREY }), cell(v)]) },
  layout: 'noBorders',
});

function receiptDefinition(snapshot, { logo }) {
  const against = snapshot.against?.invoiceNo
    ? `Payment for bill ${snapshot.against.invoiceNo}`
    : snapshot.against?.orderNo
      ? `Advance for order ${snapshot.against.orderNo}`
      : 'Advance payment';
  return base(snapshot, [
    sellerBlock(snapshot.seller, logo),
    titleBlock(snapshot),
    hr(),
    { ...customerBlock(snapshot.customer, 'Received from'), margin: [0, 4, 0, 10] },
    detailTable([
      ['For', against],
      ['Paid by', modeName(snapshot.mode)],
      ...(snapshot.reference ? [['Reference', snapshot.reference]] : []),
      ...(snapshot.receivedOn ? [['Received on', displayDate(snapshot.receivedOn)]] : []),
    ]),
    { text: 'Amount received', color: GREY, fontSize: 8, margin: [0, 12, 0, 0] },
    { text: inr(snapshot.amount), bold: true, fontSize: 22 },
    wordsBlock(snapshot.amountInWords),
    signatory(snapshot.seller),
  ]);
}

function receiptVoucherDefinition(snapshot, { logo }) {
  const t = snapshot.totals ?? {};
  const inter = Boolean(snapshot.placeOfSupply?.interState);
  const header = [head('HSN/SAC'), head('GST', 'right'), head('Advance received', 'right'), head('Taxable', 'right'), ...taxHeads(inter)];
  const body = (snapshot.lines ?? []).map((l) => [
    cell(l.hsnSac ?? ''), right(pct(l.rateBp ?? l.gstRateBp)), right(inr(l.gross)), right(inr(l.taxable)), ...taxCells(l, inter),
  ]);
  return base(snapshot, [
    sellerBlock(snapshot.seller, logo),
    titleBlock(snapshot),
    hr(),
    partiesRow(snapshot, { reverseCharge: true }),
    { text: `Advance for order ${snapshot.against?.orderNo ?? ''}, received with receipt ${snapshot.receiptNo ?? ''}`, margin: [0, 0, 0, 8] },
    {
      table: { headerRows: 1, widths: inter ? ['*', 40, 90, 80, 70] : ['*', 40, 80, 70, 60, 60], body: [header, ...body] },
      layout: tableLayout,
      fontSize: 8,
    },
    spacer,
    totalsTable(taxRows(t, inter), { label: 'Advance received', value: inr(t.gross) }),
    wordsBlock(snapshot.amountInWords),
    signatory(snapshot.seller),
  ]);
}

function refundDefinition(snapshot, { logo }) {
  const r = snapshot.rvReversal;
  return base(snapshot, [
    sellerBlock(snapshot.seller, logo),
    titleBlock(snapshot),
    hr(),
    { ...customerBlock(snapshot.customer, 'Paid to'), margin: [0, 4, 0, 10] },
    detailTable([
      ['Paid by', modeName(snapshot.mode)],
      ...(snapshot.reference ? [['Reference', snapshot.reference]] : []),
      ...(snapshot.against?.orderNo ? [['Order', snapshot.against.orderNo]] : []),
      ['Reason', snapshot.reason || '-'],
    ]),
    { text: 'Amount refunded', color: GREY, fontSize: 8, margin: [0, 12, 0, 0] },
    { text: inr(snapshot.amount), bold: true, fontSize: 22 },
    wordsBlock(snapshot.amountInWords),
    ...(r
      ? [{ text: `GST on the advance reversed: CGST ${inr(r.cgst)}, SGST ${inr(r.sgst)}, IGST ${inr(r.igst)}`, color: GREY, margin: [0, 4, 0, 0] }]
      : []),
    signatory(snapshot.seller),
  ]);
}

const BUILDERS = {
  invoice: invoiceDefinition,
  credit_note: creditNoteDefinition,
  receipt: receiptDefinition,
  receipt_voucher: receiptVoucherDefinition,
  refund: refundDefinition,
};

/** The pdfmake document definition of an issued document, from its snapshot alone. `logo` is an image data URL. */
export function documentDefinition(snapshot, { logo } = {}) {
  const build = BUILDERS[snapshot?.docType];
  if (!build) throw new Error(`No PDF layout for document type: ${snapshot?.docType}`);
  return build(snapshot, { logo });
}

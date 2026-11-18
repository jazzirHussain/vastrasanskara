// Business reports: profit by order, on time by designer and vendor, enquiry conversion, profit by stock item.
import { invoicedOrderIds } from '../../billing/service.js';
import { orderProfits } from '../../costing/service.js';
import { enquiryConversionBySource } from '../../enquiries/service.js';
import { iterateGarmentsReady, orderLabels } from '../../orders/service.js';
import { vendorOnTime } from '../../production/service.js';
import { stockItemProfit } from '../../stock/service.js';
import { getUserNames } from '../../users/service.js';
import { checkRowLimit } from '../writers.js';
import { PAGE_LIMIT, registerBuilder } from './index.js';

const col = (key, label, kind = 'text') => ({ key, label, kind });
const percent = (part, whole) => (whole ? Math.round((part * 100) / whole) : null);
// Reports are admin files: they read the whole branch.
const WHOLE_BRANCH = { id: 'reports', permissions: new Set(['orders.read.all', 'orders.read.own']) };

const PROFIT_COLUMNS = [
  col('orderNo', 'Order'),
  col('customer', 'Customer'),
  col('revenue', 'Billed before GST', 'money'),
  col('material', 'Materials', 'money'),
  col('expense', 'Other costs', 'money'),
  col('profit', 'Profit', 'money'),
];

registerBuilder('order_profitability', async (branchId, { from, to }, { maxRows }) => {
  const rows = [];
  let cursor;
  do {
    const page = await invoicedOrderIds(branchId, { from, to, cursor, limit: PAGE_LIMIT });
    const [profits, labels] = await Promise.all([orderProfits(branchId, page.ids), orderLabels(branchId, page.ids)]);
    for (const id of page.ids) {
      const p = profits.get(id);
      const l = labels.get(id);
      rows.push({ orderId: id, orderNo: l?.orderNo ?? '', customer: l?.customerName ?? '', revenue: p.revenue, material: p.material, expense: p.expense, profit: p.profit });
    }
    checkRowLimit(rows.length, maxRows);
    cursor = page.nextCursor;
  } while (cursor);
  return { files: [{ sheets: [{ name: 'Profit by order', columns: PROFIT_COLUMNS, rows }] }] };
});

const DESIGNER_COLUMNS = [col('designer', 'Designer'), col('ready', 'Ready', 'number'), col('onTime', 'On time', 'number'), col('rate', 'On time %', 'number')];
const VENDOR_COLUMNS = [col('vendor', 'Vendor'), col('returned', 'Returned', 'number'), col('onTime', 'On time', 'number'), col('rate', 'On time %', 'number')];

registerBuilder('on_time', async (branchId, { from, to }, { maxRows }) => {
  const byDesigner = new Map();
  let seen = 0;
  for await (const g of iterateGarmentsReady(branchId, { ...WHOLE_BRANCH, branchId }, { from, to })) {
    const d = byDesigner.get(g.designerId) ?? { ready: 0, onTime: 0 };
    d.ready += 1;
    if (g.onTime) d.onTime += 1;
    byDesigner.set(g.designerId, d);
    seen += 1;
    checkRowLimit(seen, maxRows);
  }
  const names = await getUserNames([...byDesigner.keys()]);
  const designers = [...byDesigner.entries()]
    .map(([id, d]) => ({ designer: names.get(id) ?? '', ready: d.ready, onTime: d.onTime, rate: percent(d.onTime, d.ready) }))
    .sort((a, b) => a.designer.localeCompare(b.designer));
  const vendors = (await vendorOnTime(branchId, { from, to })).map((v) => ({ vendor: v.name, returned: v.returned, onTime: v.onTime, rate: percent(v.onTime, v.returned) }));
  return {
    files: [{
      sheets: [
        { name: 'By designer', columns: DESIGNER_COLUMNS, rows: designers },
        { name: 'By vendor', columns: VENDOR_COLUMNS, rows: vendors },
      ],
    }],
  };
});

const SOURCE_LABELS = { instagram: 'Instagram', referral: 'Referral', walk_in: 'Walk-in', website: 'Website', film_industry: 'Film industry', other: 'Other' };
const ENQUIRY_COLUMNS = [
  col('source', 'How they heard of us'),
  col('total', 'Enquiries', 'number'),
  col('converted', 'Became orders', 'number'),
  col('lost', 'Lost', 'number'),
  col('open', 'Still open', 'number'),
  col('rate', 'Conversion %', 'number'),
];

registerBuilder('enquiry_conversion', async (branchId, { from, to }) => {
  const rows = (await enquiryConversionBySource(branchId, { from, to })).map((r) => ({
    source: SOURCE_LABELS[r.source] ?? r.source, total: r.total, converted: r.converted, lost: r.lost, open: r.open, rate: percent(r.converted, r.total),
  }));
  return { files: [{ sheets: [{ name: 'Enquiries', columns: ENQUIRY_COLUMNS, rows }] }] };
});

const ITEM_COLUMNS = [
  col('item', 'Item'),
  col('quantity', 'Used or sold', 'number'),
  col('cost', 'Cost', 'money'),
  col('sales', 'At selling price', 'money'),
  col('profit', 'Profit', 'money'),
  col('note', 'Note'),
];

registerBuilder('stock_item_profit', async (branchId, { from, to }) => {
  const rows = (await stockItemProfit(branchId, { from, to })).map((r) => ({
    item: r.name, quantity: r.quantity / 1000, cost: r.cost, sales: r.sales, profit: r.profit, note: r.profit === null ? 'No selling price' : '',
  }));
  return { files: [{ sheets: [{ name: 'Profit by stock item', columns: ITEM_COLUMNS, rows }] }] };
});

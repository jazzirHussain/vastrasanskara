// Register builders over billing document views (Task 2 row builders).
import { REGISTER_COLUMNS, salesRegisterRows } from '@vs/shared/reports/registers.js';
import { billingDocumentsInRange } from '../../billing/service.js';
import { checkRowLimit } from '../writers.js';
import { registerBuilder } from './index.js';

/** Every view of `types` in [from, to], refusing more than `maxRows` as they stream in. */
export async function viewsInRange(branchId, { types, from, to }, maxRows) {
  const views = [];
  for await (const view of billingDocumentsInRange(branchId, { types, from, to })) {
    views.push(view);
    checkRowLimit(views.length, maxRows);
  }
  return views;
}

registerBuilder('sales_register', async (branchId, { from, to }, { maxRows }) => {
  const views = await viewsInRange(branchId, { types: ['invoice'], from, to }, maxRows);
  return { files: [{ sheets: [{ name: 'Sales register', columns: REGISTER_COLUMNS.sales, rows: salesRegisterRows(views) }] }] };
});

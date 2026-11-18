import { canReadGarmentFile } from '../../modules/orders/service.js';
import { canReadBillingPdf } from '../../modules/billing/service.js';
import { canReadStagePhoto } from '../../modules/production/service.js';
import { canReadExpenseFile } from '../../modules/expenses/service.js';

import { IMPORT_MAX_BYTES } from '@vs/shared';

export const ALLOWED_TYPES = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  // Windows browsers label .csv files this way (an old .xls is refused when the file is read).
  'application/vnd.ms-excel': 'csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
});
export const MAX_UPLOAD_BYTES = 10485760;
// Pictures and PDFs: what a purpose accepts unless it says otherwise.
const IMAGES_AND_PDF = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
export const SPREADSHEET_TYPES = Object.freeze([
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const purposes = new Map();

/**
 * Declares what a file is for and who may upload or read it. Branch scoping is enforced
 * by the files service (keys start with the branch id); canRead adds purpose-specific checks.
 */
export function registerFilePurpose(
  name,
  { allowedTypes = IMAGES_AND_PDF, maxBytes = MAX_UPLOAD_BYTES, canWrite, canRead },
) {
  purposes.set(name, { allowedTypes, maxBytes, canWrite, canRead });
}

export function getFilePurpose(name) {
  return purposes.get(name) ?? null;
}

// Registered centrally so every process (API and worker) knows every purpose.
registerFilePurpose('branch_logo', {
  canWrite: (user) => user.permissions.has('settings.edit'),
  canRead: async () => true,
});
registerFilePurpose('garment_reference', {
  allowedTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'],
  canWrite: (user) => user.permissions.has('orders.write') || user.permissions.has('production.update'),
  canRead: (user, key) => canReadGarmentFile(user, key),
});
registerFilePurpose('stage_photo', {
  allowedTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic'],
  canWrite: (user) => user.permissions.has('production.update') || user.permissions.has('orders.write'),
  canRead: (user, key) => canReadStagePhoto(user, key),
});
registerFilePurpose('billing_pdf', {
  allowedTypes: [],
  canWrite: () => false,
  canRead: (user, key) => canReadBillingPdf(user, key),
});
// Report files are written by the reports builder only, and read only through the audited
// /v1/reports/:id/download (which presigns directly): the general files route never gives a link.
registerFilePurpose('reports', {
  allowedTypes: [],
  canWrite: () => false,
  canRead: async () => false,
});
registerFilePurpose('expense_bill', {
  allowedTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'],
  canWrite: (user) => user.permissions.has('expenses.write'),
  canRead: (user, key) => canReadExpenseFile(user, key),
});
// Spreadsheets of old records for "Bring in old records": admin only, never shared.
registerFilePurpose('import_file', {
  allowedTypes: SPREADSHEET_TYPES,
  maxBytes: IMPORT_MAX_BYTES,
  canWrite: (user) => user.permissions.has('imports.run'),
  canRead: async (user) => user.permissions.has('imports.run'),
});

// Every Mongoose model the app defines, for `cli/migrate.js` (indexes) and `cli/atlas-role.js`
// (database privileges). Infrastructure only: no business code reads models through this file.
import mongoose from 'mongoose';
import * as appointments from './modules/appointments/model.js';
import * as billing from './modules/billing/model.js';
import * as branches from './modules/branches/model.js';
import * as catalog from './modules/catalog/model.js';
import * as customers from './modules/customers/model.js';
import * as dashboard from './modules/dashboard/model.js';
import * as enquiries from './modules/enquiries/model.js';
import * as expenses from './modules/expenses/model.js';
import * as measurements from './modules/measurements/model.js';
import * as orders from './modules/orders/model.js';
import * as periods from './modules/periods/model.js';
import * as production from './modules/production/model.js';
import * as reports from './modules/reports/model.js';
import * as settings from './modules/settings/model.js';
import * as stock from './modules/stock/model.js';
import * as users from './modules/users/model.js';
import * as vendors from './modules/vendors/model.js';
import * as workers from './modules/workers/model.js';
import * as imports from './modules/imports/model.js';
import * as auth from './modules/auth/model.js';
import * as audit from './core/audit/model.js';
import * as jobsModel from './core/jobs/model.js';
import * as notify from './core/notify/models.js';

const isBaseModel = (value) => typeof value === 'function' && value.prototype instanceof mongoose.Model && !value.baseModelName;
const modelsOf = (mod) => Object.values(mod).filter(isBaseModel);

export const MODELS = Object.freeze([
  ...new Set([appointments, billing, branches, catalog, customers, dashboard, enquiries, expenses, measurements, orders, periods, production, reports, settings, stock, users, vendors, workers, imports, auth, audit, jobsModel, notify].flatMap(modelsOf)),
]);

/** Collections the app writes without a Mongoose model. */
export const EXTRA_COLLECTIONS = Object.freeze(['counters', 'sessions', 'system', 'agendaJobs', 'migrations', 'idempotencyKeys']);

/** Every collection name the app uses, once each. */
export function appCollections() {
  return [...new Set([...MODELS.map((m) => m.collection.collectionName), ...EXTRA_COLLECTIONS])];
}

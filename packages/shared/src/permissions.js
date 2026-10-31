// Named permissions mapped to roles in one place. A user with several roles gets the union.

export const ROLES = Object.freeze(['admin', 'operations', 'designer']);

export const PERMISSIONS = Object.freeze({
  ORDERS_READ_ALL: 'orders.read.all',
  ORDERS_READ_OWN: 'orders.read.own',
  ORDERS_WRITE: 'orders.write',
  PRODUCTION_UPDATE: 'production.update',
  WORKSHOP_MANAGE: 'workshop.manage',
  MEASUREMENTS_WRITE: 'measurements.write',
  CUSTOMERS_READ: 'customers.read',
  CUSTOMERS_WRITE: 'customers.write',
  MONEY_VIEW: 'money.view',
  BILLING_DRAFT: 'billing.draft',
  BILLING_ISSUE: 'billing.issue',
  BILLING_CANCEL: 'billing.cancel',
  PAYMENTS_RECORD: 'payments.record',
  DISCOUNTS_GIVE: 'discounts.give',
  PERIODS_LOCK: 'periods.lock',
  AUDIT_VERIFY: 'audit.verify',
  REPORTS_EXPORT: 'reports.export',
  EXPENSES_VIEW: 'expenses.view',
  EXPENSES_WRITE: 'expenses.write',
  STOCK_VIEW: 'stock.view',
  STOCK_WRITE: 'stock.write',
  STOCK_CONSUME_OWN: 'stock.consume.own',
  SETTINGS_EDIT: 'settings.edit',
  USERS_MANAGE: 'users.manage',
  SYSTEM_MONITOR: 'system.monitor',
  CATALOG_MANAGE: 'catalog.manage',
  COSTING_VIEW: 'costing.view',
});

const ALL = Object.values(PERMISSIONS);
const P = PERMISSIONS;

const NOT_OPERATIONS = new Set([
  P.PRODUCTION_UPDATE,
  P.BILLING_CANCEL,
  P.PERIODS_LOCK,
  P.AUDIT_VERIFY,
  P.REPORTS_EXPORT,
  P.SETTINGS_EDIT,
  P.USERS_MANAGE,
  P.SYSTEM_MONITOR,
  P.STOCK_CONSUME_OWN,
  P.CATALOG_MANAGE,
  P.COSTING_VIEW,
]);

export const ROLE_PERMISSIONS = Object.freeze({
  admin: Object.freeze([...ALL]),
  operations: Object.freeze(ALL.filter((p) => !NOT_OPERATIONS.has(p))),
  designer: Object.freeze([
    P.ORDERS_READ_OWN,
    P.PRODUCTION_UPDATE,
    P.MEASUREMENTS_WRITE,
    P.CUSTOMERS_READ,
    P.STOCK_CONSUME_OWN,
  ]),
});

/** Union of the permissions of every role; throws on an unknown role. */
export function permissionsFor(roles) {
  const result = new Set();
  for (const role of roles) {
    if (!Object.hasOwn(ROLE_PERMISSIONS, role)) throw new Error(`Unknown role: ${role}`);
    for (const p of ROLE_PERMISSIONS[role]) result.add(p);
  }
  return result;
}

export function can(roles, permission) {
  return permissionsFor(roles).has(permission);
}

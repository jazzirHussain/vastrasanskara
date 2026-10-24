import mongoose from 'mongoose';
import { checkCustomerRules } from '@vs/shared/schemas/customers.js';
import { recordAudit } from '../../core/audit/service.js';
import { withTransaction } from '../../core/db.js';
import { AppError, conflict, notFound, validationError } from '../../core/errors.js';
import { paginate } from '../../core/pagination.js';
import { getBranch } from '../branches/service.js';
import { Customer } from './model.js';

// Changes to these fields are recorded in the audit log (they reach GST documents or consent).
const AUDITED = ['name', 'gstin', 'stateCode', 'billingAddress', 'consent', 'consentNote'];
const auditFields = (c) => Object.fromEntries(AUDITED.map((f) => [f, c[f] ?? null]));

const phoneTaken = (customerId) =>
  new AppError(409, 'PHONE_TAKEN', 'A customer with this phone already exists', { customerId: String(customerId) });

async function assertPhoneFree(branchId, phone, exceptId, session) {
  const existing = await Customer.findOne({ branchId, phone, _id: { $ne: exceptId } }, { _id: 1 })
    .session(session)
    .lean();
  if (existing) throw phoneTaken(existing._id);
}

// A unique-index race (two saves of the same phone at once) still reports the existing customer.
async function rethrowDuplicate(err, branchId, phone) {
  if (err?.code !== 11000) throw err;
  const existing = await Customer.findOne({ branchId, phone }, { _id: 1 }).lean();
  throw existing ? phoneTaken(existing._id) : err;
}

// The zod rules again, on the merged customer (a patch may change only one side of a rule).
function assertCustomerRules(customer) {
  const issues = [];
  checkCustomerRules(customer, { addIssue: (issue) => issues.push({ path: issue.path.join('.'), message: issue.message }) });
  if (issues.length) throw validationError(issues);
}

/** Creates a customer; the branch's state is used when no state code is given. */
export async function createCustomer(branchId, input, actor) {
  const stateCode = input.stateCode ?? (await getBranch(branchId)).stateCode;
  const fields = { ...input, stateCode };
  assertCustomerRules(fields);
  try {
    return await withTransaction(async (session) => {
      await assertPhoneFree(branchId, fields.phone, null, session);
      const [customer] = await Customer.create(
        [{ ...fields, branchId, searchName: fields.name.toLowerCase(), createdBy: actor.userId, updatedBy: actor.userId }],
        { session },
      );
      await recordAudit(
        { branchId, entityType: 'customer', entityId: customer._id, action: 'create', before: null, after: auditFields(customer), actor },
        session,
      );
      return customer.toObject();
    });
  } catch (err) {
    return rethrowDuplicate(err, branchId, fields.phone);
  }
}

/** Updates a customer at `version` (409 when someone else saved first). */
export async function updateCustomer(branchId, id, { version, patch }, actor) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  try {
    return await withTransaction(async (session) => {
      const customer = await Customer.findOne({ _id: id, branchId }).session(session);
      if (!customer) throw notFound();
      if (customer.__v !== version) throw conflict();
      const before = auditFields(customer);
      assertCustomerRules({ ...customer.toObject(), ...patch });
      if (patch.phone && patch.phone !== customer.phone) await assertPhoneFree(branchId, patch.phone, customer._id, session);

      customer.set(patch);
      if (patch.name) customer.searchName = patch.name.toLowerCase();
      customer.updatedBy = actor.userId;
      customer.increment();
      await customer.save({ session });
      const after = auditFields(customer);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        await recordAudit(
          { branchId, entityType: 'customer', entityId: customer._id, action: 'update', before, after, actor },
          session,
        );
      }
      return customer.toObject();
    });
  } catch (err) {
    return rethrowDuplicate(err, branchId, patch.phone);
  }
}

export async function getCustomer(branchId, id) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  const customer = await Customer.findOne({ _id: id, branchId }).lean();
  if (!customer) throw notFound();
  return customer;
}

/** Names of the given customers of the branch, by id (for order lists). */
export async function getCustomerNames(branchId, ids) {
  const customers = await Customer.find({ branchId, _id: { $in: ids } }, { name: 1 }).lean();
  return new Map(customers.map((c) => [String(c._id), c.name]));
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Customers of the branch by name. `q` with digits (and only digits, spaces, + or -) matches
 * phones containing those digits; any other `q` matches the start of the name.
 */
export function findCustomers(branchId, { q, cursor, limit } = {}) {
  const filter = { branchId };
  const term = q?.trim();
  if (term && /^[\d\s+-]+$/.test(term) && /\d/.test(term)) {
    filter.phone = { $regex: escapeRegex(term.replace(/\D/g, '')) };
  } else if (term) {
    filter.searchName = { $regex: `^${escapeRegex(term.toLowerCase())}` };
  }
  return paginate(Customer, filter, { sort: ['searchName', 1], limit, cursor });
}

/** Ids of the branch's customers whose name starts with `prefix` (for order search). */
export async function customerIdsByNamePrefix(branchId, prefix) {
  const customers = await Customer.find(
    { branchId, searchName: { $regex: `^${escapeRegex(prefix.toLowerCase())}` } },
    { _id: 1 },
  ).lean();
  return customers.map((c) => c._id);
}

/** The customer as a notification recipient, with their channel consent. */
export async function getCustomerForNotification(customerId, session) {
  if (!mongoose.isValidObjectId(customerId)) return null;
  const c = await Customer.findById(customerId).session(session ?? null).lean();
  if (!c) return null;
  return {
    kind: 'client',
    id: String(c._id),
    name: c.name,
    addresses: { email: c.email, phone: c.phone },
    consent: { ...c.consent },
  };
}

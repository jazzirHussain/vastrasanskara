// Enquiries: capture, edit, follow-up calls, lost and reopen. Never imports appointments or orders
// (they call in here), so the module graph stays acyclic. Personal data is never logged or audited.
import mongoose from 'mongoose';
import { MAX_ENQUIRY_LOG, istDate, nextEnquiryStatus } from '@vs/shared';
import { clock } from '../../clock.js';
import { withTransaction } from '../../core/db.js';
import { AppError, businessRule, conflict, notFound, validationError } from '../../core/errors.js';
import { createCustomer, findCustomerByPhone, getCustomer } from '../customers/service.js';
import { Enquiry } from './model.js';

export { enquiryListFilter, followUpsDue, listEnquiries } from './queries.js';

const enquiryExists = (enquiryId) =>
  new AppError(409, 'ENQUIRY_EXISTS', 'There is already an open enquiry for this phone', { enquiryId: String(enquiryId) });
export const enquiryClosed = () => businessRule('ENQUIRY_CLOSED', 'This enquiry is closed');

const findOpenByPhone = (branchId, phone, session) =>
  Enquiry.findOne({ branchId, phone, isOpen: true }, { _id: 1, name: 1, status: 1 }).session(session ?? null).lean();

async function assertNoOpenEnquiry(branchId, phone, exceptId, session) {
  const open = await findOpenByPhone(branchId, phone, session);
  if (open && String(open._id) !== String(exceptId)) throw enquiryExists(open._id);
}

// The open_phone unique index lost a race: report the enquiry that won.
async function rethrowDuplicate(err, branchId, phone) {
  if (err?.code !== 11000 || !phone) throw err;
  const open = await findOpenByPhone(branchId, phone);
  throw open ? enquiryExists(open._id) : err;
}

/** The next status for `action`; a closed enquiry is 422 ENQUIRY_CLOSED. */
function next(status, action) {
  try {
    return nextEnquiryStatus(status, action);
  } catch (err) {
    if (err instanceof RangeError && err.message === 'ENQUIRY_CLOSED') throw enquiryClosed();
    throw err;
  }
}

/** Appends to the activity log, keeping the newest MAX_ENQUIRY_LOG entries. */
function addLog(enquiry, { kind, text }, actor, at = clock.now()) {
  enquiry.log.push({ at, by: actor.userId ?? null, kind, text });
  if (enquiry.log.length > MAX_ENQUIRY_LOG) enquiry.log.splice(0, enquiry.log.length - MAX_ENQUIRY_LOG);
}

/**
 * Loads the enquiry (404), checks `version` (409, when given), lets `change` edit the document and
 * saves it with the version incremented. Inside `session` when given.
 */
async function changeEnquiry(branchId, id, version, actor, change, session) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  const enquiry = await Enquiry.findOne({ _id: id, branchId }).session(session ?? null);
  if (!enquiry) throw notFound();
  if (version !== undefined && enquiry.__v !== version) throw conflict();
  await change(enquiry);
  enquiry.updatedBy = actor.userId;
  enquiry.increment();
  try {
    await enquiry.save({ session });
  } catch (err) {
    if (session) throw err;
    return rethrowDuplicate(err, branchId, enquiry.isOpen ? enquiry.phone : null);
  }
  return enquiry.toObject();
}

/** Saves a new enquiry; a phone with an open enquiry is 409 ENQUIRY_EXISTS. */
export async function createEnquiry(branchId, input, actor) {
  await assertNoOpenEnquiry(branchId, input.phone, null, null);
  const now = clock.now();
  const { note, ...fields } = input;
  const enquiry = new Enquiry({
    ...fields,
    branchId,
    searchName: input.name.toLowerCase(),
    status: 'new',
    isOpen: true,
    enquiryDate: istDate(now),
    createdBy: actor.userId,
    updatedBy: actor.userId,
  });
  if (note) addLog(enquiry, { kind: 'note', text: note }, actor, now);
  try {
    await enquiry.save();
  } catch (err) {
    return rethrowDuplicate(err, branchId, input.phone);
  }
  return enquiry.toObject();
}

/** Who a phone already is: the branch's customer and its open enquiry, if any. */
export async function checkPhone(branchId, phone) {
  const [customer, open] = await Promise.all([findCustomerByPhone(branchId, phone), findOpenByPhone(branchId, phone)]);
  return {
    customer: customer ? { id: String(customer._id), name: customer.name } : null,
    openEnquiry: open ? { id: String(open._id), name: open.name, status: open.status } : null,
  };
}

export async function getEnquiry(branchId, id, session) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  const enquiry = await Enquiry.findOne({ _id: id, branchId }).session(session ?? null).lean();
  if (!enquiry) throw notFound();
  return enquiry;
}

/** Edits an open enquiry's details. */
export function updateEnquiry(branchId, id, { version, patch }, actor) {
  return changeEnquiry(branchId, id, version, actor, async (e) => {
    if (!e.isOpen) throw enquiryClosed();
    if (patch.phone && patch.phone !== e.phone) await assertNoOpenEnquiry(branchId, patch.phone, e._id, null);
    e.set(patch);
    if (patch.name) e.searchName = patch.name.toLowerCase();
  });
}

/** Records a call: what was said and the next call-back date (null = no more calls). */
export function logCall(branchId, id, { version, patch: { note, followUpDate } }, actor) {
  return changeEnquiry(branchId, id, version, actor, (e) => {
    e.status = next(e.status, 'call');
    e.followUpDate = followUpDate;
    addLog(e, { kind: 'call', text: note || 'Called' }, actor);
  });
}

/** "Not interested": closes the enquiry with a reason. */
export function markLost(branchId, id, { version, patch: { reason } }, actor) {
  return changeEnquiry(branchId, id, version, actor, (e) => {
    e.status = next(e.status, 'lost');
    e.isOpen = false;
    e.lostReason = reason;
    e.followUpDate = null;
    addLog(e, { kind: 'status', text: `Not interested: ${reason}` }, actor);
  });
}

/** Opens a lost enquiry again, due a call today, unless the phone has another open enquiry. */
export function reopenEnquiry(branchId, id, { version }, actor) {
  return changeEnquiry(branchId, id, version, actor, async (e) => {
    e.status = next(e.status, 'reopen');
    await assertNoOpenEnquiry(branchId, e.phone, e._id, null);
    e.isOpen = true;
    e.lostReason = null;
    e.followUpDate = istDate(clock.now());
    addLog(e, { kind: 'status', text: 'Reopened' }, actor);
  });
}


const notFoundAt = (path) => validationError([{ path, message: 'Not found' }]);

async function customerOfBranch(branchId, id, session) {
  try {
    return await getCustomer(branchId, id, session);
  } catch (err) {
    if (err?.code === 'NOT_FOUND') throw notFoundAt('customerId');
    throw err;
  }
}

/**
 * "Convert to order", step one: the customer the order will be for — the one staff picked, the
 * customer already linked, the customer with the enquiry's phone (`matched`), or a new customer
 * made from the enquiry's name, phone and source (no consent: that is asked when the order is
 * taken). The enquiry stays open until an order is saved for it (markEnquiryConverted).
 */
export function convertEnquiry(branchId, id, { version, patch: { customerId } }, actor) {
  return withTransaction(async (session) => {
    let customer = null;
    let matched = false;
    const enquiry = await changeEnquiry(
      branchId,
      id,
      version,
      actor,
      async (e) => {
        next(e.status, 'convert');
        if (customerId) customer = await customerOfBranch(branchId, customerId, session);
        else if (e.convertedCustomerId) customer = await getCustomer(branchId, e.convertedCustomerId, session);
        else {
          customer = await findCustomerByPhone(branchId, e.phone, session);
          matched = Boolean(customer);
          customer ??= await createCustomer(branchId, { name: e.name, phone: e.phone, source: e.source }, actor, { session });
        }
        e.convertedCustomerId = customer._id;
        addLog(e, { kind: 'status', text: 'Customer ready' }, actor);
      },
      session,
    );
    return { enquiry, customer, matched };
  });
}

/**
 * Step two, called by createOrder inside its transaction: the enquiry is converted to `orderId`
 * for `customerId`. Missing → 400 `enquiryId`; closed → 422 ENQUIRY_CLOSED; linked to another
 * customer → 422 ENQUIRY_CUSTOMER_MISMATCH. The order and the enquiry commit together.
 */
export async function markEnquiryConverted(branchId, enquiryId, { orderId, orderNo, customerId }, actor, session) {
  if (!session) throw new Error('markEnquiryConverted must run in a transaction');
  if (!mongoose.isValidObjectId(enquiryId) || !(await Enquiry.exists({ _id: enquiryId, branchId }).session(session))) {
    throw notFoundAt('enquiryId');
  }
  return changeEnquiry(
    branchId,
    enquiryId,
    undefined,
    actor,
    (e) => {
      e.status = next(e.status, 'convert');
      if (e.convertedCustomerId && String(e.convertedCustomerId) !== String(customerId)) {
        throw businessRule('ENQUIRY_CUSTOMER_MISMATCH', 'This enquiry was converted for a different customer');
      }
      e.isOpen = false;
      e.convertedCustomerId = customerId;
      e.convertedOrderId = orderId;
      e.convertedAt = clock.now();
      e.followUpDate = null;
      addLog(e, { kind: 'status', text: orderNo ? `Order ${orderNo}` : 'Order taken' }, actor);
    },
    session,
  );
}

/** Name, phone, converted customer and open flag of the branch's enquiries, by id (for appointments). */
export async function getEnquiryParties(branchId, ids, session) {
  const unique = [...new Set(ids.filter(Boolean).map(String))].filter((id) => mongoose.isValidObjectId(id));
  if (!unique.length) return new Map();
  const rows = await Enquiry.find({ branchId, _id: { $in: unique } }, { name: 1, phone: 1, convertedCustomerId: 1, isOpen: 1 })
    .session(session ?? null)
    .lean();
  return new Map(
    rows.map((e) => [String(e._id), { name: e.name, phone: e.phone, convertedCustomerId: e.convertedCustomerId ?? null, isOpen: e.isOpen }]),
  );
}

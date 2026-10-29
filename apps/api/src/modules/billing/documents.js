import { randomUUID } from 'node:crypto';
import { DOC_TYPES, PREFIX_FIELD, formatDocumentNumber } from '@vs/shared/billing.js';
import { financialYear, istDate } from '@vs/shared/fy.js';
import { stateName } from '@vs/shared/states.js';
import { businessRule } from '../../core/errors.js';
import { nextDocumentNumber } from '../../core/numbering.js';
import { getBranch } from '../branches/service.js';
import { readSettings } from '../settings/service.js';
import { BillingGuard, ImmutableDocumentError } from './model.js';

/**
 * The next gapless number of a billing document type, e.g. 'INV/2627/0001'. Must run inside
 * the transaction that issues the document, with the same `now` as its date: an aborted issue
 * (including a number that is too long) gives the number back.
 */
export async function takeDocumentNumber({ branchId, docType, now }, session) {
  if (!DOC_TYPES.includes(docType)) throw new Error(`Unknown billing document type: ${docType}`);
  const branch = await getBranch(branchId);
  const prefix = branch.prefixes[PREFIX_FIELD[docType]];
  const fyCode = financialYear(now).code;
  const start = (await readSettings(branchId, session)).numberSeries[`${docType}:${fyCode}`] ?? 1;
  const { number } = await nextDocumentNumber({ branchId, docType, now, start }, session);
  try {
    return { number: formatDocumentNumber(prefix, fyCode, number), fyCode };
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    throw businessRule('DOC_NUMBER_TOO_LONG', 'The bill number would be longer than 16 characters; shorten the prefix', {
      docType,
    });
  }
}

/**
 * Bumps the customer's money guard. Every transaction that changes a customer's money calls
 * this first, so two at once conflict and the driver retries one against the other's result.
 */
export async function guardCustomerMoney(branchId, customerId, session) {
  if (!session?.inTransaction()) throw new Error('guardCustomerMoney must be called inside a transaction');
  await BillingGuard.updateOne({ _id: `${branchId}:${customerId}` }, { $inc: { seq: 1 } }, { upsert: true, session });
}

/** Storage key for a billing document's PDF, chosen at issue (IST year). */
export function newPdfKey(branchId, now) {
  return `${branchId}/billing_pdf/${istDate(now).slice(0, 4)}/${randomUUID()}.pdf`;
}

const addressOf = (address) => ({
  line1: address?.line1 ?? '',
  line2: address?.line2 ?? '',
  city: address?.city ?? '',
  pincode: address?.pincode ?? '',
});

/** The seller as printed on a document. */
export function sellerSnapshot(branch) {
  return {
    name: branch.name,
    legalName: branch.legalName,
    gstin: branch.gstin ?? null,
    stateCode: branch.stateCode,
    stateName: stateName(branch.stateCode),
    address: addressOf(branch.address),
    phone: branch.phone ?? null,
    email: branch.email ?? null,
    logoKey: branch.logoKey ?? null,
  };
}

/** The customer as printed on a document. Phone and email stay out of the fixed record. */
export function customerSnapshot(customer) {
  return {
    id: String(customer._id ?? customer.id),
    name: customer.name,
    gstin: customer.gstin ?? null,
    stateCode: customer.stateCode,
    stateName: stateName(customer.stateCode),
    address: addressOf(customer.billingAddress),
    registered: Boolean(customer.gstin),
  };
}

/** The model's immutability error as the 422 staff see; any other error unchanged. */
export function toImmutableError(err) {
  if (err instanceof ImmutableDocumentError) {
    return businessRule('DOCUMENT_IMMUTABLE', 'Issued documents cannot be changed');
  }
  return err;
}

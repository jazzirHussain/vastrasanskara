import { formatINR } from '@vs/shared/money.js';
import { monthLabel } from './dates.js';

// Friendly text for the API's error codes; anything not listed shows the server's message.
export const errorMessages = {
  INVALID_CREDENTIALS: 'Email or password is incorrect.',
  ACCOUNT_LOCKED: 'Too many failed attempts. Try again in 15 minutes.',
  RATE_LIMITED: 'Too many attempts. Please wait and try again.',
  SESSION_EXPIRED: 'Your session has expired. Please log in again.',
  NOT_AUTHENTICATED: 'Please log in.',
  FORBIDDEN: 'You do not have access to this.',
  RANGE_TOO_LONG: 'That period is too long for Home. Use Reports for longer periods.',
  FILTER_TOO_BROAD: 'Too many customers match this filter. Try another one.',
  REPORT_NOT_READY: 'This file is still being prepared.',
  REPORT_TOO_LARGE: 'That is too much for one file. Choose a shorter period.',
  REPORT_FAILED: 'The file could not be made. Try again.',
  CONFLICT: 'Someone else changed this. Reload and try again.',
  PERIOD_LOCKED: 'This month is locked for filing and cannot be changed.',
  FILE_TYPE_NOT_ALLOWED: 'Only JPG, PNG, WebP, HEIC or PDF files can be uploaded.',
  FILE_TOO_LARGE: 'Files must be 10 MB or smaller.',
  EMAIL_TAKEN: 'A user with this email already exists.',
  LAST_ADMIN: 'At least one active admin is required.',
  CANNOT_DEACTIVATE_SELF: 'You cannot deactivate your own account.',
  RESET_TOKEN_INVALID: 'This reset link is invalid or has expired.',
  IDEMPOTENCY_KEY_REUSED: 'This order may already have been taken. Check Orders before trying again.',
  IDEMPOTENCY_IN_PROGRESS: 'This order is still being saved. Wait a moment, then check Orders.',
  PICKUP_IN_PAST: 'Pickup date cannot be in the past.',
  DUE_AFTER_PICKUP: 'A garment cannot be due after the pickup date.',
  DUE_IN_PAST: 'A garment cannot be due in the past.',
  INVALID_STATUS: 'This order cannot be changed in its current status.',
  PLAN_OUT_OF_RANGE: 'Planned dates must fall between today and the due date.',
  STAGE_ORDER_VIOLATION: 'This does not follow the stage order. Reload and try again.',
  ACTION_NOT_ALLOWED: 'That step is not possible for this garment right now.',
  WITH_VENDOR: 'This garment is with a vendor. Record it as back first.',
  REWORK_TARGET_INVALID: 'Choose an earlier stage that was not skipped.',
  PHONE_TAKEN: 'A customer with this phone already exists.',
  ENQUIRY_EXISTS: 'There is already an open enquiry for this phone.',
  ENQUIRY_CLOSED: 'This enquiry is closed. Reopen it first.',
  ENQUIRY_CUSTOMER_MISMATCH: 'This enquiry belongs to a different customer.',
  SLOT_TAKEN: 'That time is already booked for this designer. Pick another time.',
  APPOINTMENT_IN_PAST: 'This time has already passed.',
  APPOINTMENT_CLOSED: 'This appointment is closed and cannot be changed.',
  APPOINTMENT_NOT_DUE: 'You can mark this from the day of the appointment.',
  NOT_FOUND: 'This could not be found. It may have been removed. Reload and try again.',
  CATALOG_MAPPING_TAKEN: 'Another item already bills this. Change that item first.',
  PERIOD_NOT_ENDED: 'A month can be locked only after it has ended.',
  ALREADY_LOCKED: 'This month is already locked.',
  NOT_LOCKED: 'This month is not locked.',
  DOCUMENT_IMMUTABLE: 'This bill has been issued and cannot be changed.',
  NOTHING_TO_BILL: 'Everything on this order is already billed.',
  NO_LINES: 'Add at least one item to the bill.',
  ITEM_REQUIRED: 'Choose what each line is billed as.',
  STOCK_INSUFFICIENT: 'There is not enough of this in stock.',
  UNIT_FIXED: 'The unit cannot change once stock has moved.',
  NOTHING_TO_CHANGE: 'The count matches what is recorded.',
  MATERIALS_ALREADY_USED: 'Materials for this garment are already used. Use "Used more" or "Put back".',
  MATERIALS_NOT_USED_YET: 'Materials ready is not done yet. Change the planned list instead.',
  RECEIPT_USED: 'Some of this delivery has been used or counted. Count the stock instead.',
  EXPENSE_FROM_STOCK: 'This expense came from receiving stock. Undo the delivery in Stock to change it.',
  PRICE_NEEDED: 'Enter a price for every line.',
  ADDRESS_REQUIRED: 'Add the customer’s address. It is needed on bills of ₹50,000 or more.',
  BRANCH_GSTIN_MISSING: 'Add the boutique’s GSTIN in Settings before issuing bills.',
  GARMENT_NOT_BILLABLE: 'A garment on this bill was rejected or cancelled. Remove it and try again.',
  ALREADY_BILLED: 'Part of this bill is already on another bill.',
  DISCOUNT_EXCEEDS_LINE: 'A discount is more than the price of its line.',
  DISCOUNT_EXCEEDS_TOTAL: 'The discount is more than the bill.',
  DOC_NUMBER_TOO_LONG: 'The bill number would be too long. Shorten the prefix in Settings.',
  INVALID_AMOUNT: 'An amount on this bill is not valid. Check the prices, quantities and discounts.',
  BAD_SLABS: 'An item on this bill has GST rates that do not work. Ask the owner to check the price list.',
  ADVANCE_EXCEEDS_TOTAL: 'This is more than the order total.',
  HAS_CREDIT_NOTES: 'This bill has a credit note, so it cannot be cancelled.',
  CREDIT_EXCEEDS_INVOICE: 'That is more than is left on the bill.',
  CREDIT_EXCEEDS_LINE: 'That is more than is left on this line of the bill.',
  REFUND_EXCEEDS_BALANCE: 'That is more than the advance held for this customer.',
  ALREADY_CANCELLED: 'This has already been cancelled.',
  RECEIPT_REFUNDED: 'Part of this payment was refunded, so it cannot be cancelled.',
  VOUCHER_ADJUSTED: 'This advance is already on a bill. Cancel the bill first.',
  SERIES_IN_USE: 'This number series has started this year and cannot be changed.',
  EXPENSE_DATE_IN_FUTURE: 'The date cannot be in the future.',
  EXPENSE_FY_CHANGE: 'An expense cannot move to another financial year. Void it and add it again.',
  EXPENSE_VOIDED: 'This expense was voided and cannot be changed.',
  ALREADY_VOIDED: 'This expense is already voided.',
  ATTACHMENT_NOT_UPLOADED: 'A bill photo did not finish uploading. Add it again.',
  CATEGORY_REMOVED: 'Categories cannot be removed. Hide them instead.',
  NETWORK_ERROR: 'Cannot reach the server. Check your connection and try again.',
};

/**
 * The plain message for an error code: some name the month or the amount from the error's
 * `details`; anything not listed shows the server's message.
 */
export function messageFor(code, serverMessage, details) {
  if (code === 'PERIOD_LOCKED' && /^\d{4}-\d{2}$/.test(details?.month ?? '')) {
    return `${monthLabel(details.month)} is locked for filing, so nothing dated in it can be added, changed or cancelled.`;
  }
  if (code === 'REFUND_EXCEEDS_BALANCE' && Number.isSafeInteger(details?.available)) {
    return `The most you can refund is ${formatINR(details.available)}.`;
  }
  return errorMessages[code] ?? serverMessage ?? 'Something went wrong. Please try again.';
}

// Where a code means something different on a bill than on an order.
/** Why a bill photo did not upload, in plain words (by API error code). */
export const billPhotoErrorMessages = {
  FILE_TOO_LARGE: 'This file is too big. The most is 10 MB.',
  FILE_TYPE_NOT_ALLOWED: "This kind of file can't be added. Use a photo or a PDF.",
};
export const billPhotoErrorMessage = (error) => billPhotoErrorMessages[error?.code] ?? 'This did not upload. Remove it and add it again.';

export const billErrorMessages = {
  IDEMPOTENCY_KEY_REUSED: 'This bill may already have been issued. Reload the page to check.',
  IDEMPOTENCY_IN_PROGRESS: 'This bill is still being issued. Wait a moment, then reload the page.',
  VALIDATION_FAILED: 'Some details on this bill are not valid. Check each line and try again.',
  INVALID_STATUS: 'This bill cannot be changed in its current state. Reload the page.',
};

/** The plain message for an error on a bill screen. */
export const billErrorMessage = (error) => billErrorMessages[error?.code] ?? error?.message;

const paymentErrorMessages = {
  IDEMPOTENCY_KEY_REUSED: 'This payment may already be saved. Check the receipts before trying again.',
  IDEMPOTENCY_IN_PROGRESS: 'This payment may already be saved. Check the receipts before trying again.',
};

// Where a code means something different on a correction: a credit note, a refund or a payment cancelled.
const correctionErrorMessages = {
  creditNote: {
    IDEMPOTENCY_KEY_REUSED: 'This credit note may already be saved. Reload the bill to check.',
    IDEMPOTENCY_IN_PROGRESS: 'This credit note may already be saved. Reload the bill to check.',
    INVALID_STATUS: 'This bill cannot be reduced in its current state. Reload the page.',
  },
  refund: {
    IDEMPOTENCY_KEY_REUSED: 'This refund may already be saved. Check the customer’s money before trying again.',
    IDEMPOTENCY_IN_PROGRESS: 'This refund may already be saved. Check the customer’s money before trying again.',
  },
  receipt: {
    INVALID_STATUS: 'This payment cannot be cancelled in its current state. Reload the page.',
  },
};

/** The plain message for an error on a correction: `kind` is 'creditNote', 'refund' or 'receipt'. */
export const correctionErrorMessage = (kind, error) => correctionErrorMessages[kind][error?.code] ?? error?.message;

/** The plain message for an error while taking a payment (adds the limit when an advance is too big). */
export function paymentErrorMessage(error) {
  if (error?.code === 'ADVANCE_EXCEEDS_TOTAL' && Number.isSafeInteger(error.details?.maxAmount)) {
    return `${error.message} The most you can take now is ${formatINR(error.details.maxAmount)}.`;
  }
  return paymentErrorMessages[error?.code] ?? error?.message;
}

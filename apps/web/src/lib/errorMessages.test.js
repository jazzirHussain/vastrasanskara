import { describe, expect, test } from 'vitest';
import { errorMessages, messageFor } from './errorMessages.js';

const BILLING_CODES = [
  'CATALOG_MAPPING_TAKEN', 'PERIOD_NOT_ENDED', 'ALREADY_LOCKED', 'NOT_LOCKED', 'PERIOD_LOCKED', 'DOCUMENT_IMMUTABLE',
  'NOTHING_TO_BILL', 'NO_LINES', 'ITEM_REQUIRED', 'PRICE_NEEDED', 'ADDRESS_REQUIRED', 'BRANCH_GSTIN_MISSING',
  'GARMENT_NOT_BILLABLE', 'ALREADY_BILLED', 'DISCOUNT_EXCEEDS_LINE', 'DISCOUNT_EXCEEDS_TOTAL', 'DOC_NUMBER_TOO_LONG',
  'INVALID_AMOUNT', 'BAD_SLABS', 'ADVANCE_EXCEEDS_TOTAL', 'HAS_CREDIT_NOTES', 'CREDIT_EXCEEDS_INVOICE',
  'CREDIT_EXCEEDS_LINE', 'REFUND_EXCEEDS_BALANCE', 'ALREADY_CANCELLED', 'RECEIPT_REFUNDED', 'VOUCHER_ADJUSTED',
  'SERIES_IN_USE', 'INVALID_STATUS',
];

describe('billing error messages', () => {
  test('every billing error code has a plain message', () => {
    for (const code of BILLING_CODES) {
      expect(errorMessages[code], code).toMatch(/^[A-Z].*[.]$/);
    }
  });

  test('a locked month is named', () => {
    expect(messageFor('PERIOD_LOCKED', 'x', { month: '2026-10' })).toBe(
      'October 2026 is locked for filing, so nothing dated in it can be added, changed or cancelled.',
    );
    expect(messageFor('PERIOD_LOCKED', 'x', undefined)).toBe(errorMessages.PERIOD_LOCKED);
  });

  test('a refund that is too big says the most that can be refunded', () => {
    expect(messageFor('REFUND_EXCEEDS_BALANCE', 'x', { available: 150000 })).toBe('The most you can refund is ₹1,500.00.');
  });
});

describe('expense error messages', () => {
  test('every expense error code has a plain message', () => {
    for (const code of ['EXPENSE_DATE_IN_FUTURE', 'EXPENSE_FY_CHANGE', 'EXPENSE_VOIDED', 'ALREADY_VOIDED', 'ATTACHMENT_NOT_UPLOADED', 'CATEGORY_REMOVED']) {
      expect(errorMessages[code], code).toMatch(/^[A-Z].*[.]$/);
    }
  });
});

describe('stock error messages', () => {
  test('every stock error code has a plain message', () => {
    const codes = ['STOCK_INSUFFICIENT', 'UNIT_FIXED', 'NOTHING_TO_CHANGE', 'MATERIALS_ALREADY_USED', 'MATERIALS_NOT_USED_YET', 'RECEIPT_USED', 'EXPENSE_FROM_STOCK'];
    for (const code of codes) {
      expect(errorMessages[code], code).toMatch(/^[A-Z].*[.]$/);
    }
  });
});

describe('enquiry error messages', () => {
  test('every enquiry error code has a plain message', () => {
    for (const code of ['ENQUIRY_EXISTS', 'ENQUIRY_CLOSED', 'ENQUIRY_CUSTOMER_MISMATCH']) {
      expect(errorMessages[code], code).toMatch(/^[A-Z].*[.]$/);
    }
  });
});

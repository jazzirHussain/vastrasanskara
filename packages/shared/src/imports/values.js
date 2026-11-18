// Reading spreadsheet cells, in Indian conventions. Every function takes a raw cell value
// (string, number, boolean, Date or null) and returns { value } or { error }. Blank cells read
// as { value: null }; whether a column must be filled is the caller's rule. Messages are whole
// sentences without the column name (the caller prefixes "Phone: ").
import { z } from 'zod';
import { GST_STATES } from '../states.js';

const quote = (raw) => `'${String(raw).trim()}'`;
const fail = (error) => ({ error });
const blank = (raw) => raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '');

/** Numbers as Excel stores them, written out without exponent where they are whole. */
function cellText(raw) {
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && Math.abs(raw) < 1e21 ? raw.toFixed(0) : String(raw);
  }
  return String(raw).trim();
}

export function parseText(raw, { max = 200, required = false } = {}) {
  if (blank(raw)) return required ? fail('Fill this in.') : { value: null };
  const value = cellText(raw).replace(/\s+/g, ' ').trim();
  if (value.length > max) return fail(`Keep this to ${max} characters or fewer.`);
  return { value };
}

/** An Indian mobile number → its 10 digits ('+91 98765 43210', 098765-43210, 9.87654321E+09). */
export function parsePhone(raw) {
  if (blank(raw)) return { value: null };
  let text = cellText(raw);
  // Scientific notation as text (a CSV saved from Excel): only when every digit is still there.
  // '9.19877E+11' stands for some 12-digit number whose last digits are gone — never guess them.
  const sci = /^(\d)(?:\.(\d+))?e\+?(\d+)$/i.exec(text);
  if (sci) {
    const [, whole, fraction = '', exponent] = sci;
    if (fraction.length < Number(exponent)) {
      return fail(`${quote(raw)} lost digits when the file was saved. Format the phone column as Text and save again.`);
    }
    if (fraction.length === Number(exponent)) text = whole + fraction;
  }
  let digits = text.replace(/[\s\-().]/g, '');
  if (/^\+?91\d{10}$/.test(digits)) digits = digits.slice(-10);
  else if (/^0\d{10}$/.test(digits)) digits = digits.slice(1);
  if (!/^[6-9]\d{9}$/.test(digits)) return fail(`${quote(raw)} is not a 10-digit mobile number.`);
  return { value: digits };
}

const emailSchema = z.email();
export function parseEmail(raw) {
  if (blank(raw)) return { value: null };
  const value = cellText(raw).toLowerCase();
  if (value.length > 200 || !emailSchema.safeParse(value).success) return fail(`${quote(raw)} is not an email address.`);
  return { value };
}

// A decimal number in a cell, as text with at most `places` decimals → integer × 10^places.
function scaled(raw, places, { what, strip }) {
  let text = typeof raw === 'number' ? (Number.isFinite(raw) ? String(raw) : '') : cellText(raw);
  if (typeof raw === 'number' && /e/i.test(text)) text = raw.toFixed(places + 1).replace(/0+$/, '').replace(/\.$/, '');
  text = strip(text).replace(/,/g, '').replace(/\s+/g, '');
  const match = /^(-)?(\d+)?(?:\.(\d+))?$/.exec(text);
  if (!match || (match[2] === undefined && match[3] === undefined)) return fail(`${quote(raw)} is not ${what}.`);
  const [, sign, whole = '0', fraction = ''] = match;
  if (fraction.length > places) {
    // A float such as 0.30000000000000004 from a formula, or a value typed with too many decimals.
    if (typeof raw === 'number') {
      const rounded = Math.round(raw * 10 ** places);
      if (Math.abs(raw * 10 ** places - rounded) < 1e-6) return sign ? fail(`${quote(raw)} cannot be less than zero.`) : { value: rounded };
    }
    return fail(`${quote(raw)} has more than ${places} decimal places.`);
  }
  const value = Number(whole) * 10 ** places + Number(fraction.padEnd(places, '0'));
  if (!Number.isSafeInteger(value)) return fail(`${quote(raw)} is too large.`);
  if (sign && value !== 0) return fail(`${quote(raw)} cannot be less than zero.`);
  return { value };
}

const stripRupee = (text) => text.replace(/^(₹|rs\.?|inr)\s*/i, '').replace(/\/-$/, '');

/** '₹1,20,000.50', 'Rs. 500', 1234.5 → paise. */
export function parseRupees(raw) {
  if (blank(raw)) return { value: null };
  return scaled(raw, 2, { what: 'an amount in rupees', strip: stripRupee });
}

/** '5%', 12, '2.5' → basis points (500, 1200, 250). */
export function parsePercent(raw) {
  if (blank(raw)) return { value: null };
  return scaled(raw, 2, { what: 'a percentage', strip: (t) => t.replace(/%$/, '') });
}

/** '2.5' → 2500 thousandths. */
export function parseQty(raw) {
  if (blank(raw)) return { value: null };
  return scaled(raw, 3, { what: 'a quantity', strip: (t) => t });
}

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

function realDate(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** Day first, never month first: '05/11/2026', '5-11-26', '5.11.26', '2026-11-05', Excel serials and dates. */
export function parseDate(raw) {
  if (blank(raw)) return { value: null };
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return fail('This is not a date.');
    return { value: raw.toISOString().slice(0, 10) };
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 1 || raw > 2_958_465) return fail(`${quote(raw)} is not a date.`);
    return { value: new Date(EXCEL_EPOCH + Math.floor(raw) * DAY_MS).toISOString().slice(0, 10) };
  }
  const text = cellText(raw);
  let parts = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  let y, m, d;
  if (parts) [, y, m, d] = parts.map(Number);
  else {
    parts = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/.exec(text);
    if (!parts) return fail(`${quote(raw)} is not a date. Write it as day/month/year, like 05/11/2026.`);
    [, d, m, y] = parts.map(Number);
    if (parts[3].length === 2) y += 2000;
  }
  const value = realDate(y, m, d);
  return value ? { value } : fail(`${quote(raw)} is not a real date.`);
}

const YES = new Set(['yes', 'y', 'true', '1']);
const NO = new Set(['no', 'n', 'false', '0']);
export function parseYesNo(raw) {
  if (blank(raw)) return { value: null };
  if (typeof raw === 'boolean') return { value: raw };
  const text = cellText(raw).toLowerCase();
  if (YES.has(text)) return { value: true };
  if (NO.has(text)) return { value: false };
  return fail(`Write Yes or No, not ${quote(raw)}.`);
}

const squash = (text) => String(text).toLowerCase().replace(/[^a-z0-9]/g, '');
const STATE_BY_NAME = new Map(Object.entries(GST_STATES).map(([code, name]) => [squash(name), code]));

/** 'Karnataka', '29' or 29 → '29'. */
export function parseState(raw) {
  if (blank(raw)) return { value: null };
  const text = cellText(raw);
  if (/^\d{1,2}$/.test(text)) {
    const code = text.padStart(2, '0');
    if (Object.hasOwn(GST_STATES, code)) return { value: code };
  }
  const code = STATE_BY_NAME.get(squash(text));
  return code ? { value: code } : fail(`${quote(raw)} is not an Indian state or state code.`);
}

/** The label or the key, whatever the case and spacing → the key. */
export function parseChoice(raw, choices) {
  if (blank(raw)) return { value: null };
  const wanted = squash(cellText(raw));
  const found = choices.find((c) => squash(c.label) === wanted || squash(c.key) === wanted);
  if (found) return { value: found.key };
  return fail(`${quote(raw)} is not a choice. Choose one of: ${choices.map((c) => c.label).join(', ')}.`);
}

/** 'a, b; c' → ['a', 'b', 'c'] (trimmed, blanks dropped, first of each spelling kept). */
export function parseList(raw) {
  if (blank(raw)) return { value: null };
  const seen = new Set();
  const value = [];
  for (const part of cellText(raw).split(/[,;]/)) {
    const item = part.trim().replace(/\s+/g, ' ');
    if (!item || seen.has(item.toLowerCase())) continue;
    seen.add(item.toLowerCase());
    value.push(item);
  }
  return { value };
}

export { blank as isBlankCell };

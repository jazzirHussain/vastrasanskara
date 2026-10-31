// All money is integer paise. Formatting and rounding live only here.

function assertPaise(paise) {
  if (!Number.isSafeInteger(paise)) throw new RangeError(`Invalid paise amount: ${paise}`);
}

/** Parses a rupee amount ("1234.5" or 1234.5) into integer paise without float multiplication. */
export function rupeesToPaise(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new RangeError(`Invalid rupee amount: ${value}`);
  }
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(String(value).trim());
  if (!match) throw new RangeError(`Invalid rupee amount: ${value}`);
  const [, sign, whole, fraction = ''] = match;
  const paise = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(paise)) throw new RangeError(`Rupee amount out of range: ${value}`);
  return sign && paise !== 0 ? -paise : paise;
}

/**
 * a × b ÷ c rounded half away from zero, exact (BigInt, no floats).
 * a and b are integers (either sign); c must be a positive integer.
 */
export function mulDivRound(a, b, c) {
  for (const n of [a, b, c]) {
    if (!Number.isSafeInteger(n)) throw new RangeError(`Invalid integer: ${n}`);
  }
  if (c <= 0) throw new RangeError(`Divisor must be positive: ${c}`);
  const product = BigInt(a) * BigInt(b);
  const abs = product < 0n ? -product : product;
  const divisor = BigInt(c);
  const q = (2n * abs + divisor) / (2n * divisor);
  const result = Number(product < 0n ? -q : q);
  if (!Number.isSafeInteger(result)) throw new RangeError('Result out of range');
  return result === 0 ? 0 : result;
}

/** Formats paise as ₹ with Indian digit grouping: 12345678 → "₹1,23,456.78". */
export function formatINR(paise) {
  assertPaise(paise);
  const abs = Math.abs(paise);
  const rupees = String(Math.floor(abs / 100));
  const fraction = String(abs % 100).padStart(2, '0');
  const lastThree = rupees.slice(-3);
  const rest = rupees.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+$)/g, ',')},${lastThree}` : lastThree;
  return `${paise < 0 ? '-' : ''}₹${grouped}.${fraction}`;
}

/** Rounds to the nearest rupee (50 paise rounds up). roundOff = total - paise. */
export function roundToRupee(paise) {
  assertPaise(paise);
  const total = Math.floor((paise + 50) / 100) * 100;
  return { total, roundOff: total - paise };
}

/**
 * Splits totalPaise across weights by the largest-remainder method.
 * The parts always sum to totalPaise; ties go to the earlier index.
 */
export function allocateProRata(totalPaise, weights) {
  assertPaise(totalPaise);
  if (!Array.isArray(weights) || weights.length === 0) {
    throw new RangeError('Weights must be a non-empty array');
  }
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) {
    throw new RangeError('Weights must be non-negative integers');
  }
  const sum = weights.reduce((a, w) => a + BigInt(w), 0n);
  if (sum === 0n) throw new RangeError('At least one weight must be greater than 0');

  const sign = totalPaise < 0 ? -1 : 1;
  const total = BigInt(Math.abs(totalPaise));
  const parts = weights.map((w) => (total * BigInt(w)) / sum);
  const remainders = weights.map((w, i) => ({ i, r: (total * BigInt(w)) % sum }));
  const leftover = Number(total - parts.reduce((a, p) => a + p, 0n));

  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (let k = 0; k < leftover; k++) parts[remainders[k].i] += 1n;

  return parts.map((p) => sign * Number(p));
}

const ONES = [
  'Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n) {
  if (n < 20) return ONES[n];
  return n % 10 ? `${TENS[Math.floor(n / 10)]} ${ONES[n % 10]}` : TENS[Math.floor(n / 10)];
}

// Words for a positive integer in the Indian system (Thousand, Lakh, Crore).
function integerInWords(n) {
  const words = [];
  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const hundred = Math.floor((n % 1000) / 100);
  const rest = n % 100;
  if (crore) words.push(`${integerInWords(crore)} Crore`);
  if (lakh) words.push(`${belowHundred(lakh)} Lakh`);
  if (thousand) words.push(`${belowHundred(thousand)} Thousand`);
  if (hundred) words.push(`${ONES[hundred]} Hundred`);
  if (rest) words.push(belowHundred(rest));
  return words.join(' ');
}

/** 12345650 → "Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Fifty Paise Only". */
export function amountInWords(paise) {
  assertPaise(paise);
  if (paise < 0) throw new RangeError('Amount in words requires a non-negative amount');
  const rupees = Math.floor(paise / 100);
  const fraction = paise % 100;
  const rupeeWords = rupees ? integerInWords(rupees) : 'Zero';
  const paiseWords = fraction ? ` and ${belowHundred(fraction)} Paise` : '';
  return `Rupees ${rupeeWords}${paiseWords} Only`;
}

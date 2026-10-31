// Business dates are computed in Asia/Kolkata (fixed +05:30, no DST) by arithmetic,
// never with the host timezone: only getUTC* / Date.UTC are used here.

export const IST_OFFSET_MINUTES = 330;
const OFFSET_MS = IST_OFFSET_MINUTES * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const pad = (n, width = 2) => String(n).padStart(width, '0');

function assertDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid date: ${date}`);
  }
}

// A Date whose UTC fields read as the IST wall clock.
function shifted(date) {
  assertDate(date);
  return new Date(date.getTime() + OFFSET_MS);
}

// Parses 'YYYY-MM-DD' into UTC midnight of that calendar day, rejecting impossible dates.
function parseYmd(ymd) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) throw new RangeError(`Invalid date string: ${ymd}`);
  const [y, m, d] = match.slice(1).map(Number);
  const utc = Date.UTC(y, m - 1, d);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    throw new RangeError(`Invalid date string: ${ymd}`);
  }
  return utc;
}

function formatYmd(utcMs) {
  const d = new Date(utcMs);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** IST calendar date of an instant: 'YYYY-MM-DD'. */
export function istDate(date) {
  return formatYmd(shifted(date).getTime());
}

/** IST wall-clock time of an instant: 'HH:mm'. */
export function istTime(date) {
  const d = shifted(date);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** IST month of an instant: 'YYYY-MM'. */
export function periodOf(date) {
  return istDate(date).slice(0, 7);
}

/** Indian financial year (1 April – 31 March, IST) containing the instant. */
export function financialYear(date) {
  const d = shifted(date);
  const year = d.getUTCFullYear();
  const startYear = d.getUTCMonth() >= 3 ? year : year - 1;
  const endShort = pad((startYear + 1) % 100);
  return {
    startYear,
    label: `${startYear}-${endShort}`,
    code: `${pad(startYear % 100)}${endShort}`,
  };
}

/** First and last millisecond of an IST calendar day, as UTC instants. */
export function istDayBounds(ymd) {
  const start = parseYmd(ymd) - OFFSET_MS;
  return { start: new Date(start), end: new Date(start + DAY_MS - 1) };
}

/** The instant at which the IST wall clock reads `hhmm` on day `ymd`. */
export function atIstTime(ymd, hhmm) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!match) throw new RangeError(`Invalid time string: ${hhmm}`);
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return new Date(parseYmd(ymd) - OFFSET_MS + minutes * 60 * 1000);
}

/** Calendar arithmetic on 'YYYY-MM-DD' strings. */
export function addDaysYmd(ymd, n) {
  if (!Number.isInteger(n)) throw new RangeError(`Invalid day count: ${n}`);
  return formatYmd(parseYmd(ymd) + n * DAY_MS);
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A business date for people: '2026-10-30' → '30 Oct 2026'. Pure string work, no time zones. */
export function displayDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ''));
  if (!m) return String(ymd ?? '');
  return `${Number(m[3])} ${MONTH_NAMES[Number(m[2]) - 1]} ${m[1]}`;
}

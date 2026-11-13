// Cell safety and the CSV encoder for report files. Pure; the API wraps `toCsv` into a Buffer.

/** Neutralises spreadsheet formulas: text starting with = + - @ tab or CR gets a leading quote. */
export function safeCell(value) {
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(value)) return `'${value}`;
  return value;
}

// Integer paise -> '1234.50' without float arithmetic.
function rupees(paise) {
  if (!Number.isSafeInteger(paise)) throw new RangeError(`Invalid paise amount: ${paise}`);
  const abs = Math.abs(paise);
  return `${paise < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function quote(text) {
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function cell(value, kind) {
  if (value === null || value === undefined || value === '') return '';
  if (kind === 'money') return rupees(value);
  return quote(String(safeCell(value)));
}

/**
 * Encodes rows as CSV: UTF-8 BOM, CRLF line ends, quotes doubled, money columns
 * (`kind: 'money'`, integer paise) written in rupees. Columns are `{ key, label, kind? }` with
 * `kind` one of 'money' | 'date' | 'number' | 'text'.
 */
export function toCsv(columns, rows) {
  const head = columns.map((c) => quote(c.label)).join(',');
  const lines = rows.map((row) => columns.map((c) => cell(row[c.key], c.kind)).join(','));
  return `\uFEFF${[head, ...lines].join('\r\n')}\r\n`;
}

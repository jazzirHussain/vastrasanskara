// Reading an uploaded spreadsheet (Excel .xlsx or CSV) into rows, and writing the templates and
// the "rows to fix" file. Every text cell written goes through `safeCell`.
import ExcelJS from 'exceljs';
import {
  IMPORT_MAX_COLUMNS,
  IMPORT_MAX_ROWS,
  columnChoices,
  getImportKind,
  isBlankCell,
  parseCsv,
} from '@vs/shared';
import { safeCell } from '@vs/shared/reports/csv.js';

/** A problem with the file as a whole, in plain words. */
export class ImportFileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImportFileError';
    this.code = code;
  }
}

const UNREADABLE = 'This file could not be read. Save it as Excel Workbook (.xlsx) or CSV and upload again.';
const OLD_EXCEL = 'This is an old Excel file (.xls). Save it as Excel Workbook (.xlsx) or CSV and upload again.';
const unreadable = (message = UNREADABLE) => new ImportFileError('IMPORT_FILE_UNREADABLE', message);

const isZip = (buf) => buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
const isOle = (buf) => buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));

// An exceljs cell value as a plain value: formulas give their result, rich text and links their text.
function plainValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date || typeof value !== 'object') return value;
  if ('error' in value) return '';
  if ('result' in value || 'formula' in value || 'sharedFormula' in value) return plainValue(value.result ?? null);
  if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join('');
  if ('text' in value) return plainValue(value.text);
  return String(value);
}

async function xlsxRows(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw unreadable();
  }
  const sheet = wb.worksheets.find((ws) => ws.actualRowCount > 0);
  if (!sheet) return [];
  const rows = [];
  sheet.eachRow({ includeEmpty: true }, (row, rowNo) => {
    if (rowNo > IMPORT_MAX_ROWS + 1 + 1000) return; // far past the limit: stop collecting
    const values = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      if (col <= IMPORT_MAX_COLUMNS) values[col - 1] = plainValue(cell.value);
    });
    rows[rowNo - 1] = Array.from(values, (v) => v ?? null);
  });
  return Array.from(rows, (r) => r ?? []);
}

function csvRows(buffer) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw unreadable('This file is not saved as UTF-8 text. In Excel, choose "CSV UTF-8" or Excel Workbook (.xlsx) and upload again.');
  }
  if (text.includes('\u0000')) throw unreadable();
  try {
    return parseCsv(text);
  } catch {
    throw unreadable('A quote mark in this file is never closed. Check the file and upload again.');
  }
}

/**
 * The file's header row and data rows: `{ headers, rows: [{ rowNo, cells }] }`, where `rowNo`
 * is the spreadsheet row number (the header is row 1). Blank rows are left out.
 */
export async function readImportFile(buffer) {
  if (isOle(buffer)) throw unreadable(OLD_EXCEL);
  const all = isZip(buffer) ? await xlsxRows(buffer) : csvRows(buffer);
  const headerIndex = all.findIndex((r) => r.some((c) => !isBlankCell(c)));
  if (headerIndex === -1) throw new ImportFileError('IMPORT_FILE_EMPTY', 'The file is empty.');
  const headers = all[headerIndex].slice(0, IMPORT_MAX_COLUMNS).map((h) => (isBlankCell(h) ? '' : String(h).trim()));
  const rows = [];
  for (let i = headerIndex + 1; i < all.length; i += 1) {
    const cells = (all[i] ?? []).slice(0, IMPORT_MAX_COLUMNS);
    if (cells.every((c) => isBlankCell(c))) continue;
    rows.push({ rowNo: i + 1, cells });
    if (rows.length > IMPORT_MAX_ROWS) {
      throw new ImportFileError('IMPORT_TOO_MANY_ROWS', 'This file has more than 5,000 rows. Split it into smaller files.');
    }
  }
  if (!rows.length) throw new ImportFileError('IMPORT_FILE_EMPTY', 'The file has no rows under the headings.');
  return { headers, rows };
}

const headerText = (column) => (column.required ? `${column.header} *` : column.header);
const quoted = (list) => `"${list.join(',').replace(/"/g, '')}"`;

async function toBuffer(wb) {
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * The Excel template of a kind: "Fill this in" (bold frozen headers, drop-downs for choices, text
 * format where leading zeros matter) and "How to fill" (one line per column). No example rows.
 */
export async function templateXlsx(kind, ctx = {}) {
  const def = getImportKind(kind);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Vastrasanskara';
  const ws = wb.addWorksheet('Fill this in', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = def.columns.map((c) => ({ header: headerText(c), key: c.key, width: Math.min(Math.max(c.header.length + 4, 14), 36) }));
  ws.getRow(1).font = { bold: true };
  def.columns.forEach((column, i) => {
    const letter = ws.getColumn(i + 1).letter;
    if (column.textFormat) ws.getColumn(i + 1).numFmt = '@';
    const choices = columnChoices(column, ctx);
    // A list longer than Excel's 255-character limit is left to the "How to fill" sheet.
    if (choices?.length && column.key !== 'garmentTypes') {
      const formula = quoted(choices.map((c) => c.label));
      if (formula.length <= 255) {
        ws.dataValidations.add(`${letter}2:${letter}${IMPORT_MAX_ROWS + 1}`, {
          type: 'list',
          allowBlank: !column.required,
          formulae: [formula],
          showErrorMessage: true,
          errorTitle: column.header,
          error: `Choose one of: ${choices.map((c) => c.label).join(', ')}`,
        });
      }
    }
  });

  const help = wb.addWorksheet('How to fill');
  help.columns = [
    { header: 'Column', key: 'column', width: 28 },
    { header: 'Required', key: 'required', width: 10 },
    { header: 'What to write', key: 'help', width: 70 },
    { header: 'Example', key: 'example', width: 24 },
    { header: 'Allowed values', key: 'allowed', width: 50 },
  ];
  help.getRow(1).font = { bold: true };
  help.addRow({ column: def.label, help: def.help });
  for (const column of def.columns) {
    const choices = columnChoices(column, ctx);
    help.addRow({
      column: column.header,
      required: column.required ? 'Yes' : '',
      help: safeCell(column.help),
      example: safeCell(String(column.example ?? '')),
      allowed: choices ? safeCell(choices.map((c) => c.label).join(', ')) : '',
    });
  }
  return toBuffer(wb);
}

/** The CSV template: the header row only. */
export function templateCsv(kind) {
  const headers = getImportKind(kind).columns.map((c) => (/[",]/.test(c.header) ? `"${c.header.replace(/"/g, '""')}"` : c.header));
  return Buffer.from(`\uFEFF${headers.join(',')}\r\n`, 'utf8');
}

/**
 * "Rows to fix": the file's own headers and values for each row that needs fixing, plus
 * "What to fix". Formula-like text is neutralised so the file is safe to open.
 */
export async function problemsXlsx(headers, rows) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Vastrasanskara';
  const ws = wb.addWorksheet('Rows to fix', { views: [{ state: 'frozen', ySplit: 1 }] });
  const head = [...headers.map((h) => safeCell(h)), 'What to fix', 'Row in your file'];
  ws.addRow(head).font = { bold: true };
  for (const row of rows) {
    const cells = headers.map((_, i) => {
      const v = row.cells[i] ?? null;
      return typeof v === 'string' ? safeCell(v) : v;
    });
    const fix = row.errors.map((e) => (e.column ? `${e.column}: ${e.message}` : e.message)).join(' ');
    ws.addRow([...cells, safeCell(fix), row.rowNo]);
  }
  ws.columns.forEach((c) => {
    c.width = 18;
  });
  return toBuffer(wb);
}

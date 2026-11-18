// Report file writers: Excel (exceljs streaming writer) and CSV (the shared encoder).
// A sheet is { name, columns: [{ key, label, kind }], rows: [object] }; money is integer paise.
import { PassThrough } from 'node:stream';
import ExcelJS from 'exceljs';
import { safeCell, toCsv } from '@vs/shared/reports/csv.js';
import { renderPdf } from '../../core/pdf/render.js';

export const REPORT_MAX_ROWS = 200_000;
export const MONEY_FORMAT = '#,##0.00';
export const CONTENT_TYPES = Object.freeze({
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
  pdf: 'application/pdf',
});

/** A report failure with a plain code and message staff can read. */
export class ReportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReportError';
    this.code = code;
  }
}

/** Refuses a report with more than `maxRows` rows in all (REPORT_TOO_LARGE). */
export function checkRowLimit(rowCount, maxRows = REPORT_MAX_ROWS) {
  if (rowCount > maxRows) throw new ReportError('REPORT_TOO_LARGE', 'Choose a shorter period');
}

function cellValue(value, kind) {
  if (value === null || value === undefined) return null;
  if (kind === 'money') return value / 100;
  if (typeof value === 'string') return safeCell(value);
  return value;
}

/** An .xlsx workbook: bold frozen header row, money as rupees with a number format, formula-like text neutralised. */
export async function toXlsx(sheets, { created = new Date() } = {}) {
  const stream = new PassThrough();
  const chunks = [];
  stream.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useStyles: true, useSharedStrings: false });
  wb.created = created;
  wb.creator = 'Vastrasanskara';
  for (const sheet of sheets) {
    const ws = wb.addWorksheet(String(sheet.name).slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = sheet.columns.map((c) => ({ header: c.label, key: c.key, width: Math.min(Math.max(c.label.length + 2, 12), 40) }));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).commit();
    for (const row of sheet.rows) {
      const r = ws.addRow(sheet.columns.map((c) => cellValue(row[c.key], c.kind)));
      sheet.columns.forEach((c, i) => {
        if (c.kind === 'money') r.getCell(i + 1).numFmt = MONEY_FORMAT;
      });
      r.commit();
    }
    ws.commit();
  }
  await wb.commit();
  await done;
  return Buffer.concat(chunks);
}

/** A one-sheet report as a CSV file. */
export function toCsvBuffer(sheet) {
  return Buffer.from(toCsv(sheet.columns, sheet.rows), 'utf8');
}

/** A PDF report (a pdfmake document definition) as a Buffer. */
export function toPdf(docDefinition) {
  return renderPdf(docDefinition);
}

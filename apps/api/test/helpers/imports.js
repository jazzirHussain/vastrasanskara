import { expect } from 'vitest';
import ExcelJS from 'exceljs';
import { fetchLike, loginAs } from './app.js';

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
let keys = 0;

/** An .xlsx file whose first sheet holds `rows` (the first row is the header). Cell objects pass through. */
export async function xlsx(rows, { sheetName = 'Sheet1', before = [] } = {}) {
  const wb = new ExcelJS.Workbook();
  for (const name of before) wb.addWorksheet(name);
  const ws = wb.addWorksheet(sheetName);
  for (const row of rows) ws.addRow(row);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** A CSV file of `rows` (strings are quoted when needed). */
export function csv(rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return Buffer.from(rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n', 'utf8');
}

export async function readXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb.worksheets.map((ws) => {
    const rows = [];
    ws.eachRow((row) => rows.push(row.values.slice(1)));
    return { name: ws.name, rows, worksheet: ws };
  });
}

/**
 * Import test helpers for `app`: `world()` logs in an admin, operations and a designer;
 * `upload(who, buffer, type)` stores a file as `import_file` and answers its key;
 * `start(who, kind, key, opts)` asks for a check; `waitFor(who, id, statuses)` polls the run;
 * `confirm(who, run)` confirms at the run's version.
 */
export function importHelpers(app) {
  async function world() {
    const admin = await loginAs(app, { roles: ['admin'], name: 'Owner' });
    const operations = await loginAs(app, { roles: ['operations'], name: 'Front desk' });
    const designer = await loginAs(app, { roles: ['designer'], name: 'Meera' });
    return { admin, operations, designer, branchId: String(admin.user.branchId) };
  }

  async function upload(who, buffer, type = XLSX_TYPE) {
    const r = await who.agent.post('/v1/files/upload-url').send({ purpose: 'import_file', contentType: type, size: buffer.length });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const put = await fetchLike(app, 'PUT', r.body.url, buffer, r.body.headers);
    expect(put.status).toBe(200);
    return r.body.key;
  }

  function start(who, kind, fileKey, { fileName = 'old records.xlsx', asOf } = {}) {
    return who.agent
      .post('/v1/imports')
      .set('Idempotency-Key', `imp${++keys}`)
      .send({ kind, fileKey, fileName, ...(asOf && { asOf }) });
  }

  async function waitFor(who, id, statuses = ['checked', 'done', 'failed'], { tries = 200 } = {}) {
    for (let i = 0; i < tries; i += 1) {
      const r = await who.agent.get(`/v1/imports/${id}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      if (statuses.includes(r.body.import.status)) return r.body.import;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`import ${id} never reached ${statuses.join('/')}`);
  }

  /** Uploads `buffer`, starts a check of `kind` and waits for it. */
  async function check(who, kind, buffer, opts = {}) {
    const key = await upload(who, buffer, opts.type);
    const r = await start(who, kind, key, opts);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    return waitFor(who, r.body.import.id);
  }

  const confirm = (who, run) => who.agent.post(`/v1/imports/${run.id}/confirm`).send({ version: run.version });

  /** Confirms and waits for the run to finish. */
  async function add(who, run) {
    const r = await confirm(who, run);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return waitFor(who, run.id, ['done', 'failed']);
  }

  async function rows(who, id, status) {
    const r = await who.agent.get(`/v1/imports/${id}/rows`).query(status ? { status } : {});
    expect(r.status).toBe(200);
    return r.body.items;
  }

  return { world, upload, start, waitFor, check, confirm, add, rows };
}

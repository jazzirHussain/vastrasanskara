import { expect } from 'vitest';
import ExcelJS from 'exceljs';
import { fetchLike } from './app.js';

let keys = 0;

/**
 * Report test helpers for `app`. `request(who, body, key)` posts a report request with an
 * Idempotency-Key; `waitFor(who, id)` polls the run until it is done or failed; `download(who, id)`
 * follows the download link and answers { res, body (Buffer), filename }; `readXlsx(buffer)` answers
 * each sheet as { name, rows: [[cell values]] }.
 */
export function reportHelpers(app) {
  const request = (who, body, key = `rep${++keys}`) => who.agent.post('/v1/reports').set('Idempotency-Key', key).send(body);

  async function waitFor(who, id, { tries = 100 } = {}) {
    for (let i = 0; i < tries; i += 1) {
      const r = await who.agent.get(`/v1/reports/${id}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      if (r.body.report.status === 'done' || r.body.report.status === 'failed') return r.body.report;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`report ${id} never finished`);
  }

  async function download(who, id) {
    const link = await who.agent.get(`/v1/reports/${id}/download`);
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    const res = await fetchLike(app, 'GET', link.body.url);
    expect(res.status).toBe(200);
    return { res, body: res.body, filename: link.body.filename };
  }

  async function readXlsx(buffer) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    return wb.worksheets.map((ws) => {
      const rows = [];
      ws.eachRow((row) => rows.push(row.values.slice(1)));
      return { name: ws.name, rows, worksheet: ws };
    });
  }

  return { request, waitFor, download, readXlsx };
}

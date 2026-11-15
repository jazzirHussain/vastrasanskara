import { test, expect, vi, afterEach } from 'vitest';
import { REGISTER_COLUMNS, addDaysYmd } from '@vs/shared';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { billingHelpers } from './helpers/billing.js';
import { reportHelpers } from './helpers/reports.js';
import { today } from './helpers/production.js';
import { clock } from '../src/clock.js';
import { AuditLog } from '../src/core/audit/model.js';
import { verifyAuditChain } from '../src/core/audit/service.js';
import { ReportRun } from '../src/modules/reports/model.js';
import { buildRun, claimRun } from '../src/modules/reports/runner.js';
import { runPendingReports } from '../src/modules/reports/service.js';
import { reportsRouter } from '../src/modules/reports/routes.js';
import { Customer } from '../src/modules/customers/model.js';

useTestDb();
const app = buildTestApp();
const storage = app.locals.storage;
const billing = billingHelpers(app);
const { request, waitFor, download, readXlsx } = reportHelpers(app);

afterEach(() => vi.restoreAllMocks());

const ok = (r, status = 201) => expect(r.status, JSON.stringify(r.body)).toBe(status);
const TODAY = today();
const MONTH_START = `${TODAY.slice(0, 7)}-01`;
const salesBody = (format = 'xlsx', params = { from: MONTH_START, to: TODAY }) => ({ kind: 'sales_register', format, params });

/** Two bills issued today. */
async function setup() {
  const w = await billing.world();
  const bills = [];
  for (const price of [100000, 250000]) {
    const r = await billing.issue(w.ops, await billing.draftFor(await w.takeOrder({ prices: [price] })));
    ok(r);
    bills.push(r.body.invoice);
  }
  return { ...w, bills, branchId: String(w.admin.user.branchId) };
}

test('a month\'s sales register is ready in a moment as Excel and as CSV', async () => {
  const { admin, bills } = await setup();
  const r = await request(admin, salesBody('xlsx'));
  ok(r, 202);
  expect(r.body.report).toMatchObject({ kind: 'sales_register', label: 'Sales register', format: 'xlsx', status: expect.any(String) });
  const done = await waitFor(admin, r.body.report.id);
  expect(done).toMatchObject({ status: 'done', rows: 2, filename: `Sales register ${MONTH_START} to ${TODAY}.xlsx`, error: null });

  const { body } = await download(admin, done.id);
  const [sheet] = await readXlsx(body);
  expect(sheet.rows[0]).toEqual(REGISTER_COLUMNS.sales.map((c) => c.label));
  const sorted = [...bills].sort((a, b) => a.number.localeCompare(b.number, 'en', { numeric: true }));
  expect(sheet.rows.slice(1).map((row) => row[0])).toEqual(sorted.map((b) => b.number));
  const totalCol = REGISTER_COLUMNS.sales.findIndex((c) => c.key === 'total');
  expect(sheet.rows.slice(1).map((row) => row[totalCol])).toEqual(sorted.map((b) => b.totals.total / 100));
  expect(sheet.worksheet.getRow(1).font?.bold).toBe(true);
  expect(sheet.worksheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
  expect(sheet.worksheet.getCell(2, totalCol + 1).numFmt).toBe('#,##0.00');

  const csv = await request(admin, salesBody('csv'));
  ok(csv, 202);
  const csvDone = await waitFor(admin, csv.body.report.id);
  const text = (await download(admin, csvDone.id)).body.toString('utf8');
  expect(text.charCodeAt(0)).toBe(0xfeff);
  const lines = text.slice(1).trim().split('\r\n');
  expect(lines[0]).toBe(REGISTER_COLUMNS.sales.map((c) => c.label).join(','));
  expect(lines).toHaveLength(3);
  expect(lines[1].split(',')[0]).toBe(sorted[0].number);
});

test('a year\'s report waits for the worker', async () => {
  const { admin } = await setup();
  const r = await request(admin, salesBody('xlsx', { from: addDaysYmd(TODAY, -200), to: TODAY }));
  ok(r, 202);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect((await ReportRun.findById(r.body.report.id).lean()).status).toBe('queued');
  await runPendingReports({ storage });
  expect(await waitFor(admin, r.body.report.id)).toMatchObject({ status: 'done', rows: 2 });
});

test('asking twice with one key makes one file', async () => {
  const { admin } = await setup();
  const a = await request(admin, salesBody(), 'same-key');
  const b = await request(admin, salesBody(), 'same-key');
  ok(a, 202);
  expect(b.status).toBe(202);
  expect(b.body.report.id).toBe(a.body.report.id);
  await waitFor(admin, a.body.report.id);
  expect(await ReportRun.countDocuments()).toBe(1);
});

test('the API and the worker never build the same report twice', async () => {
  const { admin, branchId } = await setup();
  const run = await ReportRun.create({
    branchId, kind: 'sales_register', format: 'xlsx', params: { from: MONTH_START, to: TODAY }, status: 'queued', source: 'manual', requestedBy: admin.user._id,
  });
  const [first, second] = await Promise.all([claimRun({ id: run._id }), claimRun({ id: run._id })]);
  expect([first, second].filter(Boolean)).toHaveLength(1);
  expect((await ReportRun.findById(run._id).lean())).toMatchObject({ status: 'running', attempts: 1 });
});

test('a stuck report is retried, then marked failed', async () => {
  const { admin, branchId } = await setup();
  const longAgo = new Date(clock.now().getTime() - 31 * 60_000);
  const base = { branchId, kind: 'sales_register', format: 'xlsx', params: { from: MONTH_START, to: TODAY }, source: 'manual', requestedBy: admin.user._id };
  const once = await ReportRun.create({ ...base, status: 'running', attempts: 1, claimedAt: longAgo });
  const twice = await ReportRun.create({ ...base, status: 'running', attempts: 2, claimedAt: longAgo });
  const fresh = await ReportRun.create({ ...base, status: 'running', attempts: 1, claimedAt: new Date() });
  await runPendingReports({ storage });
  expect(await ReportRun.findById(once._id).lean()).toMatchObject({ status: 'done', attempts: 2 });
  expect(await ReportRun.findById(twice._id).lean()).toMatchObject({ status: 'failed', error: { code: 'STUCK' } });
  expect((await ReportRun.findById(fresh._id).lean()).status).toBe('running');
});

test('a report over the row limit fails with a plain message', async () => {
  const { admin, branchId } = await setup();
  const run = await ReportRun.create({
    branchId, kind: 'sales_register', format: 'xlsx', params: { from: MONTH_START, to: TODAY }, status: 'queued', source: 'manual', requestedBy: admin.user._id,
  });
  await buildRun(await claimRun({ id: run._id }), { storage, maxRows: 1 });
  const failed = await ReportRun.findById(run._id).lean();
  expect(failed).toMatchObject({ status: 'failed', file: null, error: { code: 'REPORT_TOO_LARGE', message: 'Choose a shorter period' } });
  const shown = (await admin.agent.get(`/v1/reports/${run._id}`)).body.report;
  expect(shown.error).toEqual({ code: 'REPORT_TOO_LARGE', message: 'Choose a shorter period' });
  expect((await admin.agent.get(`/v1/reports/${run._id}/download`)).body.error.code).toBe('REPORT_NOT_READY');
});

const ROUTES = [
  ['GET', '/v1/reports/catalog'],
  ['POST', '/v1/reports'],
  ['GET', '/v1/reports'],
  ['GET', '/v1/reports/:id'],
  ['GET', '/v1/reports/:id/download'],
];

test('report files are admin only, even by key', async () => {
  const { admin, ops, d1 } = await setup();
  const r = await request(admin, salesBody());
  const done = await waitFor(admin, r.body.report.id);
  const run = await ReportRun.findById(done.id).lean();
  for (const who of [ops, d1]) {
    for (const [method, path] of ROUTES) {
      const url = path.replace(':id', done.id);
      const res = method === 'GET' ? await who.agent.get(url) : await request(who, salesBody());
      expect([res.status, res.body.error?.code], `${method} ${path}`).toEqual([403, 'FORBIDDEN']);
    }
    const byKey = await who.agent.get('/v1/files/url').query({ key: run.file.key });
    expect(byKey.status).toBe(404);
  }
  ok(await admin.agent.get('/v1/files/url').query({ key: run.file.key }), 200);
  expect(run.file.key).toMatch(new RegExp(`^${run.branchId}/reports/\\d{4}/[0-9a-f-]{36}\\.xlsx$`));
});

test('each download link is audited', async () => {
  const { admin, branchId } = await setup();
  const r = await request(admin, salesBody());
  const done = await waitFor(admin, r.body.report.id);
  await download(admin, done.id);
  await download(admin, done.id);
  const entries = await AuditLog.find({ entityType: 'report', entityId: done.id }).sort({ seq: 1 }).lean();
  expect(entries.map((e) => e.action)).toEqual(['request', 'download', 'download']);
  expect(String(entries[1].userId ?? entries[1].actor?.userId)).toBe(String(admin.user._id));
  expect(await verifyAuditChain(branchId)).toMatchObject({ ok: true });
});

test('cells that look like formulas are neutralised in the file', async () => {
  const { admin, ops, customerId, takeOrder } = await setup();
  await Customer.updateOne({ _id: customerId }, { name: '=HYPERLINK("http://x.test","Click")' });
  ok(await billing.issue(ops, await billing.draftFor(await takeOrder({ prices: [90000] }))));
  const r = await request(admin, salesBody());
  const done = await waitFor(admin, r.body.report.id);
  const [sheet] = await readXlsx((await download(admin, done.id)).body);
  const customerCol = REGISTER_COLUMNS.sales.findIndex((c) => c.key === 'customer');
  const names = sheet.rows.slice(1).map((row) => row[customerCol]);
  expect(names).toContain('\'=HYPERLINK("http://x.test","Click")');
  expect(names.every((n) => typeof n === 'string')).toBe(true);
});

test('the file downloads under its friendly name', async () => {
  const { admin } = await setup();
  const r = await request(admin, salesBody());
  const done = await waitFor(admin, r.body.report.id);
  const { res, filename } = await download(admin, done.id);
  expect(filename).toBe(`Sales register ${MONTH_START} to ${TODAY}.xlsx`);
  expect(res.headers['content-disposition']).toBe(`attachment; filename="${filename}"`);
  expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});

test('the reports route table matches the router', async () => {
  const declared = reportsRouter({})
    .stack.filter((layer) => layer.route)
    .flatMap((layer) => Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} /v1/reports${layer.route.path === '/' ? '' : layer.route.path}`))
    .sort();
  expect(declared).toEqual(ROUTES.map(([m, p]) => `${m} ${p}`).sort());
  const { admin } = await setup();
  const catalog = await admin.agent.get('/v1/reports/catalog');
  ok(catalog, 200);
  expect(catalog.body.reports.map((x) => x.kind)).toContain('sales_register');
  const list = await admin.agent.get('/v1/reports');
  ok(list, 200);
  expect(list.body).toEqual({ items: [], nextCursor: null });
});

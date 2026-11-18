import { test, expect, vi, afterEach } from 'vitest';
import { useTestDb } from './helpers/db.js';
import { buildTestApp } from './helpers/app.js';
import { captureLogger } from './helpers/logs.js';
import { csv, importHelpers, readXlsx, xlsx } from './helpers/imports.js';
import { clock } from '../src/clock.js';
import * as loggerModule from '../src/logger.js';
import { AuditLog } from '../src/core/audit/model.js';
import { Worker } from '../src/modules/workers/model.js';
import { ImportRow, ImportRun } from '../src/modules/imports/model.js';
import { runPendingImports } from '../src/modules/imports/service.js';

useTestDb();
const app = buildTestApp();
const { world, upload, start, waitFor, check, confirm, add, rows } = importHelpers(app);
const storage = app.locals.storage;
const HEAD = ['Name', 'Skill', 'Phone'];
const RAVI = ['Ravi Kumar', 'Master tailor', '9876543210'];
const SITA = ['Sita', 'Handwork', '+91 91234 56789'];
const ANIL = ['Anil', 'Cutting', ''];

afterEach(() => vi.restoreAllMocks());

test('a filled template is checked and previewed without adding anything', async () => {
  const { admin } = await world();
  const run = await check(admin, 'workers', await xlsx([HEAD, RAVI, SITA, ANIL]));
  expect(run).toMatchObject({ kind: 'workers', label: 'Workers', status: 'checked', rowCount: 3, fileError: null });
  expect(run.counts).toMatchObject({ ready: 3, exists: 0, error: 0, added: 0 });
  expect(await Worker.countDocuments()).toBe(0);
  const items = await rows(admin, run.id);
  expect(items.map((r) => [r.rowNo, r.status, r.label])).toEqual([[2, 'ready', 'Ravi Kumar'], [3, 'ready', 'Sita'], [4, 'ready', 'Anil']]);
  expect(items[0]).not.toHaveProperty('data');
});

test('rows that need fixing say which row and column', async () => {
  const { admin } = await world();
  const run = await check(admin, 'workers', await xlsx([HEAD, RAVI, ['', 'Handwork', '98765']]));
  expect(run.counts).toMatchObject({ ready: 1, error: 1 });
  const [bad] = await rows(admin, run.id, 'error');
  expect(bad).toEqual({
    rowNo: 3,
    status: 'error',
    label: '',
    errors: [{ column: 'Name', message: 'Fill this in.' }, { column: 'Phone', message: "'98765' is not a 10-digit mobile number." }],
  });
});

test('confirming adds the ready rows and leaves the rest', async () => {
  const { admin } = await world();
  const run = await check(admin, 'workers', await xlsx([HEAD, RAVI, SITA, ['', 'x', '']]));
  const done = await add(admin, run);
  expect(done.status).toBe('done');
  expect(done.counts).toMatchObject({ ready: 0, added: 2, error: 1 });
  expect(done.progress).toEqual({ done: 2, total: 2 });
  expect((await Worker.find().sort({ name: 1 }).lean()).map((w) => [w.name, w.skill, w.phone])).toEqual([
    ['Ravi Kumar', 'Master tailor', '+919876543210'],
    ['Sita', 'Handwork', '+919123456789'],
  ]);
  expect((await rows(admin, run.id, 'added')).map((r) => r.rowNo)).toEqual([2, 3]);
});

test('uploading the same file twice adds nothing the second time', async () => {
  const { admin } = await world();
  const file = await xlsx([HEAD, RAVI, SITA, ANIL]);
  const first = await check(admin, 'workers', file);
  await add(admin, first);
  const second = await check(admin, 'workers', file);
  expect(second.sameFileAs).toEqual({ id: first.id, at: expect.any(String) });
  expect(second.counts).toMatchObject({ ready: 0, exists: 3 });
  const r = await confirm(admin, second);
  expect(r.status).toBe(422);
  expect(r.body.error).toMatchObject({ code: 'NOTHING_TO_IMPORT', message: 'There are no rows ready to add.' });
  expect(await Worker.countDocuments()).toBe(3);
});

test('a row added by someone else after the check is left as it is', async () => {
  const { admin } = await world();
  const run = await check(admin, 'workers', await xlsx([HEAD, RAVI, SITA]));
  await admin.agent.post('/v1/workers').send({ name: 'ravi  kumar' });
  const done = await add(admin, run);
  expect(done.counts).toMatchObject({ added: 1, skipped: 1 });
  expect(await Worker.countDocuments()).toBe(2);
});

test('duplicate rows inside one file are flagged', async () => {
  const { admin } = await world();
  const run = await check(admin, 'workers', await xlsx([HEAD, RAVI, SITA, ['RAVI   kumar', 'Other', '']]));
  expect(run.counts).toMatchObject({ ready: 2, error: 1 });
  expect((await rows(admin, run.id, 'error'))[0]).toMatchObject({ rowNo: 4, errors: [{ column: null, message: 'Same as row 2.' }] });
});

test('a file missing a required column explains which', async () => {
  const { admin } = await world();
  const run = await check(admin, 'workers', await xlsx([['Skill', 'Remarks'], ['Cutting', 'x']]));
  expect(run.fileError).toEqual({
    code: 'IMPORT_COLUMNS_MISSING',
    message: "The file has no 'Name' column. Download the template and copy your data into it.",
  });
  expect(run.counts.ready).toBe(0);
  expect((await confirm(admin, run)).body.error.code).toBe('NOTHING_TO_IMPORT');
});

test('CSV and Excel files are read the same', async () => {
  const { admin } = await world();
  const fromCsv = await check(admin, 'workers', csv([['name', 'SKILL', 'Mobile', 'Remarks'], RAVI.concat('a'), SITA.concat('b')]), { type: 'text/csv' });
  expect(fromCsv.counts).toMatchObject({ ready: 2 });
  expect(fromCsv.unusedColumns).toEqual(['Remarks']);
  const fromWindows = await check(admin, 'workers', csv([HEAD, ANIL]), { type: 'application/vnd.ms-excel' });
  expect(fromWindows.counts).toMatchObject({ ready: 1 });
  const fromXlsx = await check(admin, 'workers', await xlsx([['name', 'SKILL', 'Mobile', 'Remarks'], RAVI.concat('a'), SITA.concat('b')]));
  expect(fromXlsx.counts).toEqual(fromCsv.counts);
});

test('formulas give their value and blank rows are ignored', async () => {
  const { admin } = await world();
  const file = await xlsx(
    [HEAD, [{ formula: 'CONCATENATE("Ra","vi")', result: 'Ravi' }, 'Cutting', 9876543210], [], [null, null, null], SITA, [], []],
    { before: ['Empty first sheet'] },
  );
  const run = await check(admin, 'workers', file);
  expect(run.counts).toMatchObject({ ready: 2, error: 0 });
  expect((await rows(admin, run.id)).map((r) => [r.rowNo, r.label])).toEqual([[2, 'Ravi'], [5, 'Sita']]);
});

test('too many rows or an old .xls file is refused in plain words', async () => {
  const { admin } = await world();
  const many = await check(admin, 'workers', csv([HEAD, ...Array.from({ length: 5001 }, (_, i) => [`Worker ${i}`, '', ''])]), { type: 'text/csv' });
  expect(many.fileError).toEqual({ code: 'IMPORT_TOO_MANY_ROWS', message: 'This file has more than 5,000 rows. Split it into smaller files.' });
  expect(many.counts.ready).toBe(0);

  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)]);
  const old = await check(admin, 'workers', ole, { type: 'application/vnd.ms-excel' });
  expect(old.fileError.code).toBe('IMPORT_FILE_UNREADABLE');
  expect(old.fileError.message).toMatch(/Save it as Excel Workbook \(\.xlsx\) or CSV/);
  const empty = await check(admin, 'workers', csv([HEAD]), { type: 'text/csv' });
  expect(empty.fileError).toEqual({ code: 'IMPORT_FILE_EMPTY', message: 'The file has no rows under the headings.' });
});

test('a large file waits for the worker', async () => {
  const { admin } = await world();
  const file = csv([HEAD, ...Array.from({ length: 201 }, (_, i) => [`Worker ${i}`, '', ''])]);
  const key = await upload(admin, file, 'text/csv');
  const r = await start(admin, 'workers', key);
  expect(r.status).toBe(202);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect((await admin.agent.get(`/v1/imports/${r.body.import.id}`)).body.import.status).toBe('checking');
  await runPendingImports({ storage });
  const checked = await waitFor(admin, r.body.import.id);
  expect(checked.counts.ready).toBe(201);
  const c = await confirm(admin, checked);
  expect(c.body.import.status).toBe('importing');
  await runPendingImports({ storage });
  const done = await waitFor(admin, checked.id, ['done']);
  expect(done.counts.added).toBe(201);
  expect(await Worker.countDocuments()).toBe(201);
});

test('one import at a time per branch', async () => {
  const { admin } = await world();
  const key = await upload(admin, csv([HEAD, ...Array.from({ length: 201 }, (_, i) => [`Worker ${i}`, '', ''])]), 'text/csv');
  const started = await start(admin, 'workers', key);
  await runPendingImports({ storage });
  const first = await waitFor(admin, started.body.import.id);
  // 201 rows: adding waits for the worker, so the run stays importing.
  expect((await confirm(admin, first)).body.import.status).toBe('importing');
  const second = await check(admin, 'workers', await xlsx([HEAD, ['Someone else', '', '']]));
  const r = await confirm(admin, second);
  expect(r.status).toBe(409);
  expect(r.body.error).toMatchObject({ code: 'IMPORT_BUSY', message: 'Another import is running. Wait for it to finish.' });
});

test('an unconfirmed check expires after a week', async () => {
  const { admin } = await world();
  const run = await check(admin, 'workers', await xlsx([HEAD, RAVI]));
  // Checked eight days ago.
  await ImportRun.collection.updateOne({ _id: new ImportRun.base.Types.ObjectId(run.id) }, { $set: { createdAt: new Date(Date.now() - 8 * 86_400_000) } });
  expect((await confirm(admin, run)).body.error.code).toBe('IMPORT_EXPIRED');
  await runPendingImports({ storage, now: clock.now() });
  expect((await admin.agent.get(`/v1/imports/${run.id}`)).body.import.status).toBe('expired');
  expect(await Worker.countDocuments()).toBe(0);
});

test('a checked file can be left without adding anything', async () => {
  const { admin } = await world();
  const run = await check(admin, 'workers', await xlsx([HEAD, RAVI]));
  const r = await admin.agent.post(`/v1/imports/${run.id}/cancel`).send({ version: run.version });
  expect(r.status).toBe(200);
  expect(r.body.import.status).toBe('cancelled');
  expect((await confirm(admin, { ...run, version: r.body.import.version })).status).toBe(422);
});

test('templates download as Excel and CSV with every column', async () => {
  const { admin } = await world();
  const x = await admin.agent.get('/v1/imports/templates/workers').buffer(true).parse((res, done) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  });
  expect(x.status).toBe(200);
  expect(x.headers['content-disposition']).toBe('attachment; filename="Workers template.xlsx"');
  const sheets = await readXlsx(x.body);
  expect(sheets.map((s) => s.name)).toEqual(['Fill this in', 'How to fill']);
  expect(sheets[0].rows).toEqual([['Name *', 'Skill', 'Phone']]);
  expect(sheets[1].rows.map((r) => r[0])).toEqual(['Column', 'Workers', 'Name *'.replace(' *', ''), 'Skill', 'Phone']);
  const c = await admin.agent.get('/v1/imports/templates/customers?format=csv');
  expect(c.status).toBe(200);
  expect(c.text.replace('﻿', '').trim().split(',')[0]).toBe('Name');
  expect(c.text).toContain('How consent was given');
  expect((await admin.agent.get('/v1/imports/templates/nope')).status).toBe(404);
  const kinds = await admin.agent.get('/v1/imports/kinds');
  expect(kinds.body.kinds.map((k) => k.kind)).toEqual(['customers', 'vendors', 'workers', 'catalog', 'stock', 'orders', 'opening_balances']);
  expect(kinds.body.kinds[0].columns[0]).toEqual({ key: 'name', header: 'Name', required: true, example: 'Asha Rao', help: expect.any(String), choices: null });
});

test('rows to fix are safe to open in Excel', async () => {
  const { admin } = await world();
  const run = await check(admin, 'workers', await xlsx([HEAD, ['=HYPERLINK("x")', 'Cutting', '12345'], RAVI]));
  const r = await admin.agent.get(`/v1/imports/${run.id}/problems`).buffer(true).parse((res, done) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  });
  expect(r.status).toBe(200);
  expect(r.headers['content-disposition']).toBe('attachment; filename="Workers rows to fix.xlsx"');
  const [sheet] = await readXlsx(r.body);
  expect(sheet.rows[0]).toEqual(['Name', 'Skill', 'Phone', 'What to fix', 'Row in your file']);
  expect(sheet.rows).toHaveLength(2);
  expect(sheet.rows[1][0]).toBe('\'=HYPERLINK("x")');
  expect(sheet.rows[1][3]).toBe("Phone: '12345' is not a 10-digit mobile number.");
  expect(sheet.rows[1][4]).toBe(2);
});

test('an import logs nothing from the file', async () => {
  const { logger, lines } = captureLogger('debug');
  for (const level of ['info', 'warn', 'error', 'debug']) vi.spyOn(loggerModule.logger, level).mockImplementation((...args) => logger[level](...args));
  const { admin } = await world();
  const run = await check(admin, 'workers', await xlsx([HEAD, ['Secret Person', 'Cutting', '9876501234'], ['', '', '99999']]), { fileName: 'private-staff-list.xlsx' });
  await add(admin, run);
  const text = JSON.stringify(lines);
  expect(lines.some((l) => l.runId === run.id)).toBe(true);
  for (const secret of ['Secret Person', '9876501234', '99999', 'private-staff-list']) expect(text).not.toContain(secret);
});

test('only admins can upload, see or download import files', async () => {
  const { admin, operations, designer } = await world();
  const run = await check(admin, 'workers', await xlsx([HEAD, RAVI]));
  const stored = await ImportRun.findById(run.id).lean();
  for (const who of [operations, designer]) {
    const up = await who.agent.post('/v1/files/upload-url').send({ purpose: 'import_file', contentType: 'text/csv', size: 10 });
    expect(up.status).toBe(403);
    for (const path of ['/v1/imports', `/v1/imports/${run.id}`, `/v1/imports/${run.id}/rows`, `/v1/imports/${run.id}/problems`, '/v1/imports/kinds', '/v1/imports/templates/workers']) {
      expect((await who.agent.get(path)).status, path).toBe(403);
    }
    expect((await who.agent.post('/v1/imports').set('Idempotency-Key', 'x').send({ kind: 'workers', fileKey: stored.fileKey, fileName: 'a.csv' })).status).toBe(403);
    expect((await who.agent.post(`/v1/imports/${run.id}/confirm`).send({ version: run.version })).status).toBe(403);
    expect((await who.agent.get('/v1/files/url').query({ key: stored.fileKey })).status).toBe(404);
  }
});

test('every import step is audited', async () => {
  const { admin } = await world();
  const run = await check(admin, 'workers', await xlsx([HEAD, RAVI]));
  await add(admin, run);
  const steps = await AuditLog.find({ entityType: 'import', entityId: run.id }).sort({ seq: 1 }).lean();
  expect(steps.map((s) => s.action)).toEqual(['request', 'confirm', 'finish']);
  expect(steps[2].changes).toBeTruthy();
  const worker = await Worker.findOne().lean();
  const created = await AuditLog.findOne({ entityType: 'worker', entityId: String(worker._id), action: 'create' }).lean();
  expect(String(created.userId)).toBe(String(admin.user._id));
  expect(created.userAgent).toBe(`import:${run.id}`);
  expect(await ImportRow.countDocuments({ runId: run.id, expiresAt: { $gt: new Date(Date.now() + 29 * 86_400_000) } })).toBe(1);
});

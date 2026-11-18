import { http, HttpResponse } from 'msw';
import { server } from './server.js';

const column = (key, header, required = false) => ({ key, header, required, example: '', help: `${header} help`, choices: null });

/** The kinds as GET /v1/imports/kinds answers them (a few columns each). */
export const importKinds = [
  { kind: 'customers', label: 'Customers', help: 'Everyone who has ordered.', needsAsOf: false, columns: [column('name', 'Name', true), column('phone', 'Phone', true)] },
  { kind: 'vendors', label: 'Vendors', help: 'Dyers and suppliers.', needsAsOf: false, columns: [column('name', 'Name', true)] },
  { kind: 'workers', label: 'Workers', help: 'Tailors and artisans.', needsAsOf: false, columns: [column('name', 'Name', true)] },
  { kind: 'catalog', label: 'Price list', help: 'What you sell.', needsAsOf: false, columns: [column('name', 'Name', true)] },
  { kind: 'stock', label: 'Stock', help: 'Materials on the shelf.', needsAsOf: false, columns: [column('name', 'Name', true)] },
  { kind: 'orders', label: 'Open orders', help: 'Orders not yet picked up.', needsAsOf: false, columns: [column('legacyRef', 'Old order no.', true)] },
  { kind: 'opening_balances', label: 'Opening balances', help: 'What customers owed you.', needsAsOf: true, columns: [column('customerPhone', 'Customer phone', true)] },
];

/** An import run as the API answers it. */
export function importRun(fields = {}) {
  return {
    id: 'imp1',
    kind: 'customers',
    label: 'Customers',
    fileName: 'customers.xlsx',
    status: 'checked',
    phase: 'check',
    rowCount: 500,
    counts: { ready: 480, exists: 12, error: 8, added: 0, skipped: 0, failed: 0 },
    progress: { done: 0, total: 500 },
    unusedColumns: [],
    fileError: null,
    sameFileAs: null,
    asOf: null,
    requestedBy: { id: 'admin1', name: 'Owner' },
    confirmedBy: null,
    createdAt: '2026-11-03T06:00:00.000Z',
    finishedAt: null,
    version: 0,
    ...fields,
  };
}

/**
 * MSW handlers for the imports pages. `runs()` answers GET /v1/imports; `run()` answers
 * GET /v1/imports/imp1 (call it again to change what the page sees); rows come from `rows`.
 * Answers the requests it saw: { starts, confirms, resumes, uploads, downloads }.
 */
export function importsServer({ runs = () => [], run = () => importRun(), rows = {} } = {}) {
  const seen = { starts: [], confirms: [], resumes: [], cancels: [], uploads: [], puts: 0, downloads: [] };
  server.use(
    http.get('/v1/imports/kinds', () => HttpResponse.json({ kinds: importKinds })),
    http.get('/v1/imports', () => HttpResponse.json({ items: runs(), nextCursor: null })),
    http.get('/v1/imports/imp1', () => HttpResponse.json({ import: run() })),
    http.get('/v1/imports/imp1/rows', ({ request }) => {
      const status = new URL(request.url).searchParams.get('status') ?? 'all';
      return HttpResponse.json({ items: rows[status] ?? [], nextCursor: null });
    }),
    http.post('/v1/files/upload-url', async ({ request }) => {
      const body = await request.json();
      seen.uploads.push(body);
      return HttpResponse.json({ key: 'b1/import_file/2026/abc.xlsx', url: 'https://storage.test/put', headers: { 'Content-Type': body.contentType } });
    }),
    http.put('https://storage.test/put', () => {
      seen.puts += 1;
      return new HttpResponse(null, { status: 200 });
    }),
    http.post('/v1/imports', async ({ request }) => {
      seen.starts.push({ body: await request.json(), key: request.headers.get('Idempotency-Key') });
      return HttpResponse.json({ import: importRun({ status: 'checking', counts: { ready: 0, exists: 0, error: 0, added: 0, skipped: 0, failed: 0 } }) }, { status: 202 });
    }),
    http.post('/v1/imports/imp1/confirm', async ({ request }) => {
      seen.confirms.push(await request.json());
      return HttpResponse.json({ import: importRun({ status: 'importing', phase: 'commit', progress: { done: 0, total: 480 }, version: 1 }) });
    }),
    http.post('/v1/imports/imp1/resume', async ({ request }) => {
      seen.resumes.push(await request.json());
      return HttpResponse.json({ import: importRun({ status: 'importing', phase: 'commit', version: 2 }) });
    }),
    http.post('/v1/imports/imp1/cancel', async ({ request }) => {
      seen.cancels.push(await request.json());
      return HttpResponse.json({ import: importRun({ status: 'cancelled', version: 1 }) });
    }),
    http.get('/v1/imports/templates/:kind', ({ params, request }) => {
      const format = new URL(request.url).searchParams.get('format') ?? 'xlsx';
      seen.downloads.push({ kind: params.kind, format });
      return new HttpResponse(new Uint8Array([80, 75, 3, 4]), {
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="Customers template.${format}"` },
      });
    }),
    http.get('/v1/imports/imp1/problems', () => {
      seen.downloads.push({ problems: true });
      return new HttpResponse(new Uint8Array([80, 75, 3, 4]), { headers: { 'Content-Disposition': 'attachment; filename="Customers rows to fix.xlsx"' } });
    }),
  );
  return seen;
}

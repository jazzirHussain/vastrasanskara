import { test, expect, vi, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { asDesigner, asOperations } from '../../test/server.js';
import { asOwner } from '../../test/billing.js';
import { renderApp } from '../../test/setup.js';
import { importRun, importsServer } from '../../test/imports.js';
import { todayYmd } from '../../components/DateLabel.jsx';
import { addDaysYmd } from '@vs/shared/fy.js';
import { saver } from '../../lib/download.js';

afterEach(() => vi.restoreAllMocks());

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const file = (name = 'customers.xlsx', type = XLSX, size = 2048) => new File([new Uint8Array(size)], name, { type });

test('the kinds are listed in order with their last result', async () => {
  asOwner();
  importsServer({
    runs: () => [
      importRun({ id: 'r2', kind: 'vendors', label: 'Vendors', status: 'checking' }),
      importRun({ id: 'r1', kind: 'customers', status: 'done', phase: 'commit', counts: { ready: 0, exists: 2, error: 1, added: 412, skipped: 0, failed: 0 }, finishedAt: '2026-11-03T07:00:00.000Z' }),
    ],
  });
  renderApp('/imports');
  expect(await screen.findByRole('heading', { name: 'Bring in old records', level: 1 })).toBeInTheDocument();
  expect(screen.getByText('Bring your old records into the system. Do them in this order.')).toBeInTheDocument();
  const cards = await screen.findAllByRole('region');
  expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual(['Customers', 'Vendors', 'Workers', 'Price list', 'Stock', 'Open orders', 'Opening balances']);
  expect(within(cards[0]).getByText('Done: 412 added on 3 Nov')).toBeInTheDocument();
  expect(within(cards[1]).getByText('Checking…')).toBeInTheDocument();
  expect(within(cards[2]).getByText('Not started')).toBeInTheDocument();
  expect(within(cards[0]).getByText('1')).toBeInTheDocument();
});

test('a template downloads as Excel', async () => {
  asOwner();
  const seen = importsServer();
  const saved = [];
  vi.spyOn(saver, 'save').mockImplementation((blob, name) => saved.push(name));
  renderApp('/imports');
  const card = await screen.findByRole('region', { name: 'Customers' });
  await userEvent.click(within(card).getByRole('button', { name: 'Download template' }));
  await expect.poll(() => saved).toEqual(['Customers template.xlsx']);
  await userEvent.click(within(card).getByRole('button', { name: 'CSV instead' }));
  await expect.poll(() => seen.downloads.map((d) => d.format)).toEqual(['xlsx', 'csv']);
});

test('uploading a filled file shows the check, then the preview', async () => {
  asOwner();
  let current = importRun({ status: 'checking', counts: { ready: 0, exists: 0, error: 0, added: 0, skipped: 0, failed: 0 } });
  const seen = importsServer({ run: () => current, rows: { error: [{ rowNo: 14, status: 'error', label: 'Priya S', errors: [{ column: 'Phone', message: "'98765' is not a 10-digit mobile number." }] }] } });
  renderApp('/imports');
  const card = await screen.findByRole('region', { name: 'Customers' });
  await userEvent.upload(within(card).getByLabelText('Upload filled file'), file());
  await expect.poll(() => seen.starts.length).toBe(1);
  expect(seen.uploads[0]).toEqual({ purpose: 'import_file', contentType: XLSX, size: 2048 });
  expect(seen.starts[0].body).toEqual({ kind: 'customers', fileKey: 'b1/import_file/2026/abc.xlsx', fileName: 'customers.xlsx' });
  expect(seen.starts[0].key).toMatch(/^[0-9a-f-]{36}$/);
  expect(await screen.findByText('Checking your file…')).toBeInTheDocument();
  current = importRun();
  expect(await screen.findByText('480 ready to add', {}, { timeout: 4000 })).toBeInTheDocument();
  expect(screen.getByText('12 already in the system')).toBeInTheDocument();
  expect(screen.getByText('8 need fixing')).toBeInTheDocument();
});

test('rows needing fixes say the row, column and problem', async () => {
  asOwner();
  const seen = importsServer({
    run: () => importRun({ unusedColumns: ['Remarks'], sameFileAs: { id: 'old', at: '2026-11-03T06:00:00.000Z' } }),
    rows: { error: [{ rowNo: 14, status: 'error', label: 'Priya S', errors: [{ column: 'Phone', message: "'98765' is not a 10-digit mobile number." }] }] },
  });
  vi.spyOn(saver, 'save').mockImplementation(() => {});
  renderApp('/imports/imp1');
  expect(await screen.findByText("Row 14 · Priya S — Phone: '98765' is not a 10-digit mobile number.")).toBeInTheDocument();
  expect(screen.getByText('These columns were not used: Remarks')).toBeInTheDocument();
  expect(screen.getByText(/You uploaded this file on 3 November/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Download rows to fix' }));
  await expect.poll(() => seen.downloads).toEqual([{ problems: true }]);
});

test('opening balances ask for the cut-over date first', async () => {
  asOwner();
  const seen = importsServer();
  renderApp('/imports');
  const card = await screen.findByRole('region', { name: 'Opening balances' });
  const date = within(card).getByLabelText('Cut-over date (the last day of your old records)');
  expect(date).toHaveValue(addDaysYmd(todayYmd(), -1));
  expect(date).toHaveAttribute('max', todayYmd());
  await userEvent.upload(within(card).getByLabelText('Upload filled file'), file('balances.csv', 'text/csv'));
  await expect.poll(() => seen.starts.length).toBe(1);
  expect(seen.starts[0].body).toEqual({ kind: 'opening_balances', fileKey: 'b1/import_file/2026/abc.xlsx', fileName: 'balances.csv', asOf: addDaysYmd(todayYmd(), -1) });
});

test('a file too big is refused before uploading', async () => {
  asOwner();
  const seen = importsServer();
  renderApp('/imports');
  const card = await screen.findByRole('region', { name: 'Customers' });
  await userEvent.upload(within(card).getByLabelText('Upload filled file'), file('big.xlsx', XLSX, 5242881));
  expect(await within(card).findByText('This file is larger than 5 MB. Split it into smaller files.')).toBeInTheDocument();
  expect(seen.uploads).toEqual([]);
});

test('adding confirms first and then shows progress', async () => {
  asOwner();
  let current = importRun();
  const seen = importsServer({ run: () => current });
  renderApp('/imports/imp1');
  await userEvent.click(await screen.findByRole('button', { name: 'Add 480 customers' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText(/Rows that need fixing are left out/)).toBeInTheDocument();
  current = importRun({ status: 'importing', phase: 'commit', progress: { done: 120, total: 480 }, counts: { ready: 360, exists: 12, error: 8, added: 120, skipped: 0, failed: 0 }, version: 1 });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Add them' }));
  await expect.poll(() => seen.confirms).toEqual([{ version: 0 }]);
  expect(await screen.findByText('Adding… 120 of 480')).toBeInTheDocument();
  current = importRun({ status: 'done', phase: 'commit', progress: { done: 480, total: 480 }, counts: { ready: 0, exists: 14, error: 8, added: 478, skipped: 2, failed: 0 }, version: 2 });
  expect(await screen.findByText('Added 478 · 16 were already in the system · 0 could not be added', {}, { timeout: 4000 })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'View customers' })).toHaveAttribute('href', '/customers');
});

test('a stopped import offers to continue', async () => {
  asOwner();
  const seen = importsServer({ run: () => importRun({ status: 'failed', phase: 'commit', fileError: { code: 'IMPORT_FAILED', message: 'Adding stopped part way.' }, version: 3 }) });
  renderApp('/imports/imp1');
  expect(await screen.findByText('Adding stopped part way. Nothing was added twice.')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Continue adding' }));
  await expect.poll(() => seen.resumes).toEqual([{ version: 3 }]);
});

test('a file with a missing column explains what to do', async () => {
  asOwner();
  importsServer({
    run: () => importRun({ counts: { ready: 0, exists: 0, error: 0, added: 0, skipped: 0, failed: 0 }, fileError: { code: 'IMPORT_COLUMNS_MISSING', message: "The file has no 'Phone' column. Download the template and copy your data into it." } }),
  });
  renderApp('/imports/imp1');
  expect(await screen.findByText("The file has no 'Phone' column. Download the template and copy your data into it.")).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Download template' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Add / })).toBeNull();
});

test('operations and designers have no Bring in records menu and are sent away', async () => {
  for (const as of [asOperations, asDesigner]) {
    as();
    importsServer();
    const { unmount } = renderApp('/imports');
    await screen.findByRole('navigation', { name: 'Main' });
    expect(screen.queryByRole('link', { name: 'Bring in records' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Bring in old records' })).toBeNull();
    unmount();
  }
});

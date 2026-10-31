import { test, expect, vi, afterEach } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server, asDesigner } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';
import { todayYmd } from '../../test/orders.js';
import { asFrontDesk } from '../../test/billing.js';
import { expenseFixture, expensePosts, payeesAre, uploadsWork, vendorPayee } from '../../test/expenses.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete HTMLCanvasElement.prototype.toBlob;
});

const photo = (name = 'bill.jpg', type = 'image/jpeg', size = 1000) => new File([new Uint8Array(size)], name, { type });

async function openNew() {
  asFrontDesk();
  renderApp('/expenses/new');
  return screen.findByLabelText('How much?');
}

async function fillBasics({ amount = '500', payee = 'Sharma Electricals' } = {}) {
  await userEvent.type(await screen.findByLabelText('How much?'), amount);
  await chooseRepairs();
  await userEvent.type(screen.getByLabelText('Paid to'), payee);
}

async function chooseRepairs() {
  // Only the six most used show at first; a new phone has no history yet.
  await userEvent.click(screen.getByRole('button', { name: 'More' }));
  await userEvent.click(screen.getByRole('button', { name: 'Repairs and maintenance' }));
}

const saveButton = (name) => screen.getByRole('button', { name });

test('saves an expense with amount, category, payee, mode and a photo', async () => {
  const posts = expensePosts();
  uploadsWork();
  await openNew();
  await fillBasics();
  expect(screen.getByRole('button', { name: 'Cash' })).toHaveAttribute('aria-pressed', 'true');
  await userEvent.upload(screen.getByLabelText('Bill photo from camera'), photo());
  await screen.findByRole('button', { name: 'Remove bill.jpg' });
  await userEvent.click(saveButton('Save expense of ₹500.00'));
  expect(await screen.findByText('EXP/2627/0012 saved')).toBeInTheDocument();
  expect(posts).toHaveLength(1);
  expect(posts[0].key).toMatch(/.{10,}/);
  expect(posts[0].body).toEqual({
    date: todayYmd(),
    category: 'repairs',
    note: '',
    payee: { vendorId: null, name: 'Sharma Electricals', gstin: null, stateCode: null },
    total: 50000,
    mode: 'cash',
    reference: '',
    gst: null,
    attachments: [{ key: 'b1/expense_bill/2026/photo1.jpg', name: 'bill.jpg' }],
    link: null,
  });
});

test('a retry after a network error reuses the key', async () => {
  const posts = expensePosts((n) => (n === 1 ? HttpResponse.error() : HttpResponse.json({ expense: expenseFixture() }, { status: 201 })));
  await openNew();
  await fillBasics();
  await userEvent.click(saveButton('Save expense of ₹500.00'));
  expect(await screen.findByText(/Cannot reach the server/)).toBeInTheDocument();
  await userEvent.click(saveButton('Save expense of ₹500.00'));
  expect(await screen.findByText('EXP/2627/0012 saved')).toBeInTheDocument();
  expect(posts).toHaveLength(2);
  expect(posts[1].key).toBe(posts[0].key);
});

test('an expense that may already be saved says so', async () => {
  expensePosts(() => HttpResponse.json({ error: { code: 'IDEMPOTENCY_KEY_REUSED', message: 'x' } }, { status: 409 }));
  await openNew();
  await fillBasics();
  await userEvent.click(saveButton('Save expense of ₹500.00'));
  expect(await screen.findByText('This expense may already be saved. Check Expenses before trying again.')).toBeInTheDocument();
});

test('a new payee name is sent as free text; a vendor sends its id', async () => {
  payeesAre({ vendors: [vendorPayee()], recent: [] });
  const posts = expensePosts();
  await openNew();
  await fillBasics({ payee: 'Sharma' });
  expect(await screen.findByRole('button', { name: /Use .Sharma./ })).toBeInTheDocument();
  await userEvent.click(await screen.findByRole('button', { name: /Sharma Electricals/ }));
  expect(await screen.findByText('Sharma Electricals')).toBeInTheDocument();
  await userEvent.click(saveButton('Save expense of ₹500.00'));
  await screen.findByText('EXP/2627/0012 saved');
  expect(posts[0].body.payee).toEqual({ vendorId: '64b7f0c2a1b2c3d4e5f60718', name: 'Sharma Electricals' });

  // A name that is not a vendor goes as written.
  cleanup();
  renderApp('/expenses/new');
  await userEvent.type(await screen.findByLabelText('How much?'), '75');
  await chooseRepairs();
  await userEvent.type(screen.getByLabelText('Paid to'), 'Corner shop');
  await userEvent.click(saveButton('Save expense of ₹75.00'));
  await waitFor(() => expect(posts).toHaveLength(2));
  expect(posts[1].body.payee).toEqual({ vendorId: null, name: 'Corner shop', gstin: null, stateCode: null });
});

test('the GST section fills the split from the total and the rate', async () => {
  const posts = expensePosts();
  await openNew();
  await fillBasics({ amount: '1180' });
  expect(screen.queryByLabelText('Supplier GSTIN')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('switch', { name: 'Has a GST bill?' }));
  await userEvent.type(screen.getByLabelText('Supplier GSTIN'), '29ABCDE1234F1Z5');
  await userEvent.type(screen.getByLabelText('Bill number'), 'A/12');
  expect(screen.getByText('Before GST ₹1,000.00')).toBeInTheDocument();
  expect(screen.getByText('CGST ₹90.00 + SGST ₹90.00')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'This bill has IGST' }));
  expect(screen.getByText('IGST ₹180.00')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'This bill has CGST and SGST' }));
  await userEvent.click(saveButton('Save expense of ₹1,180.00'));
  await screen.findByText('EXP/2627/0012 saved');
  expect(posts[0].body.gst).toEqual({
    billNo: 'A/12',
    billDate: todayYmd(),
    rateBp: 1800,
    taxable: 100000,
    cgst: 9000,
    sgst: 9000,
    igst: 0,
    itcEligible: true,
  });
  expect(posts[0].body.payee).toMatchObject({ gstin: '29ABCDE1234F1Z5', stateCode: '29' });
});

test('figures that do not add up are shown before saving', async () => {
  const posts = expensePosts();
  await openNew();
  await fillBasics({ amount: '1180' });
  await userEvent.click(screen.getByRole('switch', { name: 'Has a GST bill?' }));
  await userEvent.type(screen.getByLabelText('Supplier GSTIN'), '29ABCDE1234F1Z5');
  await userEvent.type(screen.getByLabelText('Bill number'), 'A/12');
  await userEvent.click(screen.getByRole('button', { name: 'Edit amounts' }));
  const taxable = screen.getByLabelText('Before GST (₹)');
  await userEvent.clear(taxable);
  await userEvent.type(taxable, '500');
  expect(await screen.findByText('Before-GST amount and tax must add up to the total')).toBeInTheDocument();
  await userEvent.click(saveButton('Save expense of ₹1,180.00'));
  expect(posts).toHaveLength(0);
});

test('save waits for a photo still uploading', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  expensePosts();
  uploadsWork({ gate });
  await openNew();
  await fillBasics();
  await userEvent.upload(screen.getByLabelText('Bill photo from camera'), photo());
  const waiting = await screen.findByRole('button', { name: 'Uploading photo…' });
  expect(waiting).toBeDisabled();
  release();
  await waitFor(() => expect(saveButton('Save expense of ₹500.00')).toBeEnabled());
});

test('a large photo is shrunk before upload', async () => {
  const { requests } = uploadsWork();
  vi.stubGlobal('createImageBitmap', async () => ({ width: 4000, height: 3000, close() {} }));
  const drawn = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: (...args) => drawn.push(args) });
  HTMLCanvasElement.prototype.toBlob = function toBlob(done, type) {
    done(new File([new Uint8Array(200_000)], 'shrunk.jpg', { type }));
  };
  await openNew();
  await userEvent.upload(screen.getByLabelText('Bill photo from camera'), photo('big.png', 'image/png', 3_000_000));
  await screen.findByRole('button', { name: 'Remove big.jpg' });
  expect(requests[0].contentType).toBe('image/jpeg');
  expect(requests[0].size).toBe(200_000);
  expect(drawn).toHaveLength(1);
});

test('a PDF is uploaded as it is', async () => {
  const { requests } = uploadsWork();
  await openNew();
  await userEvent.upload(screen.getByLabelText('Bill file'), photo('bill.pdf', 'application/pdf', 5000));
  await screen.findByRole('button', { name: 'Remove bill.pdf' });
  expect(requests[0]).toMatchObject({ contentType: 'application/pdf', size: 5000 });
});

test('editing a locked-month expense is not offered', async () => {
  asFrontDesk();
  server.use(http.get('/v1/expenses/e1', () => HttpResponse.json({ expense: expenseFixture({ monthLocked: true }) })));
  renderApp('/expenses/e1/edit');
  await screen.findByText('This month is locked for filing');
  expect(screen.queryByLabelText('How much?')).not.toBeInTheDocument();
});

test('an edit sends only what changed, with the version', async () => {
  asFrontDesk();
  server.use(http.get('/v1/expenses/e1', () => HttpResponse.json({ expense: expenseFixture() })));
  const sent = [];
  server.use(
    http.patch('/v1/expenses/e1', async ({ request }) => {
      sent.push(await request.json());
      return HttpResponse.json({ expense: expenseFixture({ note: 'Fan motor', version: 4 }) });
    }),
  );
  renderApp('/expenses/e1/edit');
  expect(await screen.findByLabelText('How much?')).toHaveValue('500');
  await userEvent.type(screen.getByLabelText('Note (optional)'), 'Fan motor');
  await userEvent.click(saveButton('Save changes'));
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toEqual({ note: 'Fan motor', version: 3 });
});

test('designers cannot open the form', async () => {
  asDesigner();
  renderApp('/expenses/new');
  expect(await screen.findByText('You do not have access to this.')).toBeInTheDocument();
  expect(screen.queryByLabelText('How much?')).not.toBeInTheDocument();
});

test('a photo that did not upload blocks save', async () => {
  const posts = expensePosts();
  server.use(http.post('/v1/files/upload-url', () => HttpResponse.json({ error: { code: 'X', message: 'no' } }, { status: 500 })));
  await openNew();
  await fillBasics();
  await userEvent.upload(screen.getByLabelText('Bill photo from camera'), photo());
  expect(await screen.findByText('A photo did not upload. Remove it or add it again.')).toBeInTheDocument();
  expect(saveButton('Save expense of ₹500.00')).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Remove bill.jpg' }));
  await waitFor(() => expect(saveButton('Save expense of ₹500.00')).toBeEnabled());
  expect(posts).toHaveLength(0);
});

test('typing the payee keeps a GSTIN typed in the GST section', async () => {
  await openNew();
  await fillBasics({ payee: 'Corner' });
  await userEvent.click(screen.getByRole('switch', { name: 'Has a GST bill?' }));
  await userEvent.type(screen.getByLabelText('Supplier GSTIN'), '29ABCDE1234F1Z5');
  await userEvent.type(screen.getByLabelText('Paid to'), ' shop');
  expect(screen.getByLabelText('Supplier GSTIN')).toHaveValue('29ABCDE1234F1Z5');
});

test('a double tap on Save sends one request', async () => {
  const posts = expensePosts();
  await openNew();
  await fillBasics();
  await userEvent.dblClick(saveButton('Save expense of ₹500.00'));
  await screen.findByText('EXP/2627/0012 saved');
  expect(posts).toHaveLength(1);
});

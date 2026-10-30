import { test, expect, vi, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { computeInvoice, formatINR } from '@vs/shared';
import { server, asDesigner, asOperations } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';
import { orderDetailFixture } from '../../test/orders.js';
import {
  asFrontDesk,
  blouseItem,
  catalog,
  draftFixture,
  issuedFixture,
  lineInput,
  orderMoney,
  orderMoneyFixture,
} from '../../test/billing.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const lineCard = (n) => screen.getByRole('group', { name: `Line ${n}` });
const totals = () => screen.getByRole('region', { name: 'Bill totals' });

/** GET returns the current draft; PUT records the body and answers the next version. */
function draftServer(initial) {
  const puts = [];
  let current = initial;
  server.use(
    http.get('/v1/billing/invoices/inv1', () => HttpResponse.json({ invoice: current })),
    http.put('/v1/billing/invoices/inv1', async ({ request }) => {
      const body = await request.json();
      puts.push(body);
      const { version, ...patch } = body;
      current = draftFixture({ ...patch, version: version + 1 });
      return HttpResponse.json({ invoice: current });
    }),
  );
  return { puts, set: (inv) => (current = inv) };
}

test('create bill from an order opens the draft with garments and charges', async () => {
  asFrontDesk();
  catalog();
  orderMoney({ orderValue: 400000, advanceDue: 200000 });
  const draft = draftFixture({
    lines: [
      lineInput(),
      lineInput({ key: 'g-g2', garmentId: 'g2', description: 'Blouse — Blouse 2 (VS/ORD/2627/0007-02)' }),
      lineInput({
        key: 'e-ev1',
        source: 'charge',
        garmentId: null,
        stageEventId: 'ev1',
        itemId: 'i2',
        description: 'Alteration — Blouse 1 (VS/ORD/2627/0007-01)',
        rate: 50000,
      }),
    ],
  });
  let posted;
  server.use(
    http.get('/v1/orders/o1', () => HttpResponse.json(orderDetailFixture({ garments: 2 }))),
    http.post('/v1/billing/invoices/from-order', async ({ request }) => {
      posted = await request.json();
      return HttpResponse.json({ invoice: draft }, { status: 201 });
    }),
    http.get('/v1/billing/invoices/inv1', () => HttpResponse.json({ invoice: draft })),
  );
  renderApp('/orders/o1');
  const panel = await screen.findByRole('region', { name: 'Money' });
  expect(within(panel).getByText('Order value')).toBeInTheDocument();
  expect(within(panel).getByText('₹4,000.00')).toBeInTheDocument();
  expect(within(panel).getByText('GST will be added on the bill')).toBeInTheDocument();
  expect(within(panel).getByText('₹2,000.00')).toBeInTheDocument(); // advance due

  await userEvent.click(within(panel).getByRole('button', { name: 'Create bill' }));
  expect(await screen.findByRole('heading', { name: 'Draft bill', level: 1 })).toBeInTheDocument();
  expect(posted).toEqual({ orderId: 'o1' });
  expect(within(lineCard(1)).getByDisplayValue('Blouse — Blouse 1 (VS/ORD/2627/0007-01)')).toBeInTheDocument();
  expect(within(lineCard(1)).getByRole('textbox', { name: 'Billed as' })).toHaveValue('Blouse stitching');
  expect(within(lineCard(2)).getByDisplayValue('Blouse — Blouse 2 (VS/ORD/2627/0007-02)')).toBeInTheDocument();
  expect(within(lineCard(3)).getByDisplayValue('Alteration — Blouse 1 (VS/ORD/2627/0007-01)')).toBeInTheDocument();
  expect(within(lineCard(3)).getByRole('textbox', { name: 'Billed as' })).toHaveValue('Alteration');
  // ₹2,000 + ₹2,000 + ₹500 before GST, 5% on each.
  expect(within(totals()).getByText('₹4,500.00')).toBeInTheDocument();
  expect(within(totals()).getByText('GST 5%')).toBeInTheDocument();
  expect(within(totals()).getByText('₹225.00')).toBeInTheDocument();
  expect(within(totals()).getByText('₹4,725.00')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Issue bill' })).toBeEnabled();
});

test('an order with a draft offers to open it', async () => {
  asFrontDesk();
  orderMoney({ draftInvoiceId: 'inv1', invoices: [{ id: 'inv0', number: 'INV/2627/0001', status: 'issued', total: 210000, balance: 0 }] });
  server.use(http.get('/v1/orders/o1', () => HttpResponse.json(orderDetailFixture())));
  renderApp('/orders/o1');
  const panel = await screen.findByRole('region', { name: 'Money' });
  expect(await within(panel).findByRole('link', { name: 'Open draft bill' })).toHaveAttribute('href', '/bills/inv1');
  expect(within(panel).queryByRole('button', { name: 'Create bill' })).toBeNull();
  const bill = within(panel).getByRole('link', { name: /INV\/2627\/0001/ });
  expect(bill).toHaveAttribute('href', '/bills/inv0');
  expect(within(bill).getByText('Paid')).toBeInTheDocument();
});

test('totals follow the lines and match the shared calculation', async () => {
  asFrontDesk();
  catalog();
  orderMoney({ advanceHeld: 100000 });
  const { puts } = draftServer(draftFixture());
  renderApp('/bills/inv1');
  await screen.findByRole('heading', { name: 'Draft bill', level: 1 });
  expect(within(totals()).getByText('GST 5%')).toBeInTheDocument();
  expect(within(totals()).getByText('₹2,100.00')).toBeInTheDocument();
  expect(within(totals()).getByText('GST will be added')).toBeInTheDocument();

  const price = within(lineCard(1)).getByLabelText('Price (₹)');
  await userEvent.clear(price);
  await userEvent.type(price, '3000');
  const expected = computeInvoice({
    lines: [{ key: 'g-g1', quantity: 1, rate: 300000, discount: 0, hsnSac: blouseItem.hsnSac, gstSlabs: blouseItem.gstSlabs }],
    interState: false,
  }).totals;
  // Above ₹2,500 a piece the clothing rate is 18%: the totals change while typing.
  expect(within(totals()).getByText('GST 18%')).toBeInTheDocument();
  expect(within(totals()).getByText(formatINR(expected.taxable))).toBeInTheDocument();
  expect(within(totals()).getByText(formatINR(expected.tax))).toBeInTheDocument();
  expect(within(totals()).getByText(formatINR(expected.total))).toBeInTheDocument();
  expect(within(totals()).getByText(`CGST ${formatINR(expected.cgst)} · SGST ${formatINR(expected.sgst)}`)).toBeInTheDocument();
  expect(within(totals()).getByText('Advance already paid')).toBeInTheDocument();
  expect(within(totals()).getByText(formatINR(expected.total - 100000))).toBeInTheDocument(); // to pay
  expect(puts).toHaveLength(0);

  await userEvent.tab(); // leaving the field saves the draft
  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0]).toEqual({ version: 0, lines: [lineInput({ rate: 300000 })], invoiceDiscount: null, notes: '' });
});

test('a discount asks why', async () => {
  asFrontDesk();
  catalog();
  const { puts } = draftServer(draftFixture());
  renderApp('/bills/inv1');
  await screen.findByRole('heading', { name: 'Draft bill', level: 1 });
  const card = lineCard(1);
  await userEvent.type(within(card).getByLabelText('Discount'), '200');
  await userEvent.tab();
  expect(await within(card).findByText('Say why there is a discount')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Issue bill' })).toBeDisabled();
  expect(puts).toHaveLength(0);

  await userEvent.type(within(card).getByLabelText('Why?'), 'Regular customer');
  await userEvent.tab();
  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0].lines[0]).toMatchObject({ discount: 20000, discountReason: 'Regular customer' });

  // A percentage is turned into rupees on the line's price.
  await userEvent.click(within(card).getByRole('radio', { name: '%' }));
  const discount = within(card).getByLabelText('Discount');
  expect(discount).toHaveValue('10'); // ₹200 of ₹2,000 is kept as 10%
  await userEvent.clear(discount);
  await userEvent.type(discount, '5');
  await userEvent.tab();
  await expect.poll(() => puts.at(-1).lines[0]).toMatchObject({ discount: 10000, discountReason: 'Regular customer' });
});

test('a line without an item asks what to bill it as', async () => {
  asFrontDesk();
  catalog();
  const { puts } = draftServer(draftFixture({ lines: [lineInput({ itemId: null })] }));
  renderApp('/bills/inv1');
  await screen.findByRole('heading', { name: 'Draft bill', level: 1 });
  expect(within(lineCard(1)).getByText('Choose what to bill this as')).toBeInTheDocument();
  expect(within(totals()).getByText('Choose what each line is billed as to see the total.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Issue bill' })).toBeDisabled();

  await userEvent.click(within(lineCard(1)).getByRole('textbox', { name: 'Billed as' }));
  await userEvent.click(await screen.findByRole('option', { name: 'Blouse stitching' }));
  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0].lines[0].itemId).toBe('i1');
  await expect.poll(() => within(lineCard(1)).queryByText('Choose what to bill this as')).toBeNull();
  expect(within(totals()).getByText('₹2,100.00')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Issue bill' })).toBeEnabled();
});

test('issue asks to confirm and shows the bill number', async () => {
  asFrontDesk();
  catalog();
  const keys = [];
  const bodies = [];
  let current = draftFixture();
  server.use(
    http.get('/v1/billing/invoices/inv1', () => HttpResponse.json({ invoice: current })),
    http.get('/v1/billing/documents/inv1/pdf', () => HttpResponse.json({ status: 'pending', url: null, filename: 'INV-2627-0001.pdf' })),
    http.post('/v1/billing/invoices/inv1/issue', async ({ request }) => {
      keys.push(request.headers.get('Idempotency-Key'));
      bodies.push(await request.json());
      if (keys.length === 1) return HttpResponse.error(); // the network drops the first try
      current = issuedFixture();
      return HttpResponse.json({ invoice: current }, { status: 201 });
    }),
  );
  renderApp('/bills/inv1');
  await userEvent.click(await screen.findByRole('button', { name: 'Issue bill' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('Issue this bill for ₹2,100.00? It gets a bill number and cannot be changed after this.')).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Issue bill' }));
  expect(await within(dialog).findByText('Cannot reach the server. Check your connection and try again.')).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Issue bill' }));
  expect(await within(dialog).findByText('INV/2627/0001')).toBeInTheDocument();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]); // the retry is the same request
  expect(bodies).toEqual([{ version: 0 }, { version: 0 }]);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
  expect(await screen.findByRole('heading', { name: 'INV/2627/0001', level: 1 })).toBeInTheDocument();
});

test('an issued bill has no edit controls', async () => {
  asFrontDesk();
  const issued = issuedFixture({ settlement: { advanceApplied: 100000, paid: 100000, credited: 0, balance: 110000, payStatus: 'part_paid' } });
  server.use(
    http.get('/v1/billing/invoices/inv1', () => HttpResponse.json({ invoice: issued })),
    http.get('/v1/billing/documents/inv1/pdf', () => HttpResponse.json({ status: 'pending', url: null, filename: 'INV-2627-0001.pdf' })),
  );
  renderApp('/bills/inv1');
  expect(await screen.findByRole('heading', { name: 'INV/2627/0001', level: 1 })).toBeInTheDocument();
  expect(screen.getByText('Part paid')).toBeInTheDocument();
  expect(screen.getByText('Blouse — Blouse 1 (VS/ORD/2627/0007-01)')).toBeInTheDocument();
  expect(within(totals()).getByText('Advance already paid')).toBeInTheDocument();
  expect(within(totals()).getByText('Balance to pay')).toBeInTheDocument();
  expect(within(totals()).getByText('₹1,100.00')).toBeInTheDocument();
  expect(screen.getByText(/Pay by/)).toBeInTheDocument();
  expect(screen.queryAllByRole('textbox')).toHaveLength(0);
  expect(screen.queryAllByRole('spinbutton')).toHaveLength(0);
  for (const name of ['Issue bill', 'Delete draft', 'Add item', 'Remove']) {
    expect(screen.queryByRole('button', { name })).toBeNull();
  }
});

test('the PDF button waits while the PDF is prepared', async () => {
  vi.useFakeTimers({ toFake: ['setInterval'] });
  asFrontDesk();
  let ready = false;
  server.use(
    http.get('/v1/billing/invoices/inv1', () => HttpResponse.json({ invoice: issuedFixture() })),
    http.get('/v1/billing/documents/inv1/pdf', () =>
      HttpResponse.json(
        ready
          ? { status: 'ready', url: 'https://files.test/bill.pdf', filename: 'INV-2627-0001.pdf' }
          : { status: 'pending', url: null, filename: 'INV-2627-0001.pdf' },
      ),
    ),
  );
  const tab = { opener: 'x', location: { href: '' }, close: vi.fn() };
  const open = vi.spyOn(window, 'open').mockReturnValue(tab);
  renderApp('/bills/inv1');
  expect(await screen.findByRole('button', { name: 'Preparing the PDF…' })).toBeDisabled();
  ready = true;
  await vi.advanceTimersByTimeAsync(5000);
  const print = await screen.findByRole('button', { name: 'Print / PDF' });
  expect(print).toBeEnabled();
  await userEvent.click(print);
  expect(open).toHaveBeenCalledWith('', '_blank');
  await expect.poll(() => tab.location.href).toBe('https://files.test/bill.pdf');
  expect(tab.opener).toBeNull();
});

test('share hands the PDF file to the phone', async () => {
  asFrontDesk();
  server.use(
    http.get('/v1/billing/invoices/inv1', () => HttpResponse.json({ invoice: issuedFixture({ pdf: { status: 'ready' } }) })),
    http.get('/v1/billing/documents/inv1/pdf', () =>
      HttpResponse.json({ status: 'ready', url: 'https://files.test/bill.pdf', filename: 'INV-2627-0001.pdf' }),
    ),
    http.get('https://files.test/bill.pdf', () => new HttpResponse('%PDF-1.7 bill', { headers: { 'Content-Type': 'application/pdf' } })),
  );
  const share = vi.fn(async () => {});
  const canShare = vi.fn(() => true);
  Object.defineProperty(navigator, 'share', { value: share, configurable: true });
  Object.defineProperty(navigator, 'canShare', { value: canShare, configurable: true });
  try {
    renderApp('/bills/inv1');
    await userEvent.click(await screen.findByRole('button', { name: 'Share' }));
    await expect.poll(() => share.mock.calls.length).toBe(1);
    const [{ files, title }] = share.mock.calls[0];
    expect(title).toBe('Bill INV/2627/0001');
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('INV-2627-0001.pdf');
    expect(files[0].type).toBe('application/pdf');
    const text = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsText(files[0]);
    });
    expect(text).toBe('%PDF-1.7 bill');
  } finally {
    delete navigator.share;
    delete navigator.canShare;
  }
});

test('designers do not see the money panel', async () => {
  asDesigner();
  let asked = false;
  server.use(
    http.get('/v1/orders/o1', () => HttpResponse.json(orderDetailFixture({ money: false }))),
    http.get('/v1/billing/orders/o1/summary', () => {
      asked = true;
      return HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'No' } }, { status: 403 });
    }),
  );
  renderApp('/orders/o1');
  expect(await screen.findByRole('heading', { name: 'VS/ORD/2627/0007', level: 1 })).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Money' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Create bill' })).toBeNull();
  expect(screen.queryByText('Order value')).toBeNull();
  expect(asked).toBe(false);
});

test('a draft is read-only without the right to make bills', async () => {
  asOperations(); // sees money, cannot make bills
  let puts = 0;
  server.use(
    http.get('/v1/billing/invoices/inv1', () => HttpResponse.json({ invoice: draftFixture() })),
    http.get('/v1/billing/orders/o1/summary', () => HttpResponse.json(orderMoneyFixture())),
    http.put('/v1/billing/invoices/inv1', () => {
      puts += 1;
      return HttpResponse.json({ invoice: draftFixture() });
    }),
  );
  renderApp('/bills/inv1');
  expect(await screen.findByRole('heading', { name: 'Draft bill', level: 1 })).toBeInTheDocument();
  expect(screen.getByText('Blouse — Blouse 1 (VS/ORD/2627/0007-01)')).toBeInTheDocument();
  expect(within(totals()).getByText('₹2,100.00')).toBeInTheDocument();
  expect(screen.getByText('Only staff who make bills can change this draft.')).toBeInTheDocument();
  expect(screen.queryAllByRole('textbox')).toHaveLength(0);
  for (const name of ['Issue bill', 'Delete draft', 'Add item', 'Remove', 'Give a discount on the whole bill']) {
    expect(screen.queryByRole('button', { name })).toBeNull();
  }
  await userEvent.click(screen.getByText('Blouse — Blouse 1 (VS/ORD/2627/0007-01)'));
  await userEvent.tab();
  expect(puts).toBe(0);
});

test('a save refused because someone else changed the bill offers a reload', async () => {
  asFrontDesk();
  catalog();
  let gets = 0;
  let current = draftFixture();
  server.use(
    http.get('/v1/billing/invoices/inv1', () => {
      gets += 1;
      return HttpResponse.json({ invoice: current });
    }),
    http.put('/v1/billing/invoices/inv1', () => {
      current = draftFixture({ lines: [lineInput({ rate: 250000 })], version: 1 }); // their change
      return HttpResponse.json({ error: { code: 'CONFLICT', message: 'Version mismatch' } }, { status: 409 });
    }),
  );
  renderApp('/bills/inv1');
  await screen.findByRole('heading', { name: 'Draft bill', level: 1 });
  const price = within(lineCard(1)).getByLabelText('Price (₹)');
  await userEvent.clear(price);
  await userEvent.type(price, '3000');
  await userEvent.tab();
  expect(await screen.findByText('Someone else changed this bill. Reload to see their changes.')).toBeInTheDocument();
  const before = gets;
  await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
  await expect.poll(() => within(lineCard(1)).getByLabelText('Price (₹)')).toHaveValue('2,500');
  expect(gets).toBe(before + 1);
  expect(screen.queryByText('Someone else changed this bill. Reload to see their changes.')).toBeNull();
});

/** An issued bill whose PDF link answers `answer(n)` for the n-th request; counts the requests. */
function pdfServer(answer) {
  const asked = { count: 0 };
  server.use(
    http.get('/v1/billing/invoices/inv1', () => HttpResponse.json({ invoice: issuedFixture({ pdf: { status: 'ready' } }) })),
    http.get('/v1/billing/documents/inv1/pdf', () => {
      asked.count += 1;
      return answer(asked.count);
    }),
    http.get('https://files.test/bill.pdf', () => new HttpResponse('%PDF-1.7 bill', { headers: { 'Content-Type': 'application/pdf' } })),
  );
  return asked;
}
const readyLink = () => HttpResponse.json({ status: 'ready', url: 'https://files.test/bill.pdf', filename: 'INV-2627-0001.pdf' });
const pendingLink = () => HttpResponse.json({ status: 'pending', url: null, filename: 'INV-2627-0001.pdf' });

function mockShare(share) {
  Object.defineProperty(navigator, 'share', { value: share, configurable: true });
  Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
  return () => {
    delete navigator.share;
    delete navigator.canShare;
  };
}

test('print and share ask for a fresh link on every tap', async () => {
  asFrontDesk();
  const asked = pdfServer(readyLink);
  vi.spyOn(window, 'open').mockImplementation(() => ({ opener: null, location: { href: '' }, close: vi.fn() }));
  const share = vi.fn(async () => {});
  const restore = mockShare(share);
  try {
    renderApp('/bills/inv1');
    const print = await screen.findByRole('button', { name: 'Print / PDF' });
    await expect.poll(() => print).toBeEnabled();
    const start = asked.count;
    await userEvent.click(print);
    await expect.poll(() => asked.count).toBe(start + 1);
    await userEvent.click(screen.getByRole('button', { name: 'Print / PDF' }));
    await expect.poll(() => asked.count).toBe(start + 2);
    await userEvent.click(screen.getByRole('button', { name: 'Share' }));
    await expect.poll(() => share.mock.calls.length).toBe(1);
    expect(asked.count).toBe(start + 3);
  } finally {
    restore();
  }
});

test('a PDF that is not ready when tapped says so', async () => {
  asFrontDesk();
  pdfServer((n) => (n === 1 ? readyLink() : pendingLink()));
  const tab = { opener: null, location: { href: '' }, close: vi.fn() };
  vi.spyOn(window, 'open').mockReturnValue(tab);
  renderApp('/bills/inv1');
  const print = await screen.findByRole('button', { name: 'Print / PDF' });
  await expect.poll(() => print).toBeEnabled();
  await userEvent.click(print);
  expect(await screen.findByText('The PDF is not ready yet. Try again in a minute.')).toBeInTheDocument();
  expect(tab.close).toHaveBeenCalled();
  expect(tab.location.href).toBe('');
  expect(await screen.findByRole('button', { name: 'Preparing the PDF…' })).toBeDisabled();
});

test('a failed link request leaves the PDF button usable', async () => {
  asFrontDesk();
  const asked = pdfServer((n) =>
    n === 1 ? HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 404 }) : readyLink(),
  );
  const tab = { opener: null, location: { href: '' }, close: vi.fn() };
  vi.spyOn(window, 'open').mockReturnValue(tab);
  renderApp('/bills/inv1');
  const print = await screen.findByRole('button', { name: 'Print / PDF' });
  await expect.poll(() => print).toBeEnabled();
  expect(asked.count).toBe(1);
  await userEvent.click(print);
  await expect.poll(() => tab.location.href).toBe('https://files.test/bill.pdf');
  expect(asked.count).toBe(2);
});

test('a PDF that takes too long stops waiting and offers to try again', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  asFrontDesk();
  const asked = pdfServer(pendingLink);
  renderApp('/bills/inv1');
  expect(await screen.findByRole('button', { name: 'Preparing the PDF…' })).toBeDisabled();
  await vi.advanceTimersByTimeAsync(125_000);
  expect(await screen.findByText('The PDF is taking longer than usual. Try again in a minute.')).toBeInTheDocument();
  const stopped = asked.count;
  expect(stopped).toBeGreaterThan(10); // it was polling every 5 s
  await vi.advanceTimersByTimeAsync(30_000);
  expect(asked.count).toBe(stopped); // and has stopped
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  await expect.poll(() => asked.count).toBe(stopped + 1);
  expect(screen.queryByText('The PDF is taking longer than usual. Try again in a minute.')).toBeNull();
});

test('a share that fails says what to do in plain words', async () => {
  asFrontDesk();
  pdfServer(readyLink);
  const restore = mockShare(
    vi.fn(async () => {
      throw new TypeError('DataError: internal share failure 0x80');
    }),
  );
  try {
    renderApp('/bills/inv1');
    const share = await screen.findByRole('button', { name: 'Share' });
    await expect.poll(() => share).toBeEnabled();
    await userEvent.click(share);
    expect(await screen.findByText('Couldn’t share. Use Print / PDF to download it instead.')).toBeInTheDocument();
    expect(screen.queryByText(/0x80/)).toBeNull();
  } finally {
    restore();
  }
});

test('deleting a draft goes back to the order without an error', async () => {
  asFrontDesk();
  catalog();
  let deleted = false;
  server.use(
    http.get('/v1/billing/invoices/inv1', () =>
      deleted
        ? HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 404 })
        : HttpResponse.json({ invoice: draftFixture() }),
    ),
    http.delete('/v1/billing/invoices/inv1', () => {
      deleted = true;
      return new HttpResponse(null, { status: 204 });
    }),
    http.get('/v1/orders/o1', () => HttpResponse.json(orderDetailFixture())),
  );
  renderApp('/bills/inv1');
  await userEvent.click(await screen.findByRole('button', { name: 'Delete draft' }));
  await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete draft' }));
  expect(await screen.findByRole('heading', { name: 'VS/ORD/2627/0007', level: 1 })).toBeInTheDocument();
  expect(screen.queryByText(/could not be found/)).toBeNull();
});

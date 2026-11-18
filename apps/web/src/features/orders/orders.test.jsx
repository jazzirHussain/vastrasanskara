import { test, expect, vi, afterEach } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { addDaysYmd } from '@vs/shared';
import { server, asOperations, asDesigner, defaultSettings } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';
import { orderDetailFixture, orderSummary, todayYmd } from '../../test/orders.js';

afterEach(() => vi.restoreAllMocks());

const detail = (fields) => server.use(http.get('/v1/orders/o1', () => HttpResponse.json(orderDetailFixture(fields))));

test('orders list filters and opens an order', async () => {
  asOperations(); const queries = [];
  const rush = orderSummary(orderDetailFixture({ priority: 'rush', tight: true }));
  server.use(http.get('/v1/orders', ({ request }) => {
    queries.push(Object.fromEntries(new URL(request.url).searchParams));
    return HttpResponse.json({ items: [rush], nextCursor: null });
  }));
  detail();
  renderApp('/orders');
  await screen.findByText('VS/ORD/2627/0007');
  expect(screen.getAllByText('Rush')).toHaveLength(2); // the filter chip and the row's badge
  expect(screen.getByText('Tight schedule')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('radio', { name: 'On hold' }));
  await expect.poll(() => queries.at(-1)).toMatchObject({ status: 'on_hold' });
  await userEvent.click(screen.getByRole('radio', { name: 'Rush' }));
  await expect.poll(() => queries.at(-1)).toMatchObject({ priority: 'rush', status: 'active' });
  await userEvent.click(screen.getByRole('radio', { name: 'Pickup this week' }));
  await expect.poll(() => queries.at(-1)).toMatchObject({ pickupFrom: todayYmd(), pickupTo: addDaysYmd(todayYmd(), 6) });
  await userEvent.click(await screen.findByText('VS/ORD/2627/0007')); // rows re-render per filter
  expect(await screen.findByRole('heading', { name: 'VS/ORD/2627/0007', level: 1 })).toBeInTheDocument();
});
test('designer sees no prices on the order page', async () => {
  asDesigner();
  detail({ money: false });
  renderApp('/orders/o1');
  expect(await screen.findByRole('heading', { name: 'VS/ORD/2627/0007', level: 1 })).toBeInTheDocument();
  expect(screen.queryByText(/₹/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Cancel order' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Adjust plan' })).toBeInTheDocument();
});
test('moving the pickup date shows the original', async () => {
  asOperations(); let sent;
  const original = orderDetailFixture();
  const moved = addDaysYmd(original.pickupDate, 5);
  let current = original;
  server.use(
    http.get('/v1/orders/o1', () => HttpResponse.json(current)),
    http.patch('/v1/orders/o1', async ({ request }) => {
      sent = await request.json();
      current = { ...original, pickupDate: moved, version: 1 };
      return HttpResponse.json(current);
    }),
  );
  renderApp('/orders/o1');
  await userEvent.click(await screen.findByRole('button', { name: 'Change pickup date' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('New pickup date'), { target: { value: moved } });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Move pickup' }));
  expect(sent).toEqual({ version: 0, pickupDate: moved });
  expect(await screen.findByText((_, el) => el?.tagName === 'P' && el.textContent.startsWith('Originally '))).toBeInTheDocument();
});
test('cancel dialog shows the refund percent', async () => {
  asOperations(); let sent;
  server.use(
    http.get('/v1/settings', () => HttpResponse.json({ ...defaultSettings, cancellationRefundSchedule: [{ uptoStage: 'tailors', refundPercent: 40 }, { uptoStage: 'pattern_making', refundPercent: 80 }] })),
    http.post('/v1/orders/o1/cancel', async ({ request }) => { sent = await request.json(); return HttpResponse.json(orderDetailFixture({ status: 'cancelled', version: 1 })); }),
  );
  detail();
  renderApp('/orders/o1');
  await userEvent.click(await screen.findByRole('button', { name: 'Cancel order' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText(/80% of the advance is refunded/)).toBeInTheDocument();
  await userEvent.type(within(dialog).getByLabelText('Reason'), 'Wedding called off');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel order' }));
  await expect.poll(() => sent).toEqual({ version: 0, reason: 'Wedding called off' });
});
test('conflict offers a reload', async () => {
  asOperations(); let gets = 0;
  server.use(
    http.get('/v1/orders/o1', () => { gets += 1; return HttpResponse.json(orderDetailFixture()); }),
    http.post('/v1/orders/o1/hold', () => HttpResponse.json({ error: { code: 'CONFLICT', message: 'x' } }, { status: 409 })),
  );
  renderApp('/orders/o1');
  await userEvent.click(await screen.findByRole('button', { name: 'Put on hold' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText('Reason'), 'Client travelling');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Put on hold' }));
  expect(await screen.findByText('Someone else changed this order. Reload to see their changes.')).toBeInTheDocument();
  const before = gets;
  await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
  await expect.poll(() => gets).toBeGreaterThan(before);
});
test('adjusting the plan sends only changed dates', async () => {
  asDesigner(); let sent;
  const order = orderDetailFixture({ money: false });
  const handwork = order.garments[0].stagePlan.find((s) => s.stage === 'handwork').plannedDate;
  server.use(
    http.get('/v1/orders/o1', () => HttpResponse.json(order)),
    http.put('/v1/garments/g1/plan', async ({ request }) => { sent = await request.json(); return HttpResponse.json(order.garments[0]); }),
  );
  renderApp('/orders/o1');
  await userEvent.click(await screen.findByRole('button', { name: 'Adjust plan' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Handwork'), { target: { value: addDaysYmd(handwork, 1) } });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save plan' }));
  await expect.poll(() => sent).toEqual({ version: 0, changes: [{ stage: 'handwork', plannedDate: addDaysYmd(handwork, 1) }] });
});
test('a reference photo opens in a tab taken during the tap', async () => {
  asOperations();
  const fixture = orderDetailFixture();
  fixture.garments[0].referenceKeys = ['garment_reference/a.jpg'];
  const tab = { location: { href: '' }, opener: {}, close: vi.fn() };
  const open = vi.spyOn(window, 'open').mockReturnValue(tab);
  let openedBeforeUrl = null;
  server.use(
    http.get('/v1/orders/o1', () => HttpResponse.json(fixture)),
    http.get('/v1/files/url', () => {
      openedBeforeUrl = open.mock.calls.length > 0;
      return HttpResponse.json({ url: 'https://files.example/a.jpg' });
    }),
  );
  renderApp('/orders/o1');
  await userEvent.click(await screen.findByRole('button', { name: 'Photo 1' }));
  await expect.poll(() => tab.location.href).toBe('https://files.example/a.jpg');
  expect(openedBeforeUrl).toBe(true);
  expect(tab.opener).toBeNull();
});
test('a reference photo that cannot be opened says so', async () => {
  asOperations();
  const fixture = orderDetailFixture();
  fixture.garments[0].referenceKeys = ['garment_reference/a.jpg'];
  const tab = { location: { href: '' }, opener: {}, close: vi.fn() };
  vi.spyOn(window, 'open').mockReturnValue(tab);
  server.use(
    http.get('/v1/orders/o1', () => HttpResponse.json(fixture)),
    http.get('/v1/files/url', () => HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 404 })),
  );
  renderApp('/orders/o1');
  await userEvent.click(await screen.findByRole('button', { name: 'Photo 1' }));
  expect(await screen.findByText(/photo could not be opened/i)).toBeInTheDocument();
  expect(tab.close).toHaveBeenCalled();
});
test('a plan conflict offers a reload', async () => {
  asDesigner(); let gets = 0;
  const order = orderDetailFixture({ money: false });
  const handwork = order.garments[0].stagePlan.find((s) => s.stage === 'handwork').plannedDate;
  server.use(
    http.get('/v1/orders/o1', () => { gets += 1; return HttpResponse.json(order); }),
    http.put('/v1/garments/g1/plan', () => HttpResponse.json({ error: { code: 'CONFLICT', message: 'x' } }, { status: 409 })),
  );
  renderApp('/orders/o1');
  await userEvent.click(await screen.findByRole('button', { name: 'Adjust plan' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Handwork'), { target: { value: addDaysYmd(handwork, 1) } });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save plan' }));
  const before = gets;
  await userEvent.click(await within(dialog).findByRole('button', { name: 'Reload' }));
  await expect.poll(() => gets).toBeGreaterThan(before);
});
test('late filter asks the server', async () => {
  asOperations(); const queries = [];
  const late = orderSummary(orderDetailFixture({ late: true }));
  server.use(http.get('/v1/orders', ({ request }) => {
    queries.push(Object.fromEntries(new URL(request.url).searchParams));
    return HttpResponse.json({ items: [late], nextCursor: null });
  }));
  renderApp('/orders');
  await screen.findByText('VS/ORD/2627/0007');
  await userEvent.click(screen.getByRole('radio', { name: 'Late' }));
  await expect.poll(() => queries.at(-1)).toEqual({ status: 'active', late: 'true' });
});

test('the old order number is shown on the order', async () => {
  asOperations();
  const imported = orderDetailFixture({ legacyRef: '1234' });
  server.use(http.get('/v1/orders', () => HttpResponse.json({ items: [{ ...orderSummary(imported), legacyRef: '1234' }], nextCursor: null })));
  server.use(http.get('/v1/orders/o1', () => HttpResponse.json({ ...imported, legacyRef: '1234' })));
  renderApp('/orders');
  expect(await screen.findByText('Old no. 1234')).toBeInTheDocument();
  await userEvent.click(screen.getByText('VS/ORD/2627/0007'));
  expect(await screen.findByRole('heading', { name: 'VS/ORD/2627/0007', level: 1 })).toBeInTheDocument();
  expect(screen.getByText('Old no. 1234')).toBeInTheDocument();
});

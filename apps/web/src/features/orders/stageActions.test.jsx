import { test, expect } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { addDaysYmd } from '@vs/shared';
import { server, asDesigner, asOperations } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';
import { orderDetailFixture, todayYmd } from '../../test/orders.js';
import { materialLine, materialsAre } from '../../test/stock.js';
import { STAGE_KEYS, workingStage } from '@vs/shared';

const ravi = { id: 'w1', name: 'Ravi', skill: '', phone: null, active: true, version: 0 };
const zari = { id: 'v1', name: 'Zari works', phone: null, gstin: null, stateCode: '29', services: [], active: true, version: 0 };

/** Serves order o1 with its first garment changed by `garment`; returns what was posted. */
function serve({ garment = {}, money = true, events = [], onPost } = {}) {
  const order = orderDetailFixture({ money });
  Object.assign(order.garments[0], garment);
  let gets = 0;
  let posted;
  server.use(
    http.get('/v1/orders/o1', () => {
      gets += 1;
      return HttpResponse.json(order);
    }),
    http.get('/v1/workers', () => HttpResponse.json({ items: [ravi] })),
    http.get('/v1/vendors', () => HttpResponse.json({ items: [zari] })),
    http.get('/v1/production/garments/g1/events', () => HttpResponse.json({ items: events })),
    http.post('/v1/production/actions', async ({ request }) => {
      posted = await request.json();
      return onPost ? onPost() : HttpResponse.json({ garments: [order.garments[0]] });
    }),
  );
  return { posted: () => posted, gets: () => gets };
}

async function openMore(name) {
  await userEvent.click(await screen.findByRole('button', { name: 'More steps' }));
  await userEvent.click(await screen.findByRole('menuitem', { name }));
  return screen.findByRole('dialog');
}

test('designer marks the current stage done with workers', async () => {
  asDesigner();
  const api = serve({ money: false });
  renderApp('/orders/o1');
  await userEvent.click(await screen.findByRole('button', { name: 'Mark materials ready done' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.click(await within(dialog).findByLabelText('Ravi'));
  await userEvent.type(within(dialog).getByLabelText('Remarks'), 'Silk arrived');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await expect.poll(api.posted).toEqual({
    action: 'complete', stage: 'materials_ready', garments: [{ id: 'g1', version: 0 }], workerIds: ['w1'], remarks: 'Silk arrived',
  });
  await expect.poll(() => screen.queryByRole('dialog')).toBeNull();
});

test('QC failed asks for the stage to rework', async () => {
  asDesigner();
  const api = serve({ money: false, garment: { currentStage: 'quality_check' } });
  renderApp('/orders/o1');
  const dialog = await openMore('QC failed');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(await within(dialog).findByText('Choose the stage to rework')).toBeInTheDocument();
  expect(api.posted()).toBeUndefined();
  const options = within(within(dialog).getByLabelText('Send back to')).getAllByRole('option').map((o) => o.textContent);
  expect(options).toEqual(['Choose a stage', 'Materials ready', 'Pattern making', 'Handwork']);
  await userEvent.selectOptions(within(dialog).getByLabelText('Send back to'), 'handwork');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await expect.poll(api.posted).toMatchObject({ action: 'qc_fail', stage: 'quality_check', reworkStage: 'handwork', chargeable: false });
});

test('send to vendor needs a vendor and a due-back date', async () => {
  asDesigner();
  const api = serve({ money: false, garment: { currentStage: 'handwork' } });
  renderApp('/orders/o1');
  const dialog = await openMore('Send to vendor');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(await within(dialog).findByText('Choose a vendor')).toBeInTheDocument();
  expect(within(dialog).getByText('Choose the day it is due back')).toBeInTheDocument();
  await userEvent.selectOptions(await within(dialog).findByLabelText('Vendor'), 'v1');
  const due = addDaysYmd(todayYmd(), 5);
  fireEvent.change(within(dialog).getByLabelText('Due back'), { target: { value: due } });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await expect.poll(api.posted).toMatchObject({ action: 'sent_to_vendor', stage: 'handwork', vendorId: 'v1', dueBackDate: due });
});

test('alteration asks for a ready-by date', async () => {
  asDesigner();
  const api = serve({ money: false, garment: { currentStage: 'trials_fittings' } });
  renderApp('/orders/o1');
  const dialog = await openMore('Alteration');
  const field = within(dialog).getByLabelText('Ready by');
  expect(field).toHaveValue(addDaysYmd(todayYmd(), 7));
  expect(within(dialog).getByText('When the client will get the altered garment')).toBeInTheDocument();
  const readyBy = addDaysYmd(todayYmd(), 10);
  fireEvent.change(field, { target: { value: readyBy } });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await expect.poll(api.posted).toMatchObject({ action: 'alteration', stage: 'trials_fittings', readyBy });
});

test('operations sees hand over for a ready garment but no stage buttons', async () => {
  asOperations();
  const api = serve({ garment: { currentStage: 'ready_for_pickup', status: 'ready' } });
  renderApp('/orders/o1');
  await userEvent.click(await screen.findByRole('button', { name: 'Hand over to client' }));
  await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save' }));
  await expect.poll(api.posted).toMatchObject({ action: 'picked_up', stage: 'ready_for_pickup' });
  await userEvent.click(screen.getByRole('button', { name: 'More steps' }));
  expect((await screen.findAllByRole('menuitem')).map((m) => m.textContent)).toEqual(['Client rejected']);
});

test('designers cannot enter a charge amount', async () => {
  asDesigner();
  serve({ money: false, garment: { currentStage: 'quality_check' } });
  renderApp('/orders/o1');
  const dialog = await openMore('QC failed');
  await userEvent.click(within(dialog).getByLabelText('Charge the client'));
  expect(within(dialog).queryByLabelText('Charge (₹)')).toBeNull();
});

test('admins can price a chargeable rework', async () => {
  asOperations();
  server.use(
    http.get('/v1/auth/me', () =>
      HttpResponse.json({ id: 'a1', name: 'Owner', roles: ['admin'], branchId: 'b1', permissions: ['orders.read.own', 'orders.read.all', 'orders.write', 'production.update', 'money.view'] }),
    ),
  );
  const api = serve({ garment: { currentStage: 'quality_check' } });
  renderApp('/orders/o1');
  const dialog = await openMore('QC failed');
  await userEvent.selectOptions(within(dialog).getByLabelText('Send back to'), 'handwork');
  await userEvent.click(within(dialog).getByLabelText('Charge the client'));
  await userEvent.type(within(dialog).getByLabelText('Charge (₹)'), '500');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await expect.poll(api.posted).toMatchObject({ chargeable: true, chargeAmount: 50000 });
});

test('a conflict offers reload', async () => {
  asDesigner();
  const api = serve({ money: false, onPost: () => HttpResponse.json({ error: { code: 'CONFLICT' } }, { status: 409 }) });
  renderApp('/orders/o1');
  await userEvent.click(await screen.findByRole('button', { name: 'Mark materials ready done' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(await within(dialog).findByText('Someone else changed this. Reload and try again.')).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Reload' }));
  await expect.poll(() => screen.queryByRole('dialog')).toBeNull();
  await expect.poll(api.gets).toBe(2);
});

test('history lists events newest first', async () => {
  asDesigner();
  const event = (fields) => ({
    workerIds: [], workers: [], vendor: null, dueBackDate: null, reworkStage: null, reason: null, resolution: null,
    chargeable: false, remarks: '', photoKeys: [], by: { id: 'des1', name: 'Meera' }, ...fields,
  });
  serve({
    money: false,
    events: [
      event({ id: 'e1', stage: 'materials_ready', action: 'start', at: '2026-11-14T05:00:00Z', workers: [{ id: 'w1', name: 'Ravi' }] }),
      event({ id: 'e2', stage: 'materials_ready', action: 'complete', at: '2026-11-14T08:12:00Z', remarks: 'Silk arrived' }),
    ],
  });
  renderApp('/orders/o1');
  await userEvent.click(await screen.findByRole('button', { name: 'History' }));
  const items = await screen.findAllByRole('listitem', { name: /Materials ready/ });
  expect(items.map((i) => i.getAttribute('aria-label'))).toEqual(['Materials ready done', 'Materials ready started']);
  expect(within(items[0]).getByText('Silk arrived')).toBeInTheDocument();
  expect(within(items[1]).getByText(/Ravi/)).toBeInTheDocument();
});

// --- Materials ready uses the planned materials -------------------------------------------------

const plannedCard = (garmentId, lines) => ({ garmentId, version: 1, lines });
const silkLine = (quantity = 2000) => materialLine({ planned: quantity, reserved: quantity });
const buttonsLine = () => materialLine({ stockItemId: 's2', name: 'Gold buttons', usageUnit: 'pcs', step: 1000, planned: 12000, reserved: 12000 });

test('completing Materials ready shows the planned materials and sends only corrections', async () => {
  asDesigner();
  const api = serve({ money: false });
  materialsAre({ cards: { g1: plannedCard('g1', [silkLine(), buttonsLine()]) } });
  renderApp('/orders/o1');
  await userEvent.click(await screen.findByRole('button', { name: 'Mark materials ready done' }));
  let dialog = await screen.findByRole('dialog');
  const used = await within(dialog).findByRole('group', { name: 'Materials used' });
  expect(await within(used).findByText('Red silk')).toBeInTheDocument();
  expect(within(used).getByText('2 m')).toBeInTheDocument();
  expect(within(used).getByText('12 pcs')).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await expect.poll(api.posted).toEqual({ action: 'complete', stage: 'materials_ready', garments: [{ id: 'g1', version: 0 }] });
  await expect.poll(() => screen.queryByRole('dialog')).toBeNull();

  await userEvent.click(await screen.findByRole('button', { name: 'Mark materials ready done' }));
  dialog = await screen.findByRole('dialog');
  const silk = (await within(dialog).findByText('Red silk')).closest('[data-material]');
  await userEvent.click(within(silk).getByRole('button', { name: 'Less' }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await expect.poll(() => api.posted().materialsUsed).toEqual([{ garmentId: 'g1', stockItemId: 's1', quantity: 1750 }]);
});

test('a bulk Materials ready applies one quantity to each garment', async () => {
  asDesigner();
  const order = orderDetailFixture({ money: false, garments: 3 });
  const rows = order.garments.map((garment) => ({
    garment,
    order: { id: order.id, orderNo: order.orderNo, pickupDate: order.pickupDate, priority: 'normal' },
    customer: order.customer,
    designer: order.designer,
    workingStage: workingStage(garment),
    late: false,
    nearlyReady: false,
    vendor: null,
  }));
  let posted;
  server.use(
    http.get('/v1/production/board', () => HttpResponse.json({ stages: STAGE_KEYS.slice(1, 13).map((stage) => ({ stage, inHouse: 0, withVendor: 0, late: 0 })) })),
    http.get('/v1/production/garments', () => HttpResponse.json({ items: rows, truncated: false })),
    http.get('/v1/workers', () => HttpResponse.json({ items: [] })),
    http.get('/v1/vendors', () => HttpResponse.json({ items: [] })),
    http.post('/v1/production/actions', async ({ request }) => {
      posted = await request.json();
      return HttpResponse.json({ garments: [] });
    }),
  );
  // Garments 1 and 2 have the same silk; the buttons differ between garments 1 and 3.
  materialsAre({
    cards: {
      g1: plannedCard('g1', [silkLine(), buttonsLine()]),
      g2: plannedCard('g2', [silkLine()]),
      g3: plannedCard('g3', [{ ...buttonsLine(), planned: 6000, reserved: 6000 }]),
    },
  });
  renderApp('/production');
  for (const i of [1, 2, 3]) await userEvent.click(await screen.findByRole('checkbox', { name: `Select VS/ORD/2627/0007-0${i}` }));
  const bar = screen.getByRole('region', { name: '3 garments selected' });
  await userEvent.click(within(bar).getByRole('button', { name: 'Mark materials ready done' }));
  const dialog = await screen.findByRole('dialog', { name: /3 garments/ });
  const silk = (await within(dialog).findByText('Red silk')).closest('[data-material]');
  expect(within(silk).getByText('each garment')).toBeInTheDocument();
  const buttons = within(dialog).getByText('Gold buttons').closest('[data-material]');
  expect(within(buttons).getByText('Materials as planned')).toBeInTheDocument();
  expect(within(buttons).queryByRole('button', { name: 'More' })).toBeNull();
  await userEvent.click(within(silk).getByRole('button', { name: 'More' }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await expect.poll(() => posted?.materialsUsed).toEqual([
    { garmentId: 'g1', stockItemId: 's1', quantity: 2250 },
    { garmentId: 'g2', stockItemId: 's1', quantity: 2250 },
  ]);
});

test('not enough stock explains what to do', async () => {
  asDesigner();
  serve({
    money: false,
    onPost: () => HttpResponse.json(
      { error: { code: 'STOCK_INSUFFICIENT', message: 'Not enough', details: { stockItemId: 's1', name: 'Red silk', free: 1500 } } },
      { status: 422 },
    ),
  });
  materialsAre({ cards: { g1: plannedCard('g1', [silkLine()]) } });
  renderApp('/orders/o1');
  await userEvent.click(await screen.findByRole('button', { name: 'Mark materials ready done' }));
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText('Red silk');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(await within(dialog).findByText('Only 1.5 m of Red silk is in stock. Receive the delivery first or change the quantity.')).toBeInTheDocument();
});

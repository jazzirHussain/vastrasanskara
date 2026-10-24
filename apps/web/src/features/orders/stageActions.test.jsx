import { test, expect } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { addDaysYmd } from '@vs/shared';
import { server, asDesigner, asOperations } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';
import { orderDetailFixture, todayYmd } from '../../test/orders.js';

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

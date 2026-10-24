import { test, expect } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { addDaysYmd } from '@vs/shared';
import { server, asOperations, asDesigner } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';
import { orderDetailFixture } from '../../test/orders.js';

function serve(order, onPatch = () => HttpResponse.json(order.garments[0])) {
  let gets = 0;
  let sent;
  server.use(
    http.get('/v1/orders/o1', () => { gets += 1; return HttpResponse.json(order); }),
    http.patch('/v1/garments/g1', async ({ request }) => { sent = await request.json(); return onPatch(); }),
  );
  return { sent: () => sent, gets: () => gets };
}

async function openEditor() {
  renderApp('/orders/o1');
  await userEvent.click(await screen.findByRole('button', { name: 'Edit garment' }));
  return screen.findByRole('dialog');
}

test('editing a garment sends only the changed fields, price in paise', async () => {
  asOperations();
  const order = orderDetailFixture();
  const api = serve(order);
  const dialog = await openEditor();
  const description = within(dialog).getByLabelText('Description');
  await userEvent.clear(description);
  await userEvent.type(description, 'Blouse, boat neck');
  const price = within(dialog).getByLabelText('Agreed price (₹)');
  await userEvent.clear(price);
  await userEvent.type(price, '5200');
  const due = addDaysYmd(order.pickupDate, -5);
  fireEvent.change(within(dialog).getByLabelText('Own due date'), { target: { value: due } });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save garment' }));
  await expect.poll(api.sent).toEqual({ version: 0, description: 'Blouse, boat neck', agreedPrice: 520000, dueDate: due });
});
test('clearing the own due date makes the garment follow the pickup date', async () => {
  asOperations();
  const order = orderDetailFixture();
  order.garments[0].dueDate = addDaysYmd(order.pickupDate, -5);
  order.garments[0].originalDueDate = order.garments[0].dueDate;
  const api = serve(order);
  const dialog = await openEditor();
  fireEvent.change(within(dialog).getByLabelText('Own due date'), { target: { value: '' } });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save garment' }));
  await expect.poll(api.sent).toEqual({ version: 0, dueDate: null });
});
test('a designer edits only design notes and photos', async () => {
  asDesigner();
  const api = serve(orderDetailFixture({ money: false }));
  const dialog = await openEditor();
  expect(within(dialog).queryByLabelText('Description')).toBeNull();
  expect(within(dialog).queryByLabelText(/Agreed price/)).toBeNull();
  expect(within(dialog).queryByLabelText('Own due date')).toBeNull();
  const notes = within(dialog).getByLabelText('Design notes');
  await userEvent.clear(notes);
  await userEvent.type(notes, 'Boat neck, deep back');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save garment' }));
  await expect.poll(api.sent).toEqual({ version: 0, designNotes: 'Boat neck, deep back' });
});
test('a garment edit conflict offers a reload', async () => {
  asOperations();
  const api = serve(orderDetailFixture(), () => HttpResponse.json({ error: { code: 'CONFLICT', message: 'x' } }, { status: 409 }));
  const dialog = await openEditor();
  await userEvent.type(within(dialog).getByLabelText('Fabric'), ' and lining');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save garment' }));
  const before = api.gets();
  await userEvent.click(await within(dialog).findByRole('button', { name: 'Reload' }));
  await expect.poll(api.gets).toBeGreaterThan(before);
});
test('a closed order has no garment editing', async () => {
  asOperations();
  serve(orderDetailFixture({ status: 'completed' }));
  renderApp('/orders/o1');
  expect(await screen.findByRole('heading', { name: 'VS/ORD/2627/0007', level: 1 })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Edit garment' })).toBeNull();
});

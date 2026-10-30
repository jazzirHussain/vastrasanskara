import { test, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server, asAdmin, asDesigner, asOperations } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';

const clothing = [
  { upToUnitPrice: 250000, rateBp: 500 },
  { upToUnitPrice: null, rateBp: 1800 },
];
const blouse = {
  id: 'i1',
  name: 'Blouse stitching',
  kind: 'stitching_service',
  supplyType: 'service',
  hsnSac: '998822',
  unit: 'PCS',
  defaultPrice: 120000,
  gstSlabs: clothing,
  garmentTypes: ['blouse'],
  chargeFor: null,
  active: true,
  version: 3,
};

function items(list = []) {
  server.use(http.get('/v1/catalog/items', () => HttpResponse.json({ items: list })));
}

test('adds a clothing item with the clothing preset', async () => {
  asAdmin();
  items();
  let body;
  server.use(
    http.post('/v1/catalog/items', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ ...blouse, ...body, id: 'new', version: 0 }, { status: 201 });
    }),
  );
  renderApp('/catalog');
  expect(await screen.findByText('No items yet. Add what you sell so bills fill in by themselves.')).toBeInTheDocument();
  expect(screen.getByText('Ask your accountant to confirm HSN/SAC codes and GST rates.')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Add item' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText('Name'), 'Bridal lehenga');
  await userEvent.type(within(dialog).getByLabelText('HSN/SAC code'), '6204');
  await userEvent.type(within(dialog).getByLabelText('Default price (₹)'), '45000');
  expect(within(dialog).getByText('Clothing (5% up to ₹2,500 a piece, 18% above)')).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save item' }));
  await expect
    .poll(() => body)
    .toEqual({
      name: 'Bridal lehenga',
      kind: 'garment',
      supplyType: 'goods',
      hsnSac: '6204',
      unit: 'PCS',
      defaultPrice: 4500000,
      gstSlabs: clothing,
      garmentTypes: [],
      chargeFor: null,
      active: true,
    });
});

test('a service needs a SAC starting 99', async () => {
  asAdmin();
  items();
  let posted = false;
  server.use(
    http.post('/v1/catalog/items', () => {
      posted = true;
      return HttpResponse.json(blouse, { status: 201 });
    }),
  );
  renderApp('/catalog');
  await userEvent.click(await screen.findByRole('button', { name: 'Add item' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText('Name'), 'Alteration');
  await userEvent.click(within(dialog).getByRole('radio', { name: 'Stitching' }));
  expect(within(dialog).getByRole('radio', { name: 'Service' })).toBeChecked();
  await userEvent.type(within(dialog).getByLabelText('HSN/SAC code'), '6204');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save item' }));
  expect(await within(dialog).findByText('SAC codes start with 99; goods use HSN codes')).toBeInTheDocument();
  expect(posted).toBe(false);
});

test('edits only what changed', async () => {
  asAdmin();
  items([blouse]);
  let patch;
  server.use(
    http.patch('/v1/catalog/items/:id', async ({ request }) => {
      patch = await request.json();
      return HttpResponse.json({ ...blouse, ...patch, version: 4 });
    }),
  );
  renderApp('/catalog');
  const row = (await screen.findByText('Blouse stitching')).closest('tr');
  expect(within(row).getByText('5% up to ₹2,500, then 18%')).toBeInTheDocument();
  expect(within(row).getByText('Service')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Edit Blouse stitching' }));
  const dialog = await screen.findByRole('dialog');
  const price = within(dialog).getByLabelText('Default price (₹)');
  await userEvent.clear(price);
  await userEvent.type(price, '1500');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save item' }));
  await expect.poll(() => patch).toEqual({ version: 3, defaultPrice: 150000 });
});

test('a garment type already mapped explains which item has it', async () => {
  asAdmin();
  items([blouse]);
  server.use(
    http.post('/v1/catalog/items', () =>
      HttpResponse.json(
        {
          error: {
            code: 'CATALOG_MAPPING_TAKEN',
            message: 'Another item already bills this',
            details: { itemId: 'i1', name: 'Blouse stitching' },
          },
        },
        { status: 422 },
      ),
    ),
  );
  renderApp('/catalog');
  await userEvent.click(await screen.findByRole('button', { name: 'Add item' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText('Name'), 'Fancy blouse');
  await userEvent.type(within(dialog).getByLabelText('HSN/SAC code'), '6206');
  await userEvent.click(within(dialog).getByLabelText('Bill these garment types with this item'));
  await userEvent.click(await screen.findByRole('option', { name: 'Blouse' }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save item' }));
  expect(await within(dialog).findByText('Blouse stitching already bills Blouse. Change that item first.')).toBeInTheDocument();
});

test('operations and designers do not see Price list', async () => {
  asOperations();
  const first = renderApp('/');
  expect(await screen.findByRole('link', { name: 'Orders' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Price list' })).toBeNull();
  first.unmount();
  asDesigner();
  renderApp('/');
  expect(await screen.findByRole('link', { name: 'Orders' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Price list' })).toBeNull();
});

import { test, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server, asDesigner, asOperations } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';

const ravi = { id: 'w1', name: 'Ravi', skill: 'Master tailor', phone: null, active: true, version: 0 };
const zari = { id: 'v1', name: 'Zari works', phone: null, gstin: null, stateCode: '29', services: ['Embroidery'], active: true, version: 2 };

function lists({ workers = [], vendors = [] } = {}) {
  server.use(
    http.get('/v1/workers', () => HttpResponse.json({ items: workers })),
    http.get('/v1/vendors', () => HttpResponse.json({ items: vendors })),
  );
}

test('adds a worker', async () => {
  asOperations();
  lists();
  let body;
  server.use(
    http.post('/v1/workers', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ ...ravi, ...body }, { status: 201 });
    }),
  );
  renderApp('/workshop');
  await userEvent.click(await screen.findByRole('button', { name: 'Add worker' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText('Name'), 'Ravi');
  await userEvent.type(within(dialog).getByLabelText('Skill'), 'Master tailor');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save worker' }));
  await expect.poll(() => body).toEqual({ name: 'Ravi', skill: 'Master tailor' });
});

test('edits a vendor sending only what changed', async () => {
  asOperations();
  lists({ vendors: [zari] });
  let patch;
  server.use(
    http.patch('/v1/vendors/:id', async ({ request }) => {
      patch = await request.json();
      return HttpResponse.json({ ...zari, ...patch, version: 3 });
    }),
  );
  renderApp('/workshop');
  await userEvent.click(await screen.findByRole('tab', { name: 'Vendors' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Edit Zari works' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText('Phone'), '9876543210');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save vendor' }));
  await expect.poll(() => patch).toEqual({ version: 2, phone: '9876543210' });
});

test('deactivating keeps the vendor in the list as inactive', async () => {
  asOperations();
  lists({ vendors: [{ ...zari, id: 'v2', name: 'Old dyers', active: false }, zari] });
  let patch;
  server.use(
    http.patch('/v1/vendors/:id', async ({ request }) => {
      patch = await request.json();
      return HttpResponse.json({ ...zari, ...patch });
    }),
  );
  renderApp('/workshop');
  await userEvent.click(await screen.findByRole('tab', { name: 'Vendors' }));
  const row = (await screen.findByText('Old dyers')).closest('tr');
  expect(within(row).getByText('Inactive')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Edit Zari works' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.click(within(dialog).getByLabelText('Active'));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save vendor' }));
  await expect.poll(() => patch).toEqual({ version: 2, active: false });
});

test('a vendor GSTIN sets its state code', async () => {
  asOperations();
  lists();
  let body;
  server.use(
    http.post('/v1/vendors', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ ...zari, ...body }, { status: 201 });
    }),
  );
  renderApp('/workshop');
  await userEvent.click(await screen.findByRole('tab', { name: 'Vendors' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Add vendor' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText('Name'), 'Dye house');
  await userEvent.type(within(dialog).getByLabelText('GSTIN'), '27abcde1234f1z5');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save vendor' }));
  await expect.poll(() => body).toEqual({ name: 'Dye house', gstin: '27ABCDE1234F1Z5', stateCode: '27', services: [] });
});

test('a conflict offers reload', async () => {
  asOperations();
  lists({ workers: [ravi] });
  server.use(http.patch('/v1/workers/:id', () => HttpResponse.json({ error: { code: 'CONFLICT' } }, { status: 409 })));
  renderApp('/workshop');
  await userEvent.click(await screen.findByRole('button', { name: 'Edit Ravi' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText('Skill'), ' and cutting');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save worker' }));
  expect(await within(dialog).findByText('Someone else changed this. Reload and try again.')).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Reload' }));
  await expect.poll(() => screen.queryByRole('dialog')).toBeNull();
});

test('designers do not see Workshop in the menu', async () => {
  asDesigner();
  renderApp('/');
  expect(await screen.findByRole('link', { name: 'Orders' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Workshop' })).toBeNull();
});

test('operations find Workshop in the menu', async () => {
  asOperations();
  renderApp('/');
  expect(await screen.findByRole('link', { name: 'Workshop' })).toBeInTheDocument();
});

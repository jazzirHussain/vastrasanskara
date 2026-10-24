import { test, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server, asOperations, customerFixture } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';

const noMeasurements = () =>
  server.use(
    http.get('/v1/customers/:id/measurements', () => HttpResponse.json({ items: [] })),
    http.get('/v1/orders', () => HttpResponse.json({ items: [], nextCursor: null })),
  );

test('adds a customer and opens their page', async () => {
  asOperations(); noMeasurements(); let sent;
  server.use(
    http.get('/v1/customers', () => HttpResponse.json({ items: [], nextCursor: null })),
    http.post('/v1/customers', async ({ request }) => { sent = await request.json(); return HttpResponse.json(customerFixture({ id: 'c9', name: sent.name }), { status: 201 }); }),
    http.get('/v1/customers/c9', () => HttpResponse.json(customerFixture({ id: 'c9', name: 'Asha Rao' }))),
  );
  renderApp('/customers');
  expect(await screen.findByText('No customers yet')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Add customer' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText('Name'), 'Asha Rao');
  await userEvent.type(within(dialog).getByLabelText('Phone'), '98765 43210');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save customer' }));
  expect(await screen.findByRole('heading', { name: 'Asha Rao', level: 1 })).toBeInTheDocument();
  expect(sent).toMatchObject({ name: 'Asha Rao', phone: '98765 43210' });
});
test('duplicate phone links to the existing customer', async () => {
  asOperations();
  server.use(
    http.get('/v1/customers', () => HttpResponse.json({ items: [], nextCursor: null })),
    http.post('/v1/customers', () => HttpResponse.json({ error: { code: 'PHONE_TAKEN', message: 'x', details: { customerId: 'c1' } } }, { status: 409 })),
  );
  renderApp('/customers');
  await userEvent.click(await screen.findByRole('button', { name: 'Add customer' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText('Name'), 'Asha');
  await userEvent.type(within(dialog).getByLabelText('Phone'), '9876543210');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save customer' }));
  expect(await within(dialog).findByText('A customer with this phone already exists.')).toBeInTheDocument();
  expect(within(dialog).getByRole('link', { name: 'Open their page' })).toHaveAttribute('href', '/customers/c1');
});
test('lists and searches customers', async () => {
  asOperations(); const queries = [];
  server.use(http.get('/v1/customers', ({ request }) => {
    queries.push(new URL(request.url).searchParams.get('q'));
    return HttpResponse.json({ items: [customerFixture()], nextCursor: null });
  }));
  renderApp('/customers');
  expect(await screen.findByText('Asha Rao')).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText('Search customers'), 'ash');
  await expect.poll(() => queries.at(-1)).toBe('ash');
});
test('measurement form shows the garment type\'s fields and sends numbers', async () => {
  asOperations(); noMeasurements(); let sent;
  server.use(
    http.get('/v1/customers/c1', () => HttpResponse.json(customerFixture())),
    http.post('/v1/customers/c1/measurements', async ({ request }) => { sent = await request.json(); return HttpResponse.json({ id: 'm1', customerId: 'c1', ...sent, takenBy: { id: 'ops1', name: 'Kavya' }, takenAt: '2026-10-24T06:00:00Z' }, { status: 201 }); }),
  );
  renderApp('/customers/c1');
  await userEvent.click(await screen.findByRole('button', { name: 'Take measurements' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.click(within(dialog).getByRole('textbox', { name: 'Garment type' }));
  await userEvent.click(await screen.findByRole('option', { name: 'Lehenga' }));
  expect(within(dialog).getByLabelText('Waist')).toBeInTheDocument();
  expect(within(dialog).getByLabelText('Hip')).toBeInTheDocument();
  expect(within(dialog).queryByLabelText('Bust')).toBeNull();
  await userEvent.type(within(dialog).getByLabelText('Waist'), '28.5');
  await userEvent.type(within(dialog).getByLabelText('Length'), '40');
  await userEvent.click(within(dialog).getByRole('radio', { name: 'cm' }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save measurements' }));
  await expect.poll(() => sent).toEqual({
    garmentType: 'lehenga',
    values: [{ name: 'Waist', value: 28.5, unit: 'cm' }, { name: 'Length', value: 40, unit: 'cm' }],
    notes: '',
  });
});
test('consent requires a note', async () => {
  asOperations(); let posted = false;
  server.use(
    http.get('/v1/customers', () => HttpResponse.json({ items: [], nextCursor: null })),
    http.post('/v1/customers', () => { posted = true; return HttpResponse.json(customerFixture(), { status: 201 }); }),
  );
  renderApp('/customers');
  await userEvent.click(await screen.findByRole('button', { name: 'Add customer' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText('Name'), 'Asha');
  await userEvent.type(within(dialog).getByLabelText('Phone'), '9876543210');
  await userEvent.click(within(dialog).getByLabelText('WhatsApp'));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save customer' }));
  expect(await within(dialog).findByText('Say how the customer gave consent')).toBeInTheDocument();
  expect(posted).toBe(false);
});

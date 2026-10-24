import { test, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server, asAdmin } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';
test('creates a user', async () => {
  asAdmin(); let body;
  server.use(http.get('/v1/users', () => HttpResponse.json({ items: [] })),
             http.post('/v1/users', async ({ request }) => { body = await request.json(); return HttpResponse.json({ id: 'n', ...body }, { status: 201 }); }));
  renderApp('/users');
  await userEvent.click(await screen.findByRole('button', { name: 'Add user' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText('Name'), 'Riya');
  await userEvent.type(within(dialog).getByLabelText('Email'), 'riya@x.com');
  await userEvent.click(within(dialog).getByLabelText('Designer'));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Create user' }));
  expect(body).toEqual({ name: 'Riya', email: 'riya@x.com', roles: ['designer'] });
});
test('shows server error', async () => {
  asAdmin();
  server.use(http.get('/v1/users', () => HttpResponse.json({ items: [] })),
             http.post('/v1/users', () => HttpResponse.json({ error: { code: 'EMAIL_TAKEN' } }, { status: 409 })));
  renderApp('/users');
  await userEvent.click(await screen.findByRole('button', { name: 'Add user' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText('Name'), 'R');
  await userEvent.type(within(dialog).getByLabelText('Email'), 'r@x.com');
  await userEvent.click(within(dialog).getByLabelText('Designer'));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Create user' }));
  expect(await within(dialog).findByText('A user with this email already exists.')).toBeInTheDocument();
});

const riya = { id: 'u2', name: 'Riya', email: 'riya@x.com', roles: ['designer'], active: true, createdAt: '2026-10-22T06:00:00Z' };

test('lists users and edits roles and active status', async () => {
  asAdmin(); let patch;
  server.use(http.get('/v1/users', () => HttpResponse.json({ items: [riya] })),
             http.patch('/v1/users/:id', async ({ request, params }) => { patch = { id: params.id, body: await request.json() }; return HttpResponse.json({ ...riya, ...patch.body }); }));
  renderApp('/users');
  const row = (await screen.findByText('riya@x.com')).closest('tr');
  expect(within(row).getByText('Designer')).toBeInTheDocument();
  expect(within(row).getByText('Active')).toBeInTheDocument();
  await userEvent.click(within(row).getByRole('button', { name: 'Edit Riya' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.click(within(dialog).getByLabelText('Operations'));
  await userEvent.click(within(dialog).getByLabelText('Active'));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
  await expect.poll(() => patch).toEqual({ id: 'u2', body: { roles: ['designer', 'operations'], active: false } });
});
test('edit errors such as LAST_ADMIN are shown in the dialog', async () => {
  asAdmin();
  server.use(http.get('/v1/users', () => HttpResponse.json({ items: [riya] })),
             http.patch('/v1/users/:id', () => HttpResponse.json({ error: { code: 'LAST_ADMIN' } }, { status: 422 })));
  renderApp('/users');
  await userEvent.click(await screen.findByRole('button', { name: 'Edit Riya' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.click(within(dialog).getByLabelText('Active'));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
  expect(await within(dialog).findByText('At least one active admin is required.')).toBeInTheDocument();
});
test('users without users.manage are told they have no access', async () => {
  server.use(http.get('/v1/auth/me', () => HttpResponse.json({ id: 'd', name: 'Dee', email: 'd@x.com', roles: ['designer'], permissions: ['production.update'] })));
  renderApp('/users');
  expect(await screen.findByText('You do not have access to this.')).toBeInTheDocument();
});

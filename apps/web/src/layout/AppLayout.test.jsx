import { test, expect } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../test/server.js';
import { renderApp } from '../test/setup.js';
test('designer sees no admin links; bell shows unread count', async () => {
  server.use(http.get('/v1/auth/me', () => HttpResponse.json({ id: '2', name: 'Riya', email: 'r@x.com', roles: ['designer'], permissions: ['production.update'] })),
             http.get('/v1/notifications', () => HttpResponse.json({ items: [], unreadCount: 3 })));
  renderApp('/');
  expect(await screen.findByText('Welcome, Riya')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Users' })).toBeNull();
  expect(await screen.findByLabelText('3 unread notifications')).toBeInTheDocument();
});

const admin = { id: '1', name: 'Owner', email: 'o@x.com', roles: ['admin'], permissions: ['users.manage', 'settings.edit'] };

test('admin sees admin links', async () => {
  server.use(http.get('/v1/auth/me', () => HttpResponse.json(admin)));
  renderApp('/');
  expect(await screen.findByRole('link', { name: 'Users' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
});
test('opening a notification marks it read', async () => {
  let read;
  server.use(
    http.get('/v1/auth/me', () => HttpResponse.json(admin)),
    http.get('/v1/notifications', () => HttpResponse.json({ items: [{ id: 'n1', event: 'system.job_failed', message: 'Backup failed', link: null, read: false, createdAt: '2026-10-22T06:00:00Z' }], unreadCount: 1 })),
    http.post('/v1/notifications/:id/read', ({ params }) => { read = params.id; return new HttpResponse(null, { status: 204 }); }),
  );
  renderApp('/');
  await userEvent.click(await screen.findByLabelText('1 unread notification'));
  await userEvent.click(await screen.findByText('Backup failed'));
  await expect.poll(() => read).toBe('n1');
});
test('logout returns to the login page', async () => {
  let loggedIn = true;
  server.use(
    http.get('/v1/auth/me', () => (loggedIn ? HttpResponse.json(admin) : HttpResponse.json({ error: { code: 'NOT_AUTHENTICATED' } }, { status: 401 }))),
    http.post('/v1/auth/logout', () => { loggedIn = false; return new HttpResponse(null, { status: 204 }); }),
  );
  renderApp('/');
  await userEvent.click(await screen.findByRole('button', { name: 'Log out' }));
  expect(await screen.findByRole('button', { name: 'Log in' })).toBeInTheDocument();
});

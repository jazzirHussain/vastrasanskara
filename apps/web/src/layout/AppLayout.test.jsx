import { test, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
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

function phoneWidth() {
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: /max-width/.test(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}
const operations = { id: '3', name: 'Kavya', email: 'k@x.com', roles: ['operations'], permissions: ['orders.read.own', 'orders.read.all', 'orders.write', 'customers.read', 'customers.write', 'money.view'] };
const designer = { id: '2', name: 'Riya', email: 'r@x.com', roles: ['designer'], permissions: ['orders.read.own', 'production.update', 'customers.read'] };

test('phone width shows the bottom bar with New order for operations, not for designers', async () => {
  phoneWidth();
  server.use(http.get('/v1/auth/me', () => HttpResponse.json(operations)));
  const { unmount } = renderApp('/');
  const bar = await screen.findByRole('navigation', { name: 'Main' });
  expect(within(bar).getByRole('link', { name: 'New order' })).toHaveAttribute('href', '/orders/new');
  expect(within(bar).getByRole('link', { name: 'Orders' })).toBeInTheDocument();
  expect(within(bar).getByRole('button', { name: 'More' })).toBeInTheDocument();
  unmount();

  server.use(http.get('/v1/auth/me', () => HttpResponse.json(designer)));
  renderApp('/');
  const designerBar = await screen.findByRole('navigation', { name: 'Main' });
  expect(within(designerBar).queryByRole('link', { name: 'New order' })).toBeNull();
  expect(within(designerBar).getByRole('link', { name: 'Customers' })).toBeInTheDocument();
  vi.restoreAllMocks();
});
test('desktop sidebar lists the pages the user may open', async () => {
  server.use(http.get('/v1/auth/me', () => HttpResponse.json(operations)));
  renderApp('/');
  const nav = await screen.findByRole('navigation', { name: 'Main' });
  expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['Home', 'Orders', 'Production', 'New order', 'Customers']);
});

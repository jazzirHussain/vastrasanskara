import { test, expect } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../test/server.js';
import { renderApp } from '../test/setup.js';
test('shows friendly error on bad credentials', async () => {
  server.use(http.get('/v1/auth/me', () => HttpResponse.json({ error: { code: 'NOT_AUTHENTICATED' } }, { status: 401 })),
             http.post('/v1/auth/login', () => HttpResponse.json({ error: { code: 'INVALID_CREDENTIALS' } }, { status: 401 })));
  renderApp('/login');
  await userEvent.type(await screen.findByLabelText('Email'), 'a@b.c');
  await userEvent.type(screen.getByLabelText('Password'), 'wrong-pass-1');
  await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
  expect(await screen.findByText('Email or password is incorrect.')).toBeInTheDocument();
});
test('redirects home after login', async () => {
  const me = { id: '1', name: 'Owner', email: 'o@x.com', roles: ['admin'], permissions: ['users.manage', 'settings.edit'] };
  let loggedIn = false;
  server.use(http.get('/v1/auth/me', () => loggedIn ? HttpResponse.json(me) : HttpResponse.json({ error: { code: 'NOT_AUTHENTICATED' } }, { status: 401 })),
             http.post('/v1/auth/login', () => { loggedIn = true; return HttpResponse.json({ user: me }); }));
  renderApp('/login');
  await userEvent.type(await screen.findByLabelText('Email'), 'o@x.com');
  await userEvent.type(screen.getByLabelText('Password'), 'correct-horse-1');
  await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
  expect(await screen.findByText('Welcome, Owner')).toBeInTheDocument();
});

test('a signed-out visitor to a protected page lands on login', async () => {
  renderApp('/');
  expect(await screen.findByRole('button', { name: 'Log in' })).toBeInTheDocument();
});

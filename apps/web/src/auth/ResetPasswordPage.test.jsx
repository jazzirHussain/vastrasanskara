import { test, expect } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server, asAnonymous } from '../test/server.js';
import { renderApp } from '../test/setup.js';
test('mismatch blocks submit; success confirms', async () => {
  asAnonymous(); let body;
  server.use(http.post('/v1/auth/password-reset/confirm', async ({ request }) => { body = await request.json(); return new HttpResponse(null, { status: 204 }); }));
  renderApp('/reset-password?token=abc');
  await userEvent.type(await screen.findByLabelText('New password'), 'brand-new-pass-1');
  await userEvent.type(screen.getByLabelText('Confirm password'), 'different-pass-1');
  await userEvent.click(screen.getByRole('button', { name: 'Set password' }));
  expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument();
  expect(body).toBeUndefined();
  await userEvent.clear(screen.getByLabelText('Confirm password'));
  await userEvent.type(screen.getByLabelText('Confirm password'), 'brand-new-pass-1');
  await userEvent.click(screen.getByRole('button', { name: 'Set password' }));
  expect(await screen.findByText('Password updated. You can now log in.')).toBeInTheDocument();
  expect(body).toEqual({ token: 'abc', password: 'brand-new-pass-1' });
});

test('an expired link shows the server message', async () => {
  asAnonymous();
  server.use(http.post('/v1/auth/password-reset/confirm', () => HttpResponse.json({ error: { code: 'RESET_TOKEN_INVALID' } }, { status: 400 })));
  renderApp('/reset-password?token=old');
  await userEvent.type(await screen.findByLabelText('New password'), 'brand-new-pass-1');
  await userEvent.type(screen.getByLabelText('Confirm password'), 'brand-new-pass-1');
  await userEvent.click(screen.getByRole('button', { name: 'Set password' }));
  expect(await screen.findByText('This reset link is invalid or has expired.')).toBeInTheDocument();
});
test('forgot password always confirms, and login links to it', async () => {
  asAnonymous(); let body;
  server.use(http.post('/v1/auth/password-reset/request', async ({ request }) => { body = await request.json(); return new HttpResponse(null, { status: 204 }); }));
  renderApp('/login');
  await userEvent.click(await screen.findByRole('link', { name: 'Forgot password?' }));
  await userEvent.type(await screen.findByLabelText('Email'), 'someone@x.com');
  await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
  expect(await screen.findByText('If that email has an account, a reset link has been sent.')).toBeInTheDocument();
  expect(body).toEqual({ email: 'someone@x.com' });
});

import { test, expect } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server, asAdmin, defaultSettings, defaultBranch } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';
test('saves bill due days and shows field errors', async () => {
  asAdmin(); let sent;
  server.use(http.get('/v1/settings', () => HttpResponse.json(defaultSettings)),
             http.put('/v1/settings', async ({ request }) => { sent = await request.json();
               return HttpResponse.json({ error: { code: 'VALIDATION_FAILED', details: [{ path: 'billDueDays', message: 'Too big' }] } }, { status: 400 }); }));
  renderApp('/settings');
  await userEvent.click(await screen.findByRole('tab', { name: 'Money' }));
  const input = screen.getByLabelText('Bill due days');
  await userEvent.clear(input); await userEvent.type(input, '400');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(sent.billDueDays).toBe(400);
  expect(await screen.findByText('Too big')).toBeInTheDocument();
});

const withBranch = () => server.use(
  http.get('/v1/settings', () => HttpResponse.json(defaultSettings)),
  http.get('/v1/branch', () => HttpResponse.json(defaultBranch)),
);

test('money: B2CL threshold is entered in rupees and saved in paise', async () => {
  asAdmin(); withBranch(); let sent;
  server.use(http.put('/v1/settings', async ({ request }) => { sent = await request.json(); return HttpResponse.json(sent); }));
  renderApp('/settings');
  await userEvent.click(await screen.findByRole('tab', { name: 'Money' }));
  const input = screen.getByLabelText('B2CL threshold (₹)');
  expect(input).toHaveValue('1,00,000');
  await userEvent.clear(input); await userEvent.type(input, '250000');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await expect.poll(() => sent?.b2clThreshold).toBe(25000000);
  expect(await screen.findByText('Settings saved.')).toBeInTheDocument();
});
test('production: default days per stage use the stage names', async () => {
  asAdmin(); withBranch(); let sent;
  server.use(http.put('/v1/settings', async ({ request }) => { sent = await request.json(); return HttpResponse.json(sent); }));
  renderApp('/settings');
  await userEvent.click(await screen.findByRole('tab', { name: 'Production' }));
  const handwork = screen.getByLabelText('Handwork (days)');
  await userEvent.clear(handwork); await userEvent.type(handwork, '9');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await expect.poll(() => sent?.stageDurations.default.handwork).toBe(9);
});
test('business: branch details save to /v1/branch', async () => {
  asAdmin(); withBranch(); let sent;
  server.use(http.put('/v1/branch', async ({ request }) => { sent = await request.json(); return HttpResponse.json({ ...defaultBranch, ...sent }); }));
  renderApp('/settings');
  const legal = await screen.findByLabelText('Legal name');
  expect(legal).toHaveValue('Vastrasanskara Pvt Ltd');
  await userEvent.type(screen.getByLabelText('GSTIN'), '29ABCDE1234F1Z5');
  await userEvent.click(screen.getByRole('button', { name: 'Save business details' }));
  await expect.poll(() => sent?.gstin).toBe('29ABCDE1234F1Z5');
  expect(sent.prefixes.invoice).toBe('INV');
});
test('saves only changed settings', async () => {
  asAdmin(); withBranch(); const bodies = [];
  server.use(http.put('/v1/settings', async ({ request }) => { const body = await request.json(); bodies.push(body); return HttpResponse.json({ ...defaultSettings, ...body }); }));
  renderApp('/settings');
  await userEvent.click(await screen.findByRole('tab', { name: 'Money' }));
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('No changes to save.')).toBeInTheDocument();
  expect(bodies).toHaveLength(0);
  const input = screen.getByLabelText('Bill due days');
  await userEvent.clear(input); await userEvent.type(input, '5');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toEqual({ billDueDays: 5 });
  expect(await screen.findByText('Settings saved.')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('No changes to save.')).toBeInTheDocument();
  expect(bodies).toHaveLength(1);
});

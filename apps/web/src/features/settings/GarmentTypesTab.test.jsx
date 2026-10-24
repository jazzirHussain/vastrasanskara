import { test, expect } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server, asAdmin, defaultSettings } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';

test('garment types tab adds a type with fields', { timeout: 20000 }, async () => {
  asAdmin(); let sent;
  server.use(http.put('/v1/settings', async ({ request }) => { sent = await request.json(); return HttpResponse.json({ ...defaultSettings, ...sent }); }));
  renderApp('/settings');
  await userEvent.click(await screen.findByRole('tab', { name: 'Garment types' }));
  expect(screen.getByDisplayValue('Blouse')).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText('New garment type'), 'Saree blouse');
  await userEvent.click(screen.getByRole('button', { name: 'Add garment type' }));
  await userEvent.type(screen.getByLabelText('Saree blouse measurements'), 'Bust{enter}Waist{enter}');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await expect.poll(() => sent?.garmentTypes?.at(-1)).toEqual({ key: 'saree_blouse', label: 'Saree blouse', measurementFields: ['Bust', 'Waist'] });
  expect(Object.keys(sent)).toEqual(['garmentTypes']);
});
test('stage overrides pick from the garment types', async () => {
  asAdmin(); let sent;
  server.use(http.put('/v1/settings', async ({ request }) => { sent = await request.json(); return HttpResponse.json({ ...defaultSettings, ...sent }); }));
  renderApp('/settings');
  await userEvent.click(await screen.findByRole('tab', { name: 'Production' }));
  await userEvent.click(screen.getByRole('textbox', { name: 'Garment type to override' }));
  await userEvent.click(await screen.findByRole('option', { name: 'Lehenga', hidden: true }));
  await userEvent.click(screen.getByRole('button', { name: 'Add override' }));
  await userEvent.type(screen.getByLabelText('Lehenga Handwork (days)'), '12');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await expect.poll(() => sent?.stageDurations?.byGarmentType).toEqual({ lehenga: { handwork: 12 } });
});

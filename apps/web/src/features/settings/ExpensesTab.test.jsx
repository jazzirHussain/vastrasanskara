import { test, expect } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server, asAdmin, defaultSettings } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';

async function open() {
  asAdmin();
  const puts = [];
  server.use(
    http.put('/v1/settings', async ({ request }) => {
      const body = await request.json();
      puts.push(body);
      return HttpResponse.json({ ...defaultSettings, ...body });
    }),
  );
  renderApp('/settings');
  await userEvent.click(await screen.findByRole('tab', { name: 'Expenses' }));
  return puts;
}

const labels = () => screen.getAllByRole('textbox', { name: /^Category name/ }).map((el) => el.value);

test('the default categories are listed', async () => {
  await open();
  expect(screen.getByDisplayValue('Rent')).toBeInTheDocument();
  expect(labels()).toHaveLength(defaultSettings.expenseCategories.length);
  expect(screen.getByText('Hidden categories stay on old expenses but are not offered for new ones.')).toBeInTheDocument();
});

test('a category can be renamed, hidden and moved', { timeout: 20000 }, async () => {
  const puts = await open();
  const rent = screen.getByRole('textbox', { name: 'Category name 1' });
  await userEvent.clear(rent);
  await userEvent.type(rent, 'Shop rent');
  await userEvent.click(screen.getByRole('switch', { name: 'Shop rent shown' }));
  await userEvent.click(screen.getByRole('button', { name: 'Move Shop rent down' }));
  expect(labels().slice(0, 2)).toEqual(['Electricity', 'Shop rent']);
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await expect.poll(() => puts[0]?.expenseCategories?.slice(0, 2)).toEqual([
    { key: 'electricity', label: 'Electricity', active: true },
    { key: 'rent', label: 'Shop rent', active: false },
  ]);
});

test('a new category gets a unique key', { timeout: 20000 }, async () => {
  const puts = await open();
  for (let i = 0; i < 2; i += 1) {
    await userEvent.type(screen.getByLabelText('New category'), i ? 'Gift & Decor' : 'Gift! Decor');
    await userEvent.click(screen.getByRole('button', { name: 'Add category' }));
  }
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await expect.poll(() => puts[0]?.expenseCategories?.slice(-2)).toEqual([
    { key: 'gift_decor', label: 'Gift! Decor', active: true },
    { key: 'gift_decor_2', label: 'Gift & Decor', active: true },
  ]);
});

test('there is no way to delete a category', async () => {
  await open();
  expect(screen.queryByRole('button', { name: /delete|remove/i })).toBeNull();
});

test('at least one category stays shown', { timeout: 30000 }, async () => {
  const puts = await open();
  server.use(
    http.put('/v1/settings', () =>
      HttpResponse.json(
        { error: { code: 'VALIDATION_FAILED', message: 'Invalid', details: [{ path: 'expenseCategories', message: 'Keep at least one category showing' }] } },
        { status: 400 },
      ),
    ),
  );
  for (const sw of screen.getAllByRole('switch')) await userEvent.click(sw);
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Keep at least one category showing')).toBeInTheDocument();
  expect(puts).toHaveLength(0);
});

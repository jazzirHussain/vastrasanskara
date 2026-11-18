import { test, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { formatINR } from '@vs/shared/money.js';
import { server, asDesigner } from '../../test/server.js';
import { asFrontDesk, asOwner } from '../../test/billing.js';
import { renderApp } from '../../test/setup.js';
import { dashboardFixture, dashboardIs, designerDashboard } from '../../test/dashboard.js';

const attention = () => screen.findByRole('region', { name: 'Needs attention today' });

test('Home shows what needs attention first, in plain sentences', async () => {
  asOwner();
  dashboardIs();
  renderApp('/');
  const list = await attention();
  const items = within(list).getAllByRole('link').map((a) => a.textContent);
  expect(items).toEqual([
    '3 garments are late',
    '2 fittings today',
    `2 bills are overdue — ${formatINR(4800000)}`,
    '1 garment is late back from a vendor',
    '1 follow-up call is due',
  ]);
  expect(within(list).getByRole('link', { name: '3 garments are late' })).toHaveAttribute('href', '/home/late_garments?preset=month');
  // Zero counts are left out.
  expect(within(list).queryByText(/on hold/)).toBeNull();
});

test('nothing to act on says so', async () => {
  asOwner();
  const body = dashboardFixture();
  for (const m of Object.values(body.tiles.attention.metrics)) m.count = 0;
  body.tiles.attention.metrics.overdue_bills.amount = 0;
  dashboardIs(body);
  renderApp('/');
  expect(await screen.findByText('Nothing needs you right now.')).toBeInTheDocument();
});

test('key numbers show the change against last month in words', async () => {
  asOwner();
  dashboardIs();
  renderApp('/');
  const numbers = await screen.findByRole('region', { name: 'Key numbers' });
  const billed = within(numbers).getByRole('link', { name: /^Billed/ });
  expect(billed).toHaveTextContent(formatINR(5240000));
  expect(billed).toHaveTextContent(`up ${formatINR(1240000)} vs last month`);
  expect(within(numbers).getByRole('link', { name: /^Collected/ })).toHaveTextContent('same as last month');
  expect(within(numbers).getByRole('link', { name: /^Orders placed/ })).toHaveTextContent('up 3 vs last month');
  expect(within(numbers).getByRole('link', { name: /^On time/ })).toHaveTextContent('80%');
  expect(billed).toHaveAttribute('href', '/home/billed?preset=month');
});

test('choosing This year asks for the year and keeps it in the address', async () => {
  asOwner();
  const queries = dashboardIs((q) => dashboardFixture({ filters: { preset: q.preset } }));
  renderApp('/');
  await attention();
  await userEvent.click(screen.getByRole('button', { name: 'This year' }));
  await screen.findByRole('button', { name: 'This year', pressed: true });
  expect(queries.at(-1)).toMatchObject({ preset: 'fy' });
  const numbers = await screen.findByRole('region', { name: 'Key numbers' });
  expect(within(numbers).getByRole('link', { name: /^Billed/ })).toHaveAttribute('href', '/home/billed?preset=fy');
  expect(within(numbers).getByRole('link', { name: /^Billed/ })).toHaveTextContent('vs last year');
});

test('custom dates are sent as from and to', async () => {
  asOwner();
  const queries = dashboardIs();
  renderApp('/');
  await attention();
  await userEvent.click(screen.getByRole('button', { name: 'Custom' }));
  await userEvent.type(screen.getByLabelText('From'), '2026-09-01');
  await userEvent.type(screen.getByLabelText('To'), '2026-09-30');
  await screen.findByRole('button', { name: 'Custom', pressed: true });
  await expect.poll(() => queries.at(-1)).toMatchObject({ preset: 'custom', from: '2026-09-01', to: '2026-09-30' });
});

test('filters show how many are on and are sent to the server', async () => {
  asOwner();
  server.use(http.get('/v1/designers', () => HttpResponse.json({ items: [{ id: 'des1', name: 'Meera' }] })));
  const queries = dashboardIs();
  renderApp('/');
  await attention();
  await userEvent.click(screen.getByRole('button', { name: 'Filters' }));
  const drawer = await screen.findByRole('dialog', { name: 'Filters' });
  await userEvent.click(within(drawer).getByRole('radio', { name: 'Rush' }));
  await userEvent.click(within(drawer).getByRole('radio', { name: 'Business' }));
  await userEvent.click(within(drawer).getByRole('button', { name: 'Show' }));
  expect(await screen.findByRole('button', { name: 'Filters (2 on)' })).toBeInTheDocument();
  await expect.poll(() => queries.at(-1)).toMatchObject({ preset: 'month', priority: 'rush', customerType: 'business' });
});

test('tapping a number opens its list', async () => {
  asOwner();
  dashboardIs();
  renderApp('/');
  const numbers = await screen.findByRole('region', { name: 'Key numbers' });
  expect(within(numbers).getByRole('link', { name: /^Active orders/ })).toHaveAttribute('href', '/home/active_orders?preset=month');
  const production = screen.getByRole('region', { name: 'Production' });
  expect(within(production).getByRole('link', { name: 'See all' })).toHaveAttribute('href', '/home/stage_garments?preset=month');
});

test('a tile that failed says so and the rest still show', async () => {
  asOwner();
  dashboardIs(dashboardFixture({ tiles: { money: { error: 'UNAVAILABLE' } } }));
  renderApp('/');
  const money = await screen.findByRole('region', { name: 'Money' });
  expect(within(money).getByText('Could not load this part. Tap Refresh to try again.')).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Production' })).toBeInTheDocument();
});

test('a filter a tile does not use is said on the tile', async () => {
  asOwner();
  const body = dashboardFixture();
  body.tiles.attention.notFilteredBy = ['customerType'];
  dashboardIs(body);
  renderApp('/?customerType=business');
  const list = await attention();
  expect(within(list).getByText('Not filtered by customer type')).toBeInTheDocument();
});

test('designers see their own production tiles and no money', async () => {
  asDesigner();
  dashboardIs(designerDashboard());
  renderApp('/');
  expect(await screen.findByRole('region', { name: 'Production' })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Pickups' })).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Money' })).toBeNull();
  expect(screen.queryByRole('button', { name: /^Filters/ })).toBeNull();
  expect(document.body.textContent).not.toContain('₹');
});

test('refresh asks for fresh figures', async () => {
  asOwner();
  const queries = dashboardIs();
  renderApp('/');
  await attention();
  expect(screen.getByText(/^Updated/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await expect.poll(() => queries.some((q) => q.fresh === '1')).toBe(true);
});

test('the quick buttons show by permission', async () => {
  asFrontDesk();
  dashboardIs();
  renderApp('/');
  expect(await screen.findByRole('link', { name: 'New enquiry' })).toHaveAttribute('href', '/enquiries/new');
  expect(screen.getByRole('link', { name: 'Book appointment' })).toHaveAttribute('href', '/appointments/new');
  expect(screen.getByRole('link', { name: 'Add expense' })).toHaveAttribute('href', '/expenses/new');
});

test('designers get no quick buttons', async () => {
  asDesigner();
  dashboardIs(designerDashboard());
  renderApp('/');
  await screen.findByRole('region', { name: 'Production' });
  for (const name of ['New enquiry', 'Book appointment', 'Add expense']) expect(screen.queryByRole('link', { name })).toBeNull();
});

test('follow-up calls due and today\'s appointments are on Home', async () => {
  asFrontDesk();
  dashboardIs();
  renderApp('/');
  const list = await attention();
  expect(within(list).getByRole('link', { name: '1 follow-up call is due' })).toHaveAttribute('href', '/home/follow_ups_due?preset=month');
  const calendar = screen.getByRole('region', { name: 'Today’s calendar' });
  expect(within(calendar).getByText('Meera')).toBeInTheDocument();
  expect(within(calendar).getByText('2 appointments')).toBeInTheDocument();
});

import { test, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { asOperations } from '../../test/server.js';
import { asOwner } from '../../test/billing.js';
import { renderApp } from '../../test/setup.js';
import { dashboardIs } from '../../test/dashboard.js';
import { checklist, goLiveServer } from '../../test/goLive.js';

const ALL_DONE = { numbers: 'done', imports: 'done', email: 'done' };

test('the checklist shows what is done and links to each place', async () => {
  asOwner();
  const seen = goLiveServer();
  renderApp('/go-live');
  expect(await screen.findByRole('heading', { name: 'Getting ready to go live', level: 1 })).toBeInTheDocument();
  expect(await screen.findByText('5 of 8 done')).toBeInTheDocument();
  const business = screen.getByRole('listitem', { name: 'Business details on bills' });
  expect(within(business).getByText('Done')).toBeInTheDocument();
  expect(within(business).getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/settings');
  const imports = screen.getByRole('listitem', { name: 'Old records brought in' });
  expect(within(imports).getByText('Not brought in: Stock, Open orders')).toBeInTheDocument();
  expect(within(imports).getByText('Check')).toBeInTheDocument();
  const email = screen.getByRole('listitem', { name: 'Email works' });
  expect(within(email).getByText('To do')).toBeInTheDocument();
  await userEvent.click(within(email).getByRole('button', { name: 'Send a test email' }));
  await expect.poll(() => seen.testEmails).toBe(1);
  expect(await within(email).findByText('A test email was sent')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'We are live' })).toBeDisabled();
});

test('continuing bill numbers shows the next number', async () => {
  asOwner();
  const seen = goLiveServer();
  renderApp('/go-live');
  const bills = await screen.findByRole('group', { name: 'GST bills' });
  expect(within(bills).getByLabelText('This is our first GST bill this year')).toBeChecked();
  expect(within(bills).getByText('Next: INV/2627/0001')).toBeInTheDocument();
  await userEvent.click(within(bills).getByLabelText('Continue after number'));
  await userEvent.type(within(bills).getByRole('textbox', { name: 'Last GST bill number' }), '123');
  expect(within(bills).getByText('Next: INV/2627/0124')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Save bill numbers' }));
  await expect.poll(() => seen.numbers).toEqual([{ series: { invoice: 123, credit_note: 0, receipt_voucher: 0, refund: 0, receipt: 0 } }]);
  expect(await screen.findByText('Next bill: INV/2627/0124')).toBeInTheDocument();
});

test('a series already in use shows its next number and cannot be changed', async () => {
  asOwner();
  const data = checklist();
  data.numbering.types[0] = { type: 'invoice', prefix: 'INV', start: 124, next: 125, used: true };
  const seen = goLiveServer(data);
  renderApp('/go-live');
  const bills = await screen.findByRole('group', { name: 'GST bills' });
  expect(within(bills).getByText('Already in use. Next: INV/2627/0125')).toBeInTheDocument();
  expect(within(bills).queryByRole('radio')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Save bill numbers' }));
  await expect.poll(() => seen.numbers[0]?.series.invoice).toBe(123);
});

test('we are live asks for confirmation and hides the banner', async () => {
  asOwner();
  dashboardIs();
  const seen = goLiveServer(checklist({ statuses: ALL_DONE }));
  renderApp('/go-live');
  expect(await screen.findByRole('link', { name: 'Go live' })).toBeInTheDocument();
  await userEvent.click(await screen.findByRole('button', { name: 'We are live' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('Staff will use the system from today. Keep the paper form for one more week as a backup.')).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Yes, we are live' }));
  await expect.poll(() => seen.live).toBe(1);
  expect(await screen.findByText(/Live since/)).toBeInTheDocument();
  await expect.poll(() => screen.queryByRole('link', { name: 'Go live' })).toBeNull();
  await userEvent.click(screen.getByRole('link', { name: 'Home' }));
  expect(await screen.findByRole('region', { name: 'Needs attention today' })).toBeInTheDocument();
  expect(screen.queryByText(/Getting ready to go live/)).not.toBeInTheDocument();
});

test('warnings only: going live anyway is allowed', async () => {
  asOwner();
  goLiveServer(checklist({ statuses: { numbers: 'done', email: 'done' } }));
  renderApp('/go-live');
  expect(await screen.findByRole('button', { name: 'Go live anyway' })).toBeEnabled();
});

test('the banner shows on Home for admins until live', async () => {
  asOwner();
  dashboardIs();
  goLiveServer();
  renderApp('/');
  const banner = await screen.findByRole('link', { name: 'Getting ready to go live: 5 of 8 done' });
  expect(banner).toHaveAttribute('href', '/go-live');
});

test('operations see no banner and no Go live menu', async () => {
  asOperations();
  dashboardIs();
  const seen = goLiveServer();
  renderApp('/');
  expect(await screen.findByRole('region', { name: 'Needs attention today' })).toBeInTheDocument();
  expect(screen.queryByText(/Getting ready to go live/)).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Go live' })).not.toBeInTheDocument();
  expect(seen.gets).toBe(0);
});

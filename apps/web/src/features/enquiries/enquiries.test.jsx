import { test, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { addDaysYmd } from '@vs/shared/fy.js';
import { asDesigner } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';
import { todayYmd } from '../../test/orders.js';
import { asFrontDesk } from '../../test/billing.js';
import { enquiriesAre, enquiryFixture, enquiryRow, tomorrowYmd } from '../../test/frontOffice.js';

afterEach(() => vi.restoreAllMocks());

test('saves a phone enquiry with one key', async () => {
  asFrontDesk();
  const seen = enquiriesAre();
  renderApp('/enquiries/new');
  const phone = await screen.findByLabelText('Phone');
  expect(phone).toHaveFocus();
  await userEvent.type(phone, '98450 12345');
  await userEvent.type(screen.getByLabelText('Name'), 'Priya Sharma');
  await userEvent.click(screen.getByRole('checkbox', { name: 'Lehenga' }));
  await userEvent.type(screen.getByLabelText('Budget (rough)'), '150000');
  await userEvent.click(screen.getByRole('radio', { name: 'Instagram' }));
  expect(screen.getByRole('radio', { name: 'Tomorrow' })).toBeChecked();
  await userEvent.click(screen.getByRole('button', { name: 'Save enquiry' }));
  await waitFor(() => expect(seen.posts).toHaveLength(1));
  expect(seen.posts[0].body).toEqual({
    name: 'Priya Sharma',
    phone: '98450 12345',
    garmentTypes: ['lehenga'],
    interest: '',
    budget: 15000000,
    source: 'instagram',
    occasionDate: null,
    followUpDate: tomorrowYmd(),
    note: '',
  });
  expect(seen.posts[0].key).toMatch(/[0-9a-f-]{36}/);
  expect(await screen.findByText('Enquiry saved')).toBeInTheDocument();
  expect(await screen.findByRole('heading', { name: 'Priya Sharma' })).toBeInTheDocument();
});

test("a known phone shows the customer's name", async () => {
  asFrontDesk();
  enquiriesAre({ check: () => ({ customer: { id: 'c1', name: 'Asha Rao' }, openEnquiry: null }) });
  renderApp('/enquiries/new');
  await userEvent.type(await screen.findByLabelText('Phone'), '9876543210');
  const link = await screen.findByRole('link', { name: 'Asha Rao' });
  expect(link).toHaveAttribute('href', '/customers/c1');
  expect(screen.getByText(/Already a customer/)).toBeInTheDocument();
});

test('an open enquiry for the phone blocks a duplicate and links to it', async () => {
  asFrontDesk();
  enquiriesAre({ check: () => ({ customer: null, openEnquiry: { id: 'e9', name: 'Priya', status: 'new' } }) });
  renderApp('/enquiries/new');
  await userEvent.type(await screen.findByLabelText('Phone'), '9845012345');
  await userEvent.type(screen.getByLabelText('Name'), 'Priya');
  expect(await screen.findByText(/Open enquiry: Priya/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save enquiry' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Open it' }));
  expect(await screen.findByRole('heading', { name: 'Priya Sharma' })).toBeInTheDocument();
});

test('follow-ups today are shown first with overdue ones marked', async () => {
  asFrontDesk();
  const seen = enquiriesAre({
    count: { count: 2, overdue: 1 },
    list: (params) =>
      params.get('view') === 'follow_ups'
        ? [enquiryRow({ id: 'e2', name: 'Late Lata', followUpDate: addDaysYmd(todayYmd(), -2), overdue: true }), enquiryRow()]
        : [],
  });
  renderApp('/enquiries');
  expect(await screen.findByRole('radio', { name: 'Follow-ups today (2)' })).toBeChecked();
  expect(await screen.findByText('Late Lata')).toBeInTheDocument();
  expect(seen.lists.at(-1).get('view')).toBe('follow_ups');
  const rows = screen.getAllByText(/Overdue/);
  expect(rows).toHaveLength(1);
  expect(screen.getAllByRole('link', { name: /98450 12345/ })[0]).toHaveAttribute('href', 'tel:+919845012345');
});

test('no calls due shows the open enquiries', async () => {
  asFrontDesk();
  const seen = enquiriesAre({ list: () => [] });
  renderApp('/enquiries');
  expect(await screen.findByRole('radio', { name: 'Open' })).toBeChecked();
  await waitFor(() => expect(seen.lists.at(-1)?.get('view')).toBe('open'));
  await userEvent.click(screen.getByRole('radio', { name: 'Follow-ups today (0)' }));
  expect(await screen.findByText('No calls due today.')).toBeInTheDocument();
});

test('logging a call sends the note and the next date', async () => {
  asFrontDesk();
  const seen = enquiriesAre({ one: enquiryFixture({ version: 4 }) });
  renderApp('/enquiries/e1');
  await userEvent.click(await screen.findByRole('button', { name: 'Log a call' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText('What did they say?'), 'Wants a lehenga by March');
  await userEvent.click(within(dialog).getByRole('radio', { name: 'In 3 days' }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save call' }));
  await waitFor(() => expect(seen.posts).toHaveLength(1));
  expect(seen.posts[0]).toMatchObject({
    path: '/v1/enquiries/e1/call',
    body: { version: 4, note: 'Wants a lehenga by March', followUpDate: addDaysYmd(todayYmd(), 3) },
  });
});

test('no more calls clears the call-back date', async () => {
  asFrontDesk();
  const seen = enquiriesAre();
  renderApp('/enquiries/e1');
  await userEvent.click(await screen.findByRole('button', { name: 'Log a call' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.click(within(dialog).getByRole('radio', { name: 'No more calls' }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save call' }));
  await waitFor(() => expect(seen.posts).toHaveLength(1));
  expect(seen.posts[0].body).toEqual({ version: 0, note: '', followUpDate: null });
});

test('not interested needs a reason', async () => {
  asFrontDesk();
  const seen = enquiriesAre();
  renderApp('/enquiries/e1');
  await userEvent.click(await screen.findByRole('button', { name: 'Not interested' }));
  const dialog = await screen.findByRole('dialog');
  const confirm = within(dialog).getByRole('button', { name: 'Mark not interested' });
  expect(confirm).toBeDisabled();
  await userEvent.click(within(dialog).getByRole('radio', { name: 'Other' }));
  expect(confirm).toBeDisabled();
  await userEvent.type(within(dialog).getByLabelText('What happened?'), 'Moved abroad');
  await userEvent.click(within(dialog).getByRole('radio', { name: 'Too expensive' }));
  expect(confirm).toBeEnabled();
  await userEvent.click(confirm);
  await waitFor(() => expect(seen.posts).toHaveLength(1));
  expect(seen.posts[0]).toMatchObject({ path: '/v1/enquiries/e1/lost', body: { version: 0, reason: 'Too expensive' } });
});

test('a lost enquiry can be reopened', async () => {
  asFrontDesk();
  const seen = enquiriesAre({ one: enquiryFixture({ status: 'lost', isOpen: false, lostReason: 'Plans changed', version: 2 }) });
  renderApp('/enquiries/e1');
  expect(await screen.findByText(/Plans changed/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Log a call' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Reopen' }));
  await waitFor(() => expect(seen.posts).toHaveLength(1));
  expect(seen.posts[0]).toMatchObject({ path: '/v1/enquiries/e1/reopen', body: { version: 2 } });
});

test('the enquiry page shows the details and the log, newest first', async () => {
  asFrontDesk();
  enquiriesAre({
    one: enquiryFixture({
      log: [
        { at: '2026-11-08T05:00:00Z', by: { id: 'ops1', name: 'Kavya' }, kind: 'note', text: 'Saw the reel' },
        { at: '2026-11-09T05:00:00Z', by: { id: 'ops1', name: 'Kavya' }, kind: 'call', text: 'Wants a lehenga by March' },
      ],
    }),
  });
  renderApp('/enquiries/e1');
  expect(await screen.findByRole('link', { name: /Call/ })).toHaveAttribute('href', 'tel:+919845012345');
  expect(screen.getByText('₹1,50,000.00')).toBeInTheDocument();
  expect(screen.getByText('Instagram')).toBeInTheDocument();
  const log = screen.getByRole('list', { name: 'What happened' });
  expect(within(log).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
    expect.stringContaining('Called — Wants a lehenga by March'),
    expect.stringContaining('Note — Saw the reel'),
  ]);
});

test('designers have no Enquiries menu and are sent away from /enquiries', async () => {
  asDesigner();
  renderApp('/enquiries');
  expect(await screen.findByText('You do not have access to this.')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Enquiries' })).toBeNull();
});

test('front desk finds Enquiries in the menu', async () => {
  asFrontDesk();
  enquiriesAre();
  renderApp('/enquiries');
  expect((await screen.findAllByRole('link', { name: 'Enquiries' })).length).toBeGreaterThan(0);
});

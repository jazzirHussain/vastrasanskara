import { test, expect, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';
import { asFrontDesk } from '../../test/billing.js';
import { enquiriesAre, enquiryFixture } from '../../test/frontOffice.js';

beforeEach(() => {
  sessionStorage.clear();
  server.use(
    http.get('/v1/designers', () => HttpResponse.json({ items: [{ id: 'd1', name: 'Meera' }] })),
    http.get('/v1/customers/:id/measurements/latest', () => HttpResponse.json({})),
  );
});

test('a known phone offers the existing customer', async () => {
  asFrontDesk();
  const seen = enquiriesAre({ check: () => ({ customer: { id: 'c1', name: 'Asha Rao' }, openEnquiry: null }) });
  renderApp('/enquiries/e1');
  await userEvent.click(await screen.findByRole('button', { name: 'Convert to order' }));
  const dialog = await screen.findByRole('dialog');
  expect(await within(dialog).findByText('Asha Rao already has this phone. Is this the same person?')).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: 'No, this is someone else' }));
  expect(within(dialog).getByText(/Two customers cannot share a phone/)).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Yes, use Asha Rao' }));
  await waitFor(() => expect(seen.posts).toHaveLength(1));
  expect(seen.posts[0]).toMatchObject({ path: '/v1/enquiries/e1/convert', body: { version: 0, customerId: 'c1' } });
  expect(await screen.findByText('From enquiry: Priya Sharma')).toBeInTheDocument();
});

test('a new caller becomes a customer and opens New order', async () => {
  asFrontDesk();
  const seen = enquiriesAre();
  renderApp('/enquiries/e1');
  await userEvent.click(await screen.findByRole('button', { name: 'Convert to order' }));
  const dialog = await screen.findByRole('dialog');
  expect(await within(dialog).findByText("We'll add Priya Sharma as a customer.")).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(seen.posts).toHaveLength(1));
  expect(seen.posts[0].body).toEqual({ version: 0, customerId: null });
  expect(await screen.findByText('From enquiry: Priya Sharma')).toBeInTheDocument();
  expect(screen.getByText('Priya Sharma', { selector: 'p' })).toBeInTheDocument();
});

test('an enquiry with a customer goes straight to the order', async () => {
  asFrontDesk();
  const seen = enquiriesAre({ one: enquiryFixture({ convertedCustomer: { id: 'c9', name: 'Priya Sharma', phone: '+919845012345' } }) });
  renderApp('/enquiries/e1');
  expect(await screen.findByText('Customer ready — continue to order')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Continue to order' }));
  expect(await screen.findByText('From enquiry: Priya Sharma')).toBeInTheDocument();
  expect(seen.posts).toHaveLength(0);
});

import { test, expect, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { addDaysYmd, istDate } from '@vs/shared';
import { server, asOperations, asDesigner, customerFixture } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';
import { materialsAre } from '../../test/stock.js';
import { asFrontDesk } from '../../test/billing.js';
import { DRAFT_KEY, garmentsReady } from './NewOrderPage.jsx';
import { canAddGarment } from './new/GarmentsStep.jsx';

const today = () => istDate(new Date());
const designers = () => server.use(http.get('/v1/designers', () => HttpResponse.json({ items: [{ id: 'd1', name: 'Meera' }, { id: 'd2', name: 'Nila' }] })));
const latest = (body = {}) => server.use(http.get('/v1/customers/:id/measurements/latest', () => HttpResponse.json(body)));
const taken = (capture) =>
  server.use(http.post('/v1/orders', async ({ request }) => {
    capture?.(await request.json(), request.headers.get('Idempotency-Key'));
    return HttpResponse.json({ id: 'o1', orderNo: 'VS/ORD/2627/0007' }, { status: 201 });
  }));

const draft = (fields) => ({
  step: 3,
  idempotencyKey: 'key-from-draft',
  customer: { id: 'c1', name: 'Asha Rao', phone: '+919876543210' },
  designerId: 'd1',
  priority: 'normal',
  garments: [{ uid: 'g1', type: 'blouse', description: 'Bridal blouse', fabric: '', designNotes: '', price: 4500, quantity: 1, dueDate: '', referenceKeys: [] }],
  pickupDate: addDaysYmd(today(), 30),
  occasionDate: '',
  notes: '',
  expectedBudget: '',
  ...fields,
});

beforeEach(() => sessionStorage.clear());

test('takes an order with a batch and a tight plan', async () => {
  asOperations(); designers(); latest(); let body;
  taken((b) => { body = b; });
  server.use(http.get('/v1/customers', () => HttpResponse.json({ items: [customerFixture()], nextCursor: null })));
  renderApp('/orders/new');

  // 1 Customer
  await userEvent.type(await screen.findByLabelText('Find a customer'), 'Asha');
  await userEvent.click(await screen.findByRole('button', { name: /Asha Rao/ }));
  await userEvent.click(await screen.findByRole('radio', { name: 'Meera' }));
  await userEvent.click(screen.getByRole('button', { name: 'Next: garments' }));

  // 2 Garments
  await userEvent.selectOptions(await screen.findByLabelText('Garment type'), 'kurta');
  await userEvent.type(screen.getByLabelText('Description'), 'Film extra kurta');
  await userEvent.type(screen.getByLabelText('Price per piece (₹)'), '1200');
  const quantity = screen.getByLabelText('Identical pieces');
  await userEvent.clear(quantity);
  await userEvent.type(quantity, '3');
  expect(screen.getByText('A batch of 3 identical pieces')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Next: dates' }));

  // 3 Dates
  fireEvent.change(await screen.findByLabelText('Pickup date'), { target: { value: addDaysYmd(today(), 3) } });
  expect(await screen.findByText('Tight schedule')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Next: review' }));

  // 4 Review
  expect(await screen.findAllByText('₹3,600.00')).toHaveLength(2); // the line and the total
  await userEvent.click(screen.getByRole('button', { name: 'Take order' }));
  expect(await screen.findByText('Order VS/ORD/2627/0007 taken')).toBeInTheDocument();
  expect(body).toMatchObject({
    customerId: 'c1',
    designerId: 'd1',
    pickupDate: addDaysYmd(today(), 3),
    garments: [{ type: 'kurta', description: 'Film extra kurta', agreedPrice: 120000, quantity: 3, measurementId: null }],
  });
  expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull();
});
test('retrying after a network error reuses the idempotency key', async () => {
  asOperations(); designers(); latest();
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft()));
  const keys = [];
  let calls = 0;
  server.use(http.post('/v1/orders', ({ request }) => {
    keys.push(request.headers.get('Idempotency-Key'));
    calls += 1;
    return calls === 1 ? HttpResponse.error() : HttpResponse.json({ id: 'o1', orderNo: 'VS/ORD/2627/0008' }, { status: 201 });
  }));
  renderApp('/orders/new');
  await userEvent.click(await screen.findByRole('button', { name: 'Take order' }));
  expect(await screen.findByText(/Cannot reach the server/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Take order' }));
  expect(await screen.findByText('Order VS/ORD/2627/0008 taken')).toBeInTheDocument();
  expect(keys).toEqual(['key-from-draft', 'key-from-draft']);
});
test('measurements pre-fill from the latest set', async () => {
  asOperations(); designers(); let body;
  latest({ blouse: { id: 'm1', garmentType: 'blouse', values: [{ name: 'Bust', value: 34, unit: 'in' }], takenAt: '2026-10-24T06:00:00Z', takenBy: { id: 'u', name: 'Kavya' }, notes: '' } });
  taken((b) => { body = b; });
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft({ step: 1 })));
  renderApp('/orders/new');
  expect(await screen.findByText(/Measurements taken Sat 24 Oct/)).toBeInTheDocument();
  expect(screen.getByText('Bust 34″')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Next: dates' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Next: review' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Take order' }));
  await expect.poll(() => body?.garments[0].measurementId).toBe('m1');
});
test('review shows the garments and errors from the server', async () => {
  asOperations(); designers(); latest();
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft()));
  server.use(http.post('/v1/orders', () => HttpResponse.json({ error: { code: 'PICKUP_IN_PAST', message: 'x' } }, { status: 422 })));
  renderApp('/orders/new');
  const review = await screen.findByRole('region', { name: 'Review' });
  expect(within(review).getByText('Bridal blouse')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Take order' }));
  expect(await screen.findByText('Pickup date cannot be in the past.')).toBeInTheDocument();
});
test('designers cannot open new order', async () => {
  asDesigner();
  renderApp('/orders/new');
  expect(await screen.findByText('You do not have access to this.')).toBeInTheDocument();
});
test('a retry with a changed order warns that it may already be taken', async () => {
  asOperations(); designers(); latest();
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft()));
  server.use(http.post('/v1/orders', () => HttpResponse.json({ error: { code: 'IDEMPOTENCY_KEY_REUSED', message: 'This Idempotency-Key was used for a different request' } }, { status: 422 })));
  renderApp('/orders/new');
  await userEvent.click(await screen.findByRole('button', { name: 'Take order' }));
  expect(await screen.findByText('This order may already have been taken. Check Orders before trying again.')).toBeInTheDocument();
  expect(screen.queryByText(/Idempotency-Key/)).toBeNull();
});
test('changing the customer drops measurements taken for the previous one', async () => {
  asOperations(); designers(); latest(); let body;
  taken((b) => { body = b; });
  server.use(http.get('/v1/customers', () => HttpResponse.json({ items: [customerFixture({ id: 'c2', name: 'Bhavna Iyer', phone: '+919000011111' })], nextCursor: null })));
  const g = draft().garments[0];
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft({ step: 0, garments: [{ ...g, measurementId: 'm-old', chosenMeasurement: { id: 'm-old', values: [], takenAt: '2026-10-24T06:00:00Z' } }] })));
  renderApp('/orders/new');
  await userEvent.click(await screen.findByRole('button', { name: 'Change customer' }));
  await userEvent.type(screen.getByLabelText('Find a customer'), 'Bha');
  await userEvent.click(await screen.findByRole('button', { name: /Bhavna Iyer/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Next: garments' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Next: dates' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Next: review' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Take order' }));
  await expect.poll(() => body?.customerId).toBe('c2');
  expect(body.garments[0].measurementId).toBeNull();
});
test('a phone already on file in the add-customer drawer offers that customer', async () => {
  asOperations(); designers(); latest();
  server.use(
    http.post('/v1/customers', () => HttpResponse.json({ error: { code: 'PHONE_TAKEN', message: 'x', details: { customerId: 'c2' } } }, { status: 409 })),
    http.get('/v1/customers', () => HttpResponse.json({ items: [], nextCursor: null })),
    http.get('/v1/customers/c2', () => HttpResponse.json(customerFixture({ id: 'c2', name: 'Bhavna Iyer', phone: '+919000011111' }))),
  );
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft({ step: 0, customer: null })));
  renderApp('/orders/new');
  await userEvent.click(await screen.findByRole('button', { name: 'Add new customer' }));
  const drawer = await screen.findByRole('dialog');
  await userEvent.type(within(drawer).getByLabelText('Name'), 'Bhavna');
  await userEvent.type(within(drawer).getByLabelText('Phone'), '9000011111');
  await userEvent.click(within(drawer).getByRole('button', { name: 'Save customer' }));
  expect(within(drawer).queryByRole('link', { name: 'Open their page' })).toBeNull();
  await userEvent.click(await within(drawer).findByRole('button', { name: 'Use this customer' }));
  expect(await screen.findByText('Bhavna Iyer')).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});
test('a batch above 200 pieces cannot go on to dates', async () => {
  asOperations(); designers(); latest();
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft({ step: 1, garments: [{ ...draft().garments[0], quantity: 201 }] })));
  renderApp('/orders/new');
  expect(await screen.findByRole('button', { name: 'Next: dates' })).toBeDisabled();
  expect(screen.getByText('At most 200 identical pieces per garment.')).toBeInTheDocument();
});
test('an order holds at most 50 garment lines', () => {
  // Fifty rendered garment panels take over 30 s in jsdom under the full suite, so the rule is tested directly.
  const g = draft().garments[0];
  const lines = (n) => Array.from({ length: n }, (_, i) => ({ ...g, uid: `g${i}` }));
  expect(canAddGarment(lines(49))).toBe(true);
  expect(canAddGarment(lines(50))).toBe(false);
  expect(garmentsReady(lines(50))).toBe(true);
  expect(garmentsReady(lines(51))).toBe(false);
});

test('materials chosen for a garment line are sent with the order in milli-units', async () => {
  asFrontDesk(); designers(); latest(); materialsAre(); let body;
  taken((b) => { body = b; });
  const [g] = draft().garments;
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft({ step: 1, garments: [{ ...g, quantity: 20 }] })));
  renderApp('/orders/new');
  const garment = await screen.findByRole('region', { name: 'Garment 1' });
  await userEvent.click(within(garment).getByRole('button', { name: 'Materials (optional)' }));
  expect(within(garment).getByText('Each of the 20 garments gets these')).toBeInTheDocument();
  await userEvent.click(within(garment).getByRole('button', { name: 'Add material' }));
  await userEvent.click(await within(garment).findByRole('button', { name: 'Red silk · Raw silk — 8.5 m free' }));
  for (let i = 0; i < 3; i += 1) await userEvent.click(within(garment).getByRole('button', { name: 'More' }));
  await userEvent.click(screen.getByRole('button', { name: 'Next: dates' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Next: review' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Take order' }));
  await screen.findByText('Order VS/ORD/2627/0007 taken');
  expect(body.garments[0].materials).toEqual([{ stockItemId: 's1', quantity: 1000 }]);
});

const fromEnquiry = (fields = {}) =>
  server.use(
    http.get('/v1/enquiries/e1', () =>
      HttpResponse.json({
        enquiry: {
          id: 'e1',
          name: 'Priya Sharma',
          phone: '+919845012345',
          garmentTypes: ['lehenga', 'blouse'],
          interest: 'Bridal, red',
          budget: 15000000,
          source: 'instagram',
          occasionDate: addDaysYmd(today(), 90),
          followUpDate: null,
          status: 'contacted',
          isOpen: true,
          lostReason: null,
          enquiryDate: today(),
          convertedCustomer: { id: 'c9', name: 'Priya Sharma', phone: '+919845012345' },
          convertedOrder: null,
          log: [],
          createdAt: '2026-11-08T05:00:00Z',
          version: 1,
          ...fields,
        },
      }),
    ),
  );

test('an order from an enquiry starts with the customer, budget, occasion and garment types filled in', async () => {
  asFrontDesk(); designers(); latest(); fromEnquiry();
  renderApp('/orders/new?enquiry=e1');
  expect(await screen.findByText('From enquiry: Priya Sharma')).toBeInTheDocument();
  expect(screen.getByText('Priya Sharma', { selector: 'p' })).toBeInTheDocument();
  const saved = JSON.parse(sessionStorage.getItem(DRAFT_KEY));
  expect(saved).toMatchObject({
    enquiryId: 'e1',
    customer: { id: 'c9', name: 'Priya Sharma', phone: '+919845012345' },
    expectedBudget: '150000',
    occasionDate: addDaysYmd(today(), 90),
    notes: 'Bridal, red',
  });
  await userEvent.click(await screen.findByRole('radio', { name: 'Meera' }));
  await userEvent.click(screen.getByRole('button', { name: 'Next: garments' }));
  const types = await screen.findAllByLabelText('Garment type');
  expect(types.map((t) => t.value)).toEqual(['lehenga', 'blouse']);
});

test('the order is sent with the enquiry id', async () => {
  asFrontDesk(); designers(); latest(); let body;
  taken((b) => { body = b; });
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft({ enquiryId: 'e1', enquiryName: 'Priya Sharma' })));
  renderApp('/orders/new');
  expect(await screen.findByText('From enquiry: Priya Sharma')).toBeInTheDocument();
  await userEvent.click(await screen.findByRole('button', { name: 'Take order' }));
  await waitFor(() => expect(body).toBeTruthy());
  expect(body.enquiryId).toBe('e1');
});

test('"Not from an enquiry" drops the link', async () => {
  asFrontDesk(); designers(); latest(); let body;
  taken((b) => { body = b; });
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft({ enquiryId: 'e1', enquiryName: 'Priya Sharma' })));
  renderApp('/orders/new');
  await userEvent.click(await screen.findByRole('button', { name: 'Not from an enquiry' }));
  expect(screen.queryByText('From enquiry: Priya Sharma')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Take order' }));
  await waitFor(() => expect(body).toBeTruthy());
  expect(body.enquiryId).toBeNull();
});

test('an order without an enquiry sends enquiryId null', async () => {
  asFrontDesk(); designers(); latest(); let body;
  taken((b) => { body = b; });
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft()));
  renderApp('/orders/new');
  await userEvent.click(await screen.findByRole('button', { name: 'Take order' }));
  await waitFor(() => expect(body).toBeTruthy());
  expect(body.enquiryId).toBeNull();
  expect(screen.queryByText(/From enquiry/)).toBeNull();
});

test('a saved draft for the same enquiry is kept', async () => {
  asFrontDesk(); designers(); latest(); fromEnquiry();
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft({ enquiryId: 'e1', enquiryName: 'Priya Sharma', notes: 'Kept' })));
  renderApp('/orders/new?enquiry=e1');
  expect(await screen.findByRole('button', { name: 'Take order' })).toBeInTheDocument();
  expect(JSON.parse(sessionStorage.getItem(DRAFT_KEY)).notes).toBe('Kept');
});

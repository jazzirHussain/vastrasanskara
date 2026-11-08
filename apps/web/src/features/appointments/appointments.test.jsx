import { test, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { appointmentWhen, atIstTime } from '@vs/shared';
import { server, asDesigner, customerFixture } from '../../test/server.js';
import { renderApp } from '../../test/setup.js';
import { orderDetailFixture, todayYmd } from '../../test/orders.js';
import { asFrontDesk } from '../../test/billing.js';
import {
  appointmentFixture,
  appointmentsAre,
  dayFixture,
  designersAre,
  enquiriesAre,
  tomorrowYmd,
} from '../../test/frontOffice.js';

afterEach(() => vi.restoreAllMocks());

const T = tomorrowYmd();
const meeraDay = (appointments = [], date = T) =>
  dayFixture(date, [
    { id: 'des1', name: 'Meera', appointments },
    { id: 'des2', name: 'Nila', appointments: [] },
  ]);

test('books a consultation for an enquiry with one key', async () => {
  asFrontDesk();
  designersAre();
  enquiriesAre();
  const seen = appointmentsAre({ day: () => meeraDay([appointmentFixture({ time: '10:00' })]) });
  renderApp(`/appointments/new?enquiryId=e1&designerId=des1&date=${T}`);
  expect(await screen.findByText('Priya Sharma')).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: 'Consultation' })).toBeChecked();
  expect(screen.getByRole('radio', { name: 'Meera' })).toBeChecked();
  expect(screen.getByText('60 minutes')).toBeInTheDocument();
  // 10:00 is taken by Meera's 10:00–11:00.
  expect(await screen.findByRole('radio', { name: '11:00 am' })).toBeInTheDocument();
  expect(screen.queryByRole('radio', { name: '10:00 am' })).toBeNull();
  await userEvent.click(screen.getByRole('radio', { name: '11:00 am' }));
  const when = appointmentWhen(atIstTime(T, '11:00'));
  await userEvent.click(screen.getByRole('button', { name: `Book for ${when}` }));
  await waitFor(() => expect(seen.posts).toHaveLength(1));
  expect(seen.posts[0].body).toEqual({
    type: 'consultation',
    designerId: 'des1',
    customerId: null,
    enquiryId: 'e1',
    date: T,
    time: '11:00',
    minutes: 60,
    garmentIds: [],
    note: '',
  });
  expect(seen.posts[0].key).toMatch(/[0-9a-f-]{36}/);
  expect(await screen.findByText('Booked')).toBeInTheDocument();
});

test('a fitting from a garment preselects the customer, designer and garment', async () => {
  asFrontDesk();
  designersAre();
  appointmentsAre({ day: () => meeraDay() });
  const order = orderDetailFixture({ garments: 2 });
  server.use(
    http.get('/v1/customers/c1', () => HttpResponse.json(customerFixture())),
    http.get('/v1/orders/o1', () => HttpResponse.json(order)),
  );
  const [g1] = order.garments;
  renderApp(`/appointments/new?type=fitting&customerId=c1&designerId=des1&orderId=o1&garmentId=${g1.id}`);
  expect(await screen.findByText('Asha Rao')).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: 'Fitting' })).toBeChecked();
  expect(screen.getByRole('radio', { name: 'Meera' })).toBeChecked();
  expect(screen.getByText('45 minutes')).toBeInTheDocument();
  const boxes = await screen.findAllByRole('checkbox');
  expect(boxes).toHaveLength(2);
  expect(boxes[0]).toBeChecked();
  expect(boxes[1]).not.toBeChecked();
});

test('a garment at trials offers Book a fitting', async () => {
  asFrontDesk();
  const order = orderDetailFixture();
  order.garments[0].currentStage = 'trials_fittings';
  server.use(http.get('/v1/orders/o1', () => HttpResponse.json(order)));
  renderApp('/orders/o1');
  const link = await screen.findByRole('link', { name: 'Book a fitting' });
  expect(link.getAttribute('href')).toBe(
    `/appointments/new?type=fitting&customerId=${order.customer.id}&designerId=${order.designer.id}&orderId=o1&garmentId=${order.garments[0].id}`,
  );
});

test('a slot taken meanwhile asks for another time and refreshes the day', async () => {
  asFrontDesk();
  designersAre();
  server.use(http.get('/v1/customers/c1', () => HttpResponse.json(customerFixture())));
  const seen = appointmentsAre({
    day: () => meeraDay(),
    book: () => ({ status: 422, error: { code: 'SLOT_TAKEN', message: 'x', details: {} } }),
  });
  renderApp(`/appointments/new?customerId=c1&designerId=des1&date=${T}&time=12:00`);
  await userEvent.click(await screen.findByRole('button', { name: /^Book for/ }));
  expect(await screen.findByText('That time was just booked. Pick another time.')).toBeInTheDocument();
  await waitFor(() => expect(seen.days.length).toBeGreaterThan(1));
});

test("the day view shows each designer's appointments and free gaps", async () => {
  asFrontDesk();
  appointmentsAre({ day: () => meeraDay([appointmentFixture({ time: '11:00' })]) });
  renderApp(`/appointments?date=${T}`);
  const meera = await screen.findByRole('region', { name: 'Meera' });
  expect(within(meera).getByText('11:00 am – 12:00 pm')).toBeInTheDocument();
  expect(within(meera).getByText('Consultation')).toBeInTheDocument();
  expect(within(meera).getByText('Asha Rao')).toBeInTheDocument();
  expect(within(meera).getByRole('link', { name: '98765 43210' })).toHaveAttribute('href', 'tel:+919876543210');
  expect(within(meera).getByRole('button', { name: 'Free 10:00 am – 11:00 am' })).toBeInTheDocument();
  expect(within(meera).getByRole('button', { name: 'Free 12:00 pm – 8:00 pm' })).toBeInTheDocument();
  const nila = screen.getByRole('region', { name: 'Nila' });
  expect(within(nila).getByRole('button', { name: 'Free 10:00 am – 8:00 pm' })).toBeInTheDocument();
});

test('tapping a free gap starts a booking at that time', async () => {
  asFrontDesk();
  designersAre();
  appointmentsAre({ day: () => meeraDay([appointmentFixture({ time: '11:00' })]) });
  renderApp(`/appointments?date=${T}`);
  await userEvent.click(await screen.findByRole('button', { name: 'Free 12:00 pm – 8:00 pm' }));
  expect(await screen.findByRole('heading', { name: 'Book appointment' })).toBeInTheDocument();
  expect(await screen.findByRole('radio', { name: '12:00 pm' })).toBeChecked();
  expect(screen.getByRole('radio', { name: 'Meera' })).toBeChecked();
});

test('moving an appointment offers free times only', async () => {
  asFrontDesk();
  designersAre();
  const a1 = appointmentFixture({ id: 'a1', time: '11:00', version: 2 });
  const a2 = appointmentFixture({ id: 'a2', time: '14:00', customer: { id: 'c2', name: 'Kavya Iyer', phone: '+919123456780' } });
  const seen = appointmentsAre({ day: () => meeraDay([a1, a2]) });
  renderApp(`/appointments?date=${T}`);
  const card = await screen.findByRole('article', { name: /Asha Rao/ });
  await userEvent.click(within(card).getByRole('button', { name: 'Move' }));
  const dialog = await screen.findByRole('dialog');
  expect(await within(dialog).findByRole('radio', { name: '11:00 am' })).toBeInTheDocument();
  expect(within(dialog).getByRole('radio', { name: '1:00 pm' })).toBeInTheDocument();
  expect(within(dialog).queryByRole('radio', { name: '1:30 pm' })).toBeNull();
  expect(within(dialog).queryByRole('radio', { name: '2:00 pm' })).toBeNull();
  await userEvent.click(within(dialog).getByRole('radio', { name: '4:00 pm' }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Move appointment' }));
  await waitFor(() => expect(seen.patches).toHaveLength(1));
  expect(seen.patches[0]).toEqual({ path: '/v1/appointments/a1', body: { version: 2, time: '16:00' } });
});

test('cancelling tells who will be told', async () => {
  asFrontDesk();
  const seen = appointmentsAre({ day: () => meeraDay([appointmentFixture({ version: 1 })]) });
  renderApp(`/appointments?date=${T}`);
  const card = await screen.findByRole('article', { name: /Asha Rao/ });
  await userEvent.click(within(card).getByRole('button', { name: 'Cancel appointment' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('The client and designer will be told.')).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Yes, cancel it' }));
  await waitFor(() => expect(seen.posts).toHaveLength(1));
  expect(seen.posts[0]).toEqual({ path: '/v1/appointments/a1/cancel', body: { version: 1, reason: '' } });
});

test("done and didn't come appear from the appointment's day", async () => {
  asFrontDesk();
  const today = todayYmd();
  const seen = appointmentsAre({
    day: (p) =>
      p.get('date') === today
        ? meeraDay([appointmentFixture({ date: today, time: '00:00', minutes: 15 })], today)
        : meeraDay([appointmentFixture({ id: 'a2' })]),
  });
  renderApp(`/appointments?date=${T}`);
  const later = await screen.findByRole('article', { name: /Asha Rao/ });
  expect(within(later).queryByRole('button', { name: 'Done' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Previous day' }));
  const card = await screen.findByRole('article', { name: /12:00 am/ });
  expect(within(card).getByRole('button', { name: "Didn't come" })).toBeInTheDocument();
  await userEvent.click(within(card).getByRole('button', { name: 'Done' }));
  await waitFor(() => expect(seen.posts).toHaveLength(1));
  expect(seen.posts[0]).toEqual({ path: '/v1/appointments/a1/mark', body: { version: 0, status: 'completed' } });
});

test('designers see only their own day and cannot book', async () => {
  asDesigner();
  const seen = appointmentsAre({
    day: (p) => dayFixture(p.get('date'), [{ id: 'des1', name: 'Meera', appointments: [appointmentFixture({ date: p.get('date') })] }]),
  });
  renderApp(`/appointments?date=${T}`);
  const card = await screen.findByRole('article', { name: /Asha Rao/ });
  expect(within(card).queryByRole('button', { name: 'Move' })).toBeNull();
  expect(within(card).queryByRole('button', { name: 'Cancel appointment' })).toBeNull();
  expect(screen.queryByRole('button', { name: /^Free/ })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Book appointment' })).toBeNull();
  expect(seen.days[0].get('designerId')).toBeNull();
  renderApp('/appointments/new');
  expect(await screen.findByText('You do not have access to this.')).toBeInTheDocument();
});

test('a customer page lists their appointments, upcoming first', async () => {
  asFrontDesk();
  server.use(http.get('/v1/customers/c1', () => HttpResponse.json(customerFixture())));
  const seen = appointmentsAre({ list: () => [appointmentFixture({ id: 'a3', time: '15:00' })] });
  renderApp('/customers/c1');
  const section = await screen.findByRole('region', { name: 'Appointments' });
  expect(await within(section).findByText(/Consultation with Meera/)).toBeInTheDocument();
  expect(within(section).getByRole('link', { name: 'Book appointment' })).toHaveAttribute('href', '/appointments/new?customerId=c1');
  expect(seen.lists[0].get('customerId')).toBe('c1');
});

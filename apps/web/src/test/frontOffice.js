import { http, HttpResponse } from 'msw';
import { server } from './server.js';
import { todayYmd } from './orders.js';
import { addDaysYmd, atIstTime } from '@vs/shared/fy.js';

/** An enquiry as GET /v1/enquiries/:id returns it. */
export function enquiryFixture(fields = {}) {
  return {
    id: 'e1',
    name: 'Priya Sharma',
    phone: '+919845012345',
    garmentTypes: ['lehenga'],
    interest: 'Bridal, red',
    budget: 15000000,
    source: 'instagram',
    occasionDate: '2027-02-14',
    followUpDate: todayYmd(),
    status: 'new',
    isOpen: true,
    lostReason: null,
    enquiryDate: todayYmd(),
    convertedCustomer: null,
    convertedOrder: null,
    log: [{ at: '2026-11-08T05:00:00Z', by: { id: 'ops1', name: 'Kavya' }, kind: 'note', text: 'Saw the reel' }],
    createdAt: '2026-11-08T05:00:00Z',
    version: 0,
    ...fields,
  };
}

/** A list row as GET /v1/enquiries returns it. */
export function enquiryRow(fields = {}) {
  return {
    id: 'e1',
    name: 'Priya Sharma',
    phone: '+919845012345',
    garmentTypes: ['lehenga'],
    interest: 'Bridal, red',
    source: 'instagram',
    followUpDate: todayYmd(),
    status: 'new',
    enquiryDate: todayYmd(),
    overdue: false,
    ...fields,
  };
}

/**
 * Answers the enquiry routes. `list(params)` → items; `one` → the enquiry; `check(phone)` → the
 * phone check; `count` → follow-ups due. Returns what was asked: `lists` (URLSearchParams),
 * `posts` ([{ path, body, key }]).
 */
export function enquiriesAre({ list = () => [], one = enquiryFixture(), check = () => ({ customer: null, openEnquiry: null }), count = { count: 0, overdue: 0 } } = {}) {
  const seen = { lists: [], posts: [] };
  let current = one;
  server.use(
    http.get('/v1/enquiries', ({ request }) => {
      const params = new URL(request.url).searchParams;
      seen.lists.push(params);
      return HttpResponse.json({ items: list(params), nextCursor: null });
    }),
    http.get('/v1/enquiries/check-phone', ({ request }) => HttpResponse.json(check(new URL(request.url).searchParams.get('phone')))),
    http.get('/v1/enquiries/follow-ups/count', () => HttpResponse.json(count)),
    http.get('/v1/enquiries/:id', () => HttpResponse.json({ enquiry: current })),
    http.post('/v1/enquiries', async ({ request }) => {
      const body = await request.json();
      seen.posts.push({ path: '/v1/enquiries', body, key: request.headers.get('Idempotency-Key') });
      current = enquiryFixture({ ...body, phone: '+919845012345', budget: body.budget });
      return HttpResponse.json({ enquiry: current }, { status: 201 });
    }),
    http.post('/v1/enquiries/:id/:action', async ({ request, params }) => {
      const body = await request.json();
      seen.posts.push({ path: `/v1/enquiries/${params.id}/${params.action}`, body });
      const status = { call: current.status === 'new' ? 'contacted' : current.status, lost: 'lost', reopen: 'contacted' }[params.action];
      current = { ...current, status: status ?? current.status, isOpen: status !== 'lost', version: current.version + 1 };
      if (params.action === 'convert') {
        const customer = body.customerId
          ? { id: body.customerId, name: 'Asha Rao', phone: '+919876543210' }
          : { id: 'c9', name: current.name, phone: current.phone };
        current = { ...current, convertedCustomer: customer };
        return HttpResponse.json({ enquiry: current, customer, matched: false });
      }
      return HttpResponse.json({ enquiry: current });
    }),
  );
  return seen;
}

export const tomorrowYmd = () => addDaysYmd(todayYmd(), 1);

/** An appointment as the API returns it, on `date` at `time` (IST). */
export function appointmentFixture({ date = tomorrowYmd(), time = '11:00', minutes = 60, ...fields } = {}) {
  const start = atIstTime(date, time);
  return {
    id: 'a1',
    type: 'consultation',
    date,
    time,
    minutes,
    start: start.toISOString(),
    end: new Date(start.getTime() + minutes * 60_000).toISOString(),
    status: 'booked',
    designer: { id: 'des1', name: 'Meera' },
    customer: { id: 'c1', name: 'Asha Rao', phone: '+919876543210' },
    enquiry: null,
    garments: [],
    note: '',
    cancelReason: null,
    statusAt: null,
    statusBy: null,
    createdAt: '2026-11-08T05:00:00Z',
    version: 0,
    ...fields,
  };
}

/** GET /v1/appointments/day: `columns` is [{ id, name, appointments }]. */
export const dayFixture = (date, columns) => ({ date, openingTime: '10:00', closingTime: '20:00', designers: columns });

export const designersAre = (items = [{ id: 'des1', name: 'Meera' }, { id: 'des2', name: 'Nila' }]) =>
  server.use(http.get('/v1/designers', () => HttpResponse.json({ items })));

/**
 * Answers the appointment routes. `day(params)` → the day view; `list(params)` → items; `book` →
 * the POST answer (a function of the body, or an error { status, error }). Returns what was asked:
 * `days`, `lists` (URLSearchParams), `posts` ([{ path, body, key }]), `patches`.
 */
export function appointmentsAre({ day = (p) => dayFixture(p.get('date'), []), list = () => [], book } = {}) {
  const seen = { days: [], lists: [], posts: [], patches: [] };
  server.use(
    http.get('/v1/appointments/day', ({ request }) => {
      const params = new URL(request.url).searchParams;
      seen.days.push(params);
      return HttpResponse.json(day(params));
    }),
    http.get('/v1/appointments', ({ request }) => {
      const params = new URL(request.url).searchParams;
      seen.lists.push(params);
      return HttpResponse.json({ items: list(params), nextCursor: null });
    }),
    http.post('/v1/appointments', async ({ request }) => {
      const body = await request.json();
      seen.posts.push({ path: '/v1/appointments', body, key: request.headers.get('Idempotency-Key') });
      const answer = book ? book(body) : { appointment: appointmentFixture({ ...body, id: 'a9' }) };
      if (answer.error) return HttpResponse.json({ error: answer.error }, { status: answer.status });
      return HttpResponse.json(answer, { status: 201 });
    }),
    http.patch('/v1/appointments/:id', async ({ request, params }) => {
      const body = await request.json();
      seen.patches.push({ path: `/v1/appointments/${params.id}`, body });
      return HttpResponse.json({ appointment: appointmentFixture({ id: params.id, version: body.version + 1 }) });
    }),
    http.post('/v1/appointments/:id/:action', async ({ request, params }) => {
      const body = await request.json();
      seen.posts.push({ path: `/v1/appointments/${params.id}/${params.action}`, body });
      return HttpResponse.json({ appointment: appointmentFixture({ id: params.id, version: body.version + 1 }) });
    }),
  );
  return seen;
}

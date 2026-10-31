import { http, HttpResponse } from 'msw';
import { server } from './server.js';
import { todayYmd } from './orders.js';

/** An expense as GET /v1/expenses/:id returns it. */
export function expenseFixture(fields = {}) {
  return {
    id: 'e1',
    number: 'EXP/2627/0012',
    date: todayYmd(),
    month: todayYmd().slice(0, 7),
    category: { key: 'repairs', label: 'Repairs and maintenance' },
    note: '',
    payee: { vendorId: null, name: 'Sharma Electricals', gstin: null, stateCode: null },
    total: 50000,
    mode: 'cash',
    reference: '',
    gst: null,
    cost: 50000,
    attachments: [],
    link: null,
    status: 'active',
    void: null,
    monthLocked: false,
    source: 'manual',
    createdBy: { id: 'ops1', name: 'Kavya' },
    createdAt: '2026-10-30T06:00:00Z',
    updatedAt: '2026-10-30T06:00:00Z',
    version: 3,
    ...fields,
  };
}

export const vendorPayee = (fields = {}) => ({ id: '64b7f0c2a1b2c3d4e5f60718', name: 'Sharma Electricals', gstin: '29ABCDE1234F1Z5', stateCode: '29', ...fields });

/** Answers the payee suggestions with `payees` ({ vendors, recent }). */
export function payeesAre(payees) {
  server.use(http.get('/v1/expenses/payees', () => HttpResponse.json(payees)));
}

/** Records every POST /v1/expenses (body and Idempotency-Key); `reply(n)` answers the nth. */
export function expensePosts(reply = () => HttpResponse.json({ expense: expenseFixture() }, { status: 201 })) {
  const posts = [];
  server.use(
    http.post('/v1/expenses', async ({ request }) => {
      posts.push({ body: await request.json(), key: request.headers.get('Idempotency-Key') });
      return reply(posts.length);
    }),
  );
  return posts;
}

/** Uploads succeed: records each upload-url request; `gate` (a promise) holds the answer until it resolves. */
export function uploadsWork({ gate = null } = {}) {
  const requests = [];
  const puts = [];
  server.use(
    http.post('/v1/files/upload-url', async ({ request }) => {
      requests.push(await request.json());
      if (gate) await gate;
      return HttpResponse.json({ key: `b1/expense_bill/2026/photo${requests.length}.jpg`, url: 'https://storage.test/put', headers: {} });
    }),
    http.put('https://storage.test/put', async ({ request }) => {
      puts.push(await request.blob());
      return new HttpResponse(null, { status: 200 });
    }),
    http.get('/v1/files/url', () => HttpResponse.json({ url: 'https://storage.test/view.jpg' })),
  );
  return { requests, puts };
}

/** A row of GET /v1/expenses. */
export function expenseRow(fields = {}) {
  return {
    id: 'e1',
    number: 'EXP/2627/0012',
    date: todayYmd(),
    category: { key: 'repairs', label: 'Repairs and maintenance' },
    payee: { name: 'Sharma Electricals' },
    total: 50000,
    mode: 'cash',
    hasGst: false,
    photos: 0,
    linked: false,
    status: 'active',
    ...fields,
  };
}

/** GET /v1/expenses/summary for the current month. */
export function summaryFixture(fields = {}) {
  return {
    month: todayYmd().slice(0, 7),
    total: 4825000,
    count: 5,
    previousMonthTotal: 4100000,
    byCategory: [
      { category: { key: 'rent', label: 'Rent' }, total: 3000000, count: 1 },
      { category: { key: 'repairs', label: 'Repairs and maintenance' }, total: 1825000, count: 4 },
    ],
    byMode: [{ mode: 'cash', total: 4825000 }],
    gst: { count: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, itc: { cgst: 0, sgst: 0, igst: 0 }, ineligible: { cgst: 0, sgst: 0, igst: 0 } },
    missingBill: 0,
    locked: false,
    ...fields,
  };
}

/**
 * Answers the month summary and the list; `list(query)` returns the rows for a list request
 * (a URLSearchParams). Every summary and list query is recorded.
 */
export function expensesAre({ summary = summaryFixture(), list = () => [] } = {}) {
  const seen = { summaries: [], lists: [] };
  server.use(
    http.get('/v1/expenses/summary', ({ request }) => {
      const q = new URL(request.url).searchParams;
      seen.summaries.push(q);
      return HttpResponse.json(typeof summary === 'function' ? summary(q) : summary);
    }),
    http.get('/v1/expenses', ({ request }) => {
      const q = new URL(request.url).searchParams;
      seen.lists.push(q);
      return HttpResponse.json({ items: list(q), nextCursor: null });
    }),
  );
  return seen;
}

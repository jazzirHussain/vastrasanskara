import { http, HttpResponse } from 'msw';
import { defaultSettings, server } from './server.js';

const CHECKS = [
  ['business', 'Business details on bills', 'done', 'All set', '/settings'],
  ['numbers', 'Bill numbers', 'todo', 'Say where this year’s bill numbers start', '/go-live#numbers'],
  ['price_list', 'Price list', 'done', 'Every garment type has a price', '/catalog'],
  ['staff', 'Staff accounts', 'done', '3 people can sign in', '/users'],
  ['imports', 'Old records brought in', 'warning', 'Not brought in: Stock, Open orders', '/imports'],
  ['email', 'Email works', 'todo', 'Send yourself a test email', null],
  ['backup', 'Backups', 'done', 'Last backup 2026-11-18 09:30', null],
  ['records', 'Records check', 'done', 'Records checked and in order', '/accounts'],
];

/** GET /v1/go-live as the API answers it; `statuses` overrides check statuses by key. */
export function checklist({ statuses = {}, liveSince = null, numbering } = {}) {
  const checks = CHECKS.map(([key, label, status, detail, link]) => ({ key, label, status: statuses[key] ?? status, detail, link }));
  return {
    checks,
    done: checks.filter((c) => c.status === 'done').length,
    total: checks.length,
    liveSince,
    numbering: numbering ?? {
      fy: '2627',
      types: [
        { type: 'invoice', prefix: 'INV', start: 1, next: 1, used: false },
        { type: 'credit_note', prefix: 'CN', start: 1, next: 1, used: false },
        { type: 'receipt_voucher', prefix: 'RV', start: 1, next: 1, used: false },
        { type: 'refund', prefix: 'RF', start: 1, next: 1, used: false },
        { type: 'receipt', prefix: 'RCPT', start: 1, next: 1, used: false },
      ],
    },
  };
}

/**
 * The go-live endpoints over a mutable checklist; settings answer `goLive.liveSince` from it.
 * Returns what was sent: { numbers: [body], testEmails, live }.
 */
export function goLiveServer(initial = checklist()) {
  let current = initial;
  const seen = { numbers: [], testEmails: 0, live: 0, gets: 0 };
  server.use(
    http.get('/v1/go-live', () => {
      seen.gets += 1;
      return HttpResponse.json(current);
    }),
    http.get('/v1/settings', () =>
      HttpResponse.json({ ...defaultSettings, goLive: { ...defaultSettings.goLive, liveSince: current.liveSince } }),
    ),
    http.post('/v1/go-live/numbers', async ({ request }) => {
      seen.numbers.push(await request.json());
      current = { ...current, checks: current.checks.map((c) => (c.key === 'numbers' ? { ...c, status: 'done', detail: 'Next bill: INV/2627/0124' } : c)) };
      return HttpResponse.json(current);
    }),
    http.post('/v1/go-live/test-email', () => {
      seen.testEmails += 1;
      current = { ...current, checks: current.checks.map((c) => (c.key === 'email' ? { ...c, status: 'done', detail: 'A test email was sent' } : c)) };
      return HttpResponse.json(current);
    }),
    http.post('/v1/go-live/live', () => {
      seen.live += 1;
      current = { ...current, liveSince: '2026-11-18' };
      return HttpResponse.json(current);
    }),
  );
  return seen;
}

import { test, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../test/server.js';
import { apiFetch } from './api.js';
test('sends app header, credentials and idempotency key', async () => {
  let seen;
  server.use(http.post('/v1/x', ({ request }) => { seen = request; return HttpResponse.json({ ok: 1 }); }));
  await apiFetch('/v1/x', { method: 'POST', body: { a: 1 }, idempotencyKey: 'k' });
  expect(seen.headers.get('x-requested-with')).toBe('vs-app');
  expect(seen.headers.get('idempotency-key')).toBe('k');
  expect(seen.credentials).toBe('include');
});
test('maps error codes to messages', async () => {
  server.use(http.get('/v1/y', () => HttpResponse.json({ error: { code: 'PERIOD_LOCKED', message: 'x' } }, { status: 422 })));
  await expect(apiFetch('/v1/y')).rejects.toMatchObject({ status: 422, code: 'PERIOD_LOCKED', message: 'This month is locked for filing and cannot be changed.' });
});

test('query params, JSON body, 204 and fallbacks to the server message', async () => {
  let seen;
  server.use(
    http.put('/v1/z', async ({ request }) => { seen = { url: new URL(request.url), type: request.headers.get('content-type'), body: await request.json() }; return new HttpResponse(null, { status: 204 }); }),
    http.get('/v1/unknown-error', () => HttpResponse.json({ error: { code: 'SOMETHING_NEW', message: 'Server says no' } }, { status: 422 })),
  );
  expect(await apiFetch('/v1/z', { method: 'PUT', body: { a: 1 }, query: { page: 2, skip: undefined } })).toBeNull();
  expect(seen.url.search).toBe('?page=2');
  expect(seen.type).toBe('application/json');
  expect(seen.body).toEqual({ a: 1 });
  await expect(apiFetch('/v1/unknown-error')).rejects.toMatchObject({ code: 'SOMETHING_NEW', message: 'Server says no' });
});
test('network failure becomes a friendly error', async () => {
  server.use(http.get('/v1/down', () => HttpResponse.error()));
  await expect(apiFetch('/v1/down')).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
});

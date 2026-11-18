import { test, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../test/server.js';
import { sha256Hex, uploadFile } from './upload.js';

afterEach(() => vi.restoreAllMocks());

// SHA-256 of "abc".
const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

test('uploads send the file’s SHA-256', async () => {
  const file = new File(['abc'], 'bill.jpg', { type: 'image/jpeg' });
  expect(await sha256Hex(file)).toBe(ABC);
  let asked;
  let put;
  server.use(
    http.post('/v1/files/upload-url', async ({ request }) => {
      asked = await request.json();
      return HttpResponse.json({ key: 'b1/expense_bill/2026/x.jpg', url: 'https://bucket.test/x.jpg', headers: { 'Content-Type': 'image/jpeg', 'x-amz-checksum-sha256': 'ungA/4r9Xw==' } });
    }),
    http.put('https://bucket.test/x.jpg', ({ request }) => {
      put = Object.fromEntries(request.headers);
      return new HttpResponse(null, { status: 200 });
    }),
  );
  expect(await uploadFile(file, 'expense_bill')).toBe('b1/expense_bill/2026/x.jpg');
  expect(asked).toEqual({ purpose: 'expense_bill', contentType: 'image/jpeg', size: 3, sha256: ABC });
  expect(put['x-amz-checksum-sha256']).toBe('ungA/4r9Xw==');
});

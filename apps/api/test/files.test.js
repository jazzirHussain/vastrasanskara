import { test, expect, vi } from 'vitest';
import { useTestDb } from './helpers/db.js';
import { buildTestApp, loginAs, fetchLike } from './helpers/app.js';
import { createS3Storage } from '../src/core/files/storage-s3.js';
import { clock } from '../src/clock.js';
useTestDb();
const app = buildTestApp();

test('s3 presigned PUT signs length and type', async () => {
  process.env.AWS_ACCESS_KEY_ID = 'test'; process.env.AWS_SECRET_ACCESS_KEY = 'test';
  const { url } = await createS3Storage({ region: 'ap-south-1', bucket: 'b' }).presignPut({ key: 'k.png', contentType: 'image/png', size: 10 });
  expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
});
test('upload url for allowed file', async () => {
  const { agent, user } = await loginAs(app, { roles: ['admin'] });
  const r = await agent.post('/v1/files/upload-url').send({ purpose: 'branch_logo', contentType: 'image/png', size: 1000 });
  expect(r.status).toBe(200);
  expect(r.body.key).toMatch(new RegExp(`^${user.branchId}/branch_logo/\\d{4}/[0-9a-f-]{36}\\.png$`));
});
test('rejects bad type, size and permission', async () => {
  const { agent } = await loginAs(app, { roles: ['admin'] });
  expect((await agent.post('/v1/files/upload-url').send({ purpose: 'branch_logo', contentType: 'application/zip', size: 10 })).body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');
  expect((await agent.post('/v1/files/upload-url').send({ purpose: 'branch_logo', contentType: 'image/png', size: 10485761 })).body.error.code).toBe('FILE_TOO_LARGE');
  const { agent: d } = await loginAs(app, { roles: ['designer'] });
  expect((await d.post('/v1/files/upload-url').send({ purpose: 'branch_logo', contentType: 'image/png', size: 10 })).status).toBe(403);
});
test('download url hides other branches', async () => {
  const { agent } = await loginAs(app, { roles: ['admin'] });
  expect((await agent.get('/v1/files/url').query({ key: '000000000000000000000000/branch_logo/2026/x.png' })).status).toBe(404);
});
test('local storage round trip', async () => {
  const { agent } = await loginAs(app, { roles: ['admin'] });
  const { body } = await agent.post('/v1/files/upload-url').send({ purpose: 'branch_logo', contentType: 'image/png', size: 3 });
  const put = await fetchLike(app, 'PUT', body.url, Buffer.from('abc'), body.headers);
  expect(put.status).toBe(200);
  const { body: g } = await agent.get('/v1/files/url').query({ key: body.key });
  expect((await fetchLike(app, 'GET', g.url)).body.toString()).toBe('abc');
});

test('local upload with a tampered signature or key is refused', async () => {
  const { agent } = await loginAs(app, { roles: ['admin'] });
  const { body } = await agent.post('/v1/files/upload-url').send({ purpose: 'branch_logo', contentType: 'image/png', size: 3 });
  const forged = new URL(body.url); forged.searchParams.set('sig', '0'.repeat(64));
  expect((await fetchLike(app, 'PUT', forged.toString(), Buffer.from('abc'), body.headers)).status).toBe(403);
  const otherKey = body.url.replace('/branch_logo/', '/other_purpose/');
  expect((await fetchLike(app, 'PUT', otherKey, Buffer.from('abc'), body.headers)).status).toBe(403);
});
test('local upload must match the signed size and type', async () => {
  const { agent } = await loginAs(app, { roles: ['admin'] });
  const { body } = await agent.post('/v1/files/upload-url').send({ purpose: 'branch_logo', contentType: 'image/png', size: 3 });
  expect((await fetchLike(app, 'PUT', body.url, Buffer.from('abcd'), body.headers)).status).toBe(400);
  expect((await fetchLike(app, 'PUT', body.url, Buffer.from('abc'), { 'Content-Type': 'image/jpeg' })).status).toBe(403);
});
test('local links expire', async () => {
  const { agent } = await loginAs(app, { roles: ['admin'] });
  const { body } = await agent.post('/v1/files/upload-url').send({ purpose: 'branch_logo', contentType: 'image/png', size: 3 });
  await fetchLike(app, 'PUT', body.url, Buffer.from('abc'), body.headers);
  const { body: g } = await agent.get('/v1/files/url').query({ key: body.key });
  vi.spyOn(clock, 'now').mockReturnValue(new Date(Date.now() + 301_000));
  expect((await fetchLike(app, 'GET', g.url)).status).toBe(403);
  vi.restoreAllMocks();
});

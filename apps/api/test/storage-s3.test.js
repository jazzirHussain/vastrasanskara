import { test, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mockClient } from 'aws-sdk-client-mock';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { clock } from '../src/clock.js';
import { createS3Storage } from '../src/core/files/storage-s3.js';

process.env.AWS_ACCESS_KEY_ID = 'test';
process.env.AWS_SECRET_ACCESS_KEY = 'test';
const s3 = mockClient(S3Client);
beforeEach(() => s3.reset());

const hex = (data) => createHash('sha256').update(data).digest('hex');
const b64 = (data) => createHash('sha256').update(data).digest('base64');
const storage = (fields = {}) => createS3Storage({ region: 'ap-south-1', bucket: 'b', client: new S3Client({ region: 'ap-south-1' }), ...fields });

test('uploads are signed with their checksum', async () => {
  const { url, headers } = await storage().presignPut({ key: 'k.png', contentType: 'image/png', size: 3, sha256: hex('abc') });
  expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host;x-amz-checksum-sha256');
  expect(headers).toEqual({ 'Content-Type': 'image/png', 'x-amz-checksum-sha256': b64('abc') });
  const plain = await storage().presignPut({ key: 'k.png', contentType: 'image/png', size: 3 });
  expect(plain.headers).toEqual({ 'Content-Type': 'image/png' });
});

test('server-written files carry their checksum', async () => {
  s3.on(PutObjectCommand).resolves({});
  await storage().putObject({ key: 'a.pdf', body: Buffer.from('%PDF'), contentType: 'application/pdf' });
  const [call] = s3.commandCalls(PutObjectCommand);
  expect(call.args[0].input).toMatchObject({
    Bucket: 'b', Key: 'a.pdf', ContentType: 'application/pdf', ChecksumSHA256: b64('%PDF'), Metadata: { sha256: hex('%PDF') },
  });
  expect(call.args[0].input.ObjectLockMode).toBeUndefined();
});

test('bill PDFs are locked for 8 years when Object Lock is on', async () => {
  s3.on(PutObjectCommand).resolves({});
  const now = clock.now();
  await storage({ objectLock: true }).putObject({ key: 'a.pdf', body: Buffer.from('%PDF'), contentType: 'application/pdf', retainYears: 8 });
  const { input } = s3.commandCalls(PutObjectCommand)[0].args[0];
  expect(input.ObjectLockMode).toBe('COMPLIANCE');
  const until = new Date(now);
  until.setUTCFullYear(until.getUTCFullYear() + 8);
  expect(Math.abs(input.ObjectLockRetainUntilDate.getTime() - until.getTime())).toBeLessThan(60_000);

  s3.reset();
  s3.on(PutObjectCommand).resolves({});
  await storage({ objectLock: false }).putObject({ key: 'b.pdf', body: Buffer.from('%PDF'), contentType: 'application/pdf', retainYears: 8 });
  expect(s3.commandCalls(PutObjectCommand)[0].args[0].input.ObjectLockMode).toBeUndefined();
});

test('a stored file answers its checksum', async () => {
  s3.on(HeadObjectCommand).resolves({ ContentLength: 3, ContentType: 'image/png', ChecksumSHA256: b64('abc') });
  expect(await storage().headObject('k.png')).toMatchObject({ size: 3, sha256: hex('abc') });
  expect(s3.commandCalls(HeadObjectCommand)[0].args[0].input).toMatchObject({ ChecksumMode: 'ENABLED' });
  s3.on(HeadObjectCommand).resolves({ ContentLength: 3, ContentType: 'image/png', Metadata: { sha256: hex('xyz') } });
  expect((await storage().headObject('k.png')).sha256).toBe(hex('xyz'));
  s3.on(HeadObjectCommand).resolves({ ContentLength: 3, ContentType: 'image/png' });
  expect((await storage().headObject('k.png')).sha256).toBeNull();
});

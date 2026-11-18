import { createHash } from 'node:crypto';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { clock } from '../../clock.js';

const hexToBase64 = (hex) => Buffer.from(hex, 'hex').toString('base64');
const base64ToHex = (b64) => Buffer.from(b64, 'base64').toString('hex');

function retainUntil(years) {
  const until = new Date(clock.now());
  until.setUTCFullYear(until.getUTCFullYear() + years);
  return until;
}

/**
 * S3-backed storage. Browsers upload and download directly with presigned URLs. Every file
 * carries its SHA-256, checked by S3 on the way in; with `objectLock`, files written with
 * `retainYears` cannot be changed or deleted until then (the bucket must have Object Lock).
 */
export function createS3Storage({ region, bucket, objectLock = false, client = new S3Client({ region }) }) {
  return {
    async presignPut({ key, contentType, size, sha256 }) {
      const checksum = sha256 ? hexToBase64(sha256) : null;
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: size,
        ...(checksum && { ChecksumSHA256: checksum }),
      });
      // Signing type, length and checksum makes S3 reject any other type, size or bytes.
      const signed = ['content-type', 'content-length', ...(checksum ? ['x-amz-checksum-sha256'] : [])];
      const url = await getSignedUrl(client, command, {
        expiresIn: 300,
        signableHeaders: new Set(signed),
        // Kept a header (not moved into the URL), so the browser must send it and S3 checks the bytes.
        unhoistableHeaders: new Set(checksum ? ['x-amz-checksum-sha256'] : []),
      });
      return {
        url,
        headers: { 'Content-Type': contentType, ...(checksum && { 'x-amz-checksum-sha256': checksum }) },
      };
    },

    presignGet(key, { expiresIn = 300 } = {}) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
    },

    async putObject({ key, body, contentType, contentDisposition, retainYears }) {
      const params = {
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ...(contentDisposition && { ContentDisposition: contentDisposition }),
        ...(retainYears && objectLock && { ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: retainUntil(retainYears) }),
      };
      if (Buffer.isBuffer(body)) {
        const hash = createHash('sha256').update(body);
        const sha256 = hash.copy().digest('hex');
        await client.send(new PutObjectCommand({ ...params, ChecksumSHA256: hash.digest('base64'), Metadata: { sha256 } }));
        return;
      }
      // Streams of unknown length (backups, exports) go up in parts.
      await new Upload({ client, params }).done();
    },

    async getObject(key) {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return result.Body;
    },

    async headObject(key) {
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: 'ENABLED' }));
        // A full-object SHA-256 is plain base64; a multipart one ends in "-<parts>" and is not the file's hash.
        const checksum = result.ChecksumSHA256 && !result.ChecksumSHA256.includes('-') ? base64ToHex(result.ChecksumSHA256) : null;
        return {
          size: result.ContentLength,
          sha256: checksum ?? result.Metadata?.sha256 ?? null,
          contentType: result.ContentType,
          contentDisposition: result.ContentDisposition ?? null,
        };
      } catch (err) {
        if (err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    },
  };
}

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** S3-backed storage. Browsers upload and download directly with presigned URLs. */
export function createS3Storage({ region, bucket, client = new S3Client({ region }) }) {
  return {
    async presignPut({ key, contentType, size }) {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: size,
      });
      // Signing type and length makes S3 reject any other type or size.
      const url = await getSignedUrl(client, command, {
        expiresIn: 300,
        signableHeaders: new Set(['content-type', 'content-length']),
      });
      return { url, headers: { 'Content-Type': contentType } };
    },

    presignGet(key, { expiresIn = 300 } = {}) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
    },

    async putObject({ key, body, contentType, contentDisposition }) {
      // Upload handles both Buffers and streams of unknown length (multipart when large).
      await new Upload({
        client,
        params: { Bucket: bucket, Key: key, Body: body, ContentType: contentType, ...(contentDisposition && { ContentDisposition: contentDisposition }) },
      }).done();
    },

    async getObject(key) {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return result.Body;
    },

    async headObject(key) {
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return {
          size: result.ContentLength,
          sha256: result.Metadata?.sha256,
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

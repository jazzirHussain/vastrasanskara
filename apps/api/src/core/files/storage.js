import path from 'node:path';
import { createLocalStorage } from './storage-local.js';
import { createS3Storage } from './storage-s3.js';

/** S3 in production, local disk in development and tests. */
export function createStorage(config, bucketKey = 'filesBucket') {
  if (config.storage.adapter === 's3') {
    return createS3Storage({ region: config.aws.region, bucket: config.aws[bucketKey], objectLock: config.aws.objectLock });
  }
  return createLocalStorage({
    dir: path.join(config.storage.localDir, bucketKey),
    apiOrigin: config.apiOrigin,
    secret: config.sessionSecret,
  });
}

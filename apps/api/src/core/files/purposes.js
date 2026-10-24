import path from 'node:path';
import { createLocalStorage } from './storage-local.js';
import { createS3Storage } from './storage-s3.js';

export const ALLOWED_TYPES = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
});
export const MAX_UPLOAD_BYTES = 10485760;

/** S3 in production, local disk in development and tests. */
export function createStorage(config, bucketKey = 'filesBucket') {
  if (config.storage.adapter === 's3') {
    return createS3Storage({ region: config.aws.region, bucket: config.aws[bucketKey] });
  }
  return createLocalStorage({
    dir: path.join(config.storage.localDir, bucketKey),
    apiOrigin: config.apiOrigin,
    secret: config.sessionSecret,
  });
}

const purposes = new Map();

/**
 * Declares what a file is for and who may upload or read it. Branch scoping is enforced
 * by the routes (keys start with the branch id); canRead adds purpose-specific checks.
 */
export function registerFilePurpose(
  name,
  { allowedTypes = Object.keys(ALLOWED_TYPES), canWrite, canRead },
) {
  purposes.set(name, { allowedTypes, canWrite, canRead });
}

export function getFilePurpose(name) {
  return purposes.get(name) ?? null;
}

registerFilePurpose('branch_logo', {
  canWrite: (user) => user.permissions.has('settings.edit'),
  canRead: async () => true,
});

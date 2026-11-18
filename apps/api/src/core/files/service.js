import { randomUUID } from 'node:crypto';
import { istDate } from '@vs/shared/fy.js';
import { clock } from '../../clock.js';
import { AppError, forbidden, notFound, validationError } from '../errors.js';
import { ALLOWED_TYPES, MAX_UPLOAD_BYTES, getFilePurpose } from './purposes.js';

// <branchId>/<purpose>/<yyyy>/<uuid>.<ext>
const KEY_PATTERN = /^([0-9a-f]{24})\/([a-z0-9_]+)\/\d{4}\/[0-9a-f-]{36}\.[a-z0-9]+$/;

/**
 * Checks an upload against its purpose (type, size, permission) and returns a new key in
 * the user's branch plus a presigned upload URL.
 */
export async function createUploadUrl(storage, user, { purpose: purposeName, contentType, size, sha256 }) {
  const purpose = getFilePurpose(purposeName);
  if (!purpose) throw validationError([{ path: 'purpose', message: 'Unknown file purpose' }]);
  if (!purpose.allowedTypes.includes(contentType) || !ALLOWED_TYPES[contentType]) {
    throw new AppError(400, 'FILE_TYPE_NOT_ALLOWED', 'This file type is not allowed');
  }
  const maxBytes = purpose.maxBytes ?? MAX_UPLOAD_BYTES;
  if (size > maxBytes) {
    throw new AppError(400, 'FILE_TOO_LARGE', `Files must be ${Math.round(maxBytes / 1048576)} MB or smaller`);
  }
  if (!purpose.canWrite(user)) throw forbidden();

  const year = istDate(clock.now()).slice(0, 4);
  const key = `${user.branchId}/${purposeName}/${year}/${randomUUID()}.${ALLOWED_TYPES[contentType]}`;
  const { url, headers } = await storage.presignPut({ key, contentType, size, sha256 });
  return { key, url, headers };
}

/**
 * A short-lived download URL. Another branch's file, an unknown purpose and a refused read
 * all look like "not found".
 */
export async function createDownloadUrl(storage, user, key) {
  const match = KEY_PATTERN.exec(key);
  if (!match || match[1] !== user.branchId) throw notFound();
  const purpose = getFilePurpose(match[2]);
  if (!purpose || !(await purpose.canRead(user, key))) throw notFound();
  return storage.presignGet(key, { expiresIn: 300 });
}

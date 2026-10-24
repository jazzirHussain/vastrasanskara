import { ApiError, apiFetch } from './api.js';

/**
 * Uploads a file for a purpose (e.g. 'branch_logo'): asks the API for a signed URL, then
 * sends the file straight to storage. Resolves to the stored file's key.
 */
export async function uploadFile(file, purpose) {
  const { key, url, headers } = await apiFetch('/v1/files/upload-url', {
    method: 'POST',
    body: { purpose, contentType: file.type, size: file.size },
  });
  const response = await fetch(url, { method: 'PUT', headers, body: file });
  if (!response.ok) {
    throw new ApiError({ status: response.status, code: 'UPLOAD_FAILED', message: 'The upload failed. Please try again.' });
  }
  return key;
}

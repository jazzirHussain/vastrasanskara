import { ApiError, apiFetch } from './api.js';

// Older browsers (and test DOMs) without Blob.arrayBuffer read through FileReader.
function bytesOf(file) {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

/** The file's SHA-256 as lowercase hex. */
export async function sha256Hex(file) {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(await bytesOf(file)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Uploads a file for a purpose (e.g. 'branch_logo'): asks the API for a signed URL, then
 * sends the file straight to storage with its SHA-256, so storage refuses bytes changed on the
 * way. Resolves to the stored file's key.
 */
export async function uploadFile(file, purpose, { contentType = file.type } = {}) {
  const sha256 = await sha256Hex(file);
  const { key, url, headers } = await apiFetch('/v1/files/upload-url', {
    method: 'POST',
    body: { purpose, contentType, size: file.size, sha256 },
  });
  const response = await fetch(url, { method: 'PUT', headers, body: file });
  if (!response.ok) {
    throw new ApiError({ status: response.status, code: 'UPLOAD_FAILED', message: 'The upload failed. Please try again.' });
  }
  return key;
}

/**
 * Opens a stored file in a new tab. The tab is opened during the tap (Safari blocks one opened
 * after an await) and pointed at the signed URL once it arrives; it is closed if that fails.
 */
export function openFile(key) {
  return openInNewTab(async () => (await apiFetch('/v1/files/url', { query: { key } })).url);
}

/** Opens the URL `getUrl()` resolves to in a new tab, with the tab opened during the tap (see openFile). */
export async function openInNewTab(getUrl) {
  const tab = window.open('', '_blank');
  if (tab) tab.opener = null;
  try {
    const url = await getUrl();
    if (tab) tab.location.href = url;
    else window.location.assign(url);
  } catch (error) {
    tab?.close();
    throw error;
  }
}

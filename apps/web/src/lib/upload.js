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

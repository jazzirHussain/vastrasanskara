import { ApiError } from './api.js';
import { errorMessages, messageFor } from './errorMessages.js';

const API_BASE = import.meta.env.VITE_API_URL ?? '';

/** Where a downloaded file is handed to the browser (a seam so tests can watch it). */
export const saver = {
  save(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  },
};

// The plain filename from `attachment; filename="…"` (or the UTF-8 `filename*` form).
function filenameOf(disposition, fallback) {
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition ?? '');
  if (utf8) return decodeURIComponent(utf8[1]);
  return /filename="([^"]+)"/i.exec(disposition ?? '')?.[1] ?? fallback;
}

/**
 * Downloads a file the API sends directly (a template, "rows to fix") with the session cookie,
 * and saves it under the server's filename.
 */
export async function downloadFile(path, { query, fallbackName = 'download' } = {}) {
  const url = new URL(API_BASE + path, window.location.origin);
  for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
  let response;
  try {
    response = await fetch(url, { credentials: 'include', headers: { 'X-Requested-With': 'vs-app' } });
  } catch {
    throw new ApiError({ status: 0, code: 'NETWORK_ERROR', message: errorMessages.NETWORK_ERROR });
  }
  if (!response.ok) {
    const error = (await response.json().catch(() => null))?.error ?? {};
    const code = error.code ?? `HTTP_${response.status}`;
    throw new ApiError({ status: response.status, code, message: messageFor(code, error.message) });
  }
  saver.save(await response.blob(), filenameOf(response.headers.get('Content-Disposition'), fallbackName));
}

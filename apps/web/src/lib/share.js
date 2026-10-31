import { ApiError } from './api.js';

/** Fetches a PDF from its signed link as a File named `filename`. */
export async function fetchPdfFile(url, filename) {
  let response;
  try {
    response = await fetch(url);
  } catch {
    throw new ApiError({ status: 0, code: 'NETWORK_ERROR', message: 'Could not get the PDF. Check your connection and try again.' });
  }
  if (!response.ok) {
    throw new ApiError({ status: response.status, code: 'PDF_FETCH_FAILED', message: 'Could not get the PDF. Please try again.' });
  }
  return new File([await response.arrayBuffer()], filename, { type: 'application/pdf' });
}

/** Saves a file through the browser's download. */
export function downloadFile(file) {
  const href = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = href;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

/**
 * Hands a PDF to the phone's share sheet (WhatsApp, email…) when the browser can share files,
 * otherwise downloads it. Resolves to 'shared', 'downloaded' or 'cancelled' (the person closed
 * the share sheet). Pass `file` to share one already fetched.
 */
export async function sharePdf({ url, filename, title, file }) {
  const pdf = file ?? (await fetchPdfFile(url, filename));
  const data = { files: [pdf], title };
  if (typeof navigator.share === 'function' && navigator.canShare?.(data)) {
    try {
      await navigator.share(data);
      return 'shared';
    } catch (error) {
      if (error?.name === 'AbortError') return 'cancelled';
      // Safari refuses a share that starts long after the tap: the fetched file goes with the
      // error so the caller can offer an immediate second try.
      if (error?.name === 'NotAllowedError') error.file = pdf;
      throw error;
    }
  }
  downloadFile(pdf);
  return 'downloaded';
}

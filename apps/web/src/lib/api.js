import { errorMessages } from './errorMessages.js';

export class ApiError extends Error {
  constructor({ status, code, message, details }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const API_BASE = import.meta.env.VITE_API_URL ?? '';

function buildUrl(path, query) {
  const url = new URL(API_BASE + path, window.location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url;
}

/**
 * Calls the API with the session cookie and the app header the server requires.
 * Resolves to the JSON body (null for 204); rejects with ApiError carrying a friendly message.
 */
export async function apiFetch(path, { method = 'GET', body, idempotencyKey, query } = {}) {
  const headers = { 'X-Requested-With': 'vs-app' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  let response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'include',
    });
  } catch {
    throw new ApiError({ status: 0, code: 'NETWORK_ERROR', message: errorMessages.NETWORK_ERROR });
  }

  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = data?.error ?? {};
    const code = error.code ?? `HTTP_${response.status}`;
    throw new ApiError({
      status: response.status,
      code,
      message: errorMessages[code] ?? error.message ?? 'Something went wrong. Please try again.',
      details: error.details,
    });
  }
  return data;
}

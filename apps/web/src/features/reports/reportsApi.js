import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api.js';
import { messageFor } from '../../lib/errorMessages.js';

const REPORTS_KEY = ['reports'];
const BUSY = new Set(['queued', 'running']);

/** Where the browser goes to fetch a file (a seam so tests can watch it). */
export const browser = { assign: (url) => window.location.assign(url) };

/** The runs of the last 90 days; polls every 3 s while one is being prepared. */
export function useReportRuns() {
  return useQuery({
    queryKey: [...REPORTS_KEY, 'runs'],
    queryFn: () => apiFetch('/v1/reports'),
    refetchInterval: (query) => ((query.state.data?.items ?? []).some((r) => BUSY.has(r.status)) ? 3000 : false),
  });
}

/**
 * Asks for a report file: `mutate({ kind, format, params })`. Each call takes a new
 * Idempotency-Key; a retry after a network failure reuses it, so a file is made once.
 */
export function useRequestReport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ key, ...body }) => apiFetch('/v1/reports', { method: 'POST', body, idempotencyKey: key }),
    // Only network failures (no HTTP status) are retried, with the same key.
    retry: (count, error) => count < 2 && error?.status === undefined,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: REPORTS_KEY }),
  });
}

/** Asks for a report with a fresh key per click. */
export const withKey = (body) => ({ ...body, key: crypto.randomUUID() });

/** Follows a fresh 5-minute download link for one file of a finished report (`file` index). */
export async function downloadReport(id, file) {
  const { url } = await apiFetch(`/v1/reports/${id}/download`, { query: file === undefined ? undefined : { file: String(file) } });
  browser.assign(url);
}

/** Why a request or download failed, in plain words (a field message for a refused request). */
export function reportErrorText(error) {
  if (error?.code === 'VALIDATION_FAILED') return error.details?.[0]?.message ?? error.message;
  return messageFor(error?.code, error?.message);
}

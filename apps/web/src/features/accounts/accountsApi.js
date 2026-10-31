import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api.js';

const PERIODS_KEY = ['periods'];

/** The twelve months (April to March) of a financial year such as '2026-27'; no `fy` means this year. */
export function usePeriods(fy) {
  return useQuery({
    queryKey: [...PERIODS_KEY, fy ?? null],
    queryFn: () => apiFetch('/v1/period-locks', { query: { fy } }),
  });
}

function usePeriodAction(action) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ month, ...body }) => apiFetch(`/v1/period-locks/${month}/${action}`, { method: 'POST', body }),
    // A lock changes what every open bill may do.
    onSuccess: () => Promise.all([queryClient.invalidateQueries({ queryKey: PERIODS_KEY }), queryClient.invalidateQueries({ queryKey: ['billing'] })]),
  });
}

/** Locks a month: `{ month, note }`. */
export const useLockMonth = () => usePeriodAction('lock');

/** Unlocks a month: `{ month, reason }`. */
export const useUnlockMonth = () => usePeriodAction('unlock');

/** Checks the audit trail, stored PDFs and bill balances: resolves to the result. */
export function useVerifyRecords() {
  return useMutation({ mutationFn: () => apiFetch('/v1/admin/audit/verify', { method: 'POST' }) });
}

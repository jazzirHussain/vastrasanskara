import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api.js';

export const EXPENSES_KEY = ['expenses'];

/** One expense as GET /v1/expenses/:id returns it. */
export function useExpense(id) {
  return useQuery({
    queryKey: [...EXPENSES_KEY, 'one', id],
    queryFn: () => apiFetch(`/v1/expenses/${id}`).then((r) => r.expense),
    enabled: Boolean(id),
  });
}

/** Saves a new expense: `{ body, key }`, where `key` is the Idempotency-Key made when the form opened and sent on every retry. */
export function useCreateExpense() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ body, key }) => apiFetch('/v1/expenses', { method: 'POST', body, idempotencyKey: key }).then((r) => r.expense),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: EXPENSES_KEY }),
  });
}

/** Saves an edit: `{ ...changed fields, version }`. */
export function useUpdateExpense(id) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch(`/v1/expenses/${id}`, { method: 'PATCH', body }).then((r) => r.expense),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: EXPENSES_KEY }),
  });
}

/** Vendors and recent payee names matching `q` (the caller debounces `q`). */
export function usePayees(q) {
  return useQuery({
    queryKey: [...EXPENSES_KEY, 'payees', q],
    queryFn: () => apiFetch('/v1/expenses/payees', { query: { q: q || undefined } }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

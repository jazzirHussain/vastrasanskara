import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

/** Expenses matching `filters` (month, category, noBill, status, q), a page at a time. */
export function useExpenses(filters) {
  return useInfiniteQuery({
    queryKey: [...EXPENSES_KEY, 'list', filters],
    queryFn: ({ pageParam }) => apiFetch('/v1/expenses', { query: { ...filters, cursor: pageParam } }),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** The month's total, category split, GST and bills without photos. */
export function useExpenseSummary(month) {
  return useQuery({
    queryKey: [...EXPENSES_KEY, 'summary', month],
    queryFn: () => apiFetch('/v1/expenses/summary', { query: { month } }),
    placeholderData: keepPreviousData,
  });
}

/** Voids the expense: `{ reason, version }`. The voided expense replaces the cached one; lists and figures refresh. */
export function useVoidExpense(id) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch(`/v1/expenses/${id}/void`, { method: 'POST', body }).then((r) => r.expense),
    onSuccess: (expense) => {
      queryClient.setQueryData([...EXPENSES_KEY, 'one', id], expense);
      queryClient.invalidateQueries({ queryKey: [...EXPENSES_KEY, 'list'] });
      queryClient.invalidateQueries({ queryKey: [...EXPENSES_KEY, 'summary'] });
    },
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

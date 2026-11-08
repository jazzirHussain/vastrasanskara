import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api.js';

export const STOCK_KEY = ['stock'];

const infinite = (key, path, query) => ({
  queryKey: [...STOCK_KEY, ...key],
  queryFn: ({ pageParam }) => apiFetch(path, { query: { ...query, cursor: pageParam } }),
  initialPageParam: undefined,
  getNextPageParam: (last) => last.nextCursor ?? undefined,
});

/** Stock items matching `filters` (q, category, low, active), a page at a time. */
export function useStockItems(filters) {
  return useInfiniteQuery({ ...infinite(['items', filters], '/v1/stock/items', filters), placeholderData: keepPreviousData });
}

/** One stock item. */
export function useStockItem(id) {
  return useQuery({
    queryKey: [...STOCK_KEY, 'item', id],
    queryFn: () => apiFetch(`/v1/stock/items/${id}`).then((r) => r.item),
    enabled: Boolean(id),
  });
}

/** An item's history, newest first, a page at a time. */
export function useMovements(id) {
  return useInfiniteQuery({ ...infinite(['movements', id], `/v1/stock/items/${id}/movements`, {}), enabled: Boolean(id) });
}

/** Items in use whose free stock is below their reorder level. */
export function useLowStock() {
  return useQuery({ queryKey: [...STOCK_KEY, 'low'], queryFn: () => apiFetch('/v1/stock/low').then((r) => r.items) });
}

/** Items for choosing materials (quantities only), matching `q` (the caller debounces it). */
export function usePicker(q) {
  return useQuery({
    queryKey: [...STOCK_KEY, 'picker', q],
    queryFn: () => apiFetch('/v1/stock/picker', { query: { q: q || undefined } }).then((r) => r.items),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

function useStockMutation(fn) {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => queryClient.invalidateQueries({ queryKey: STOCK_KEY }) });
}

/** Adds an item: `{ body, key }`, `key` the Idempotency-Key made when the form opened. */
export const useCreateItem = () =>
  useStockMutation(({ body, key }) => apiFetch('/v1/stock/items', { method: 'POST', body, idempotencyKey: key }).then((r) => r.item));

/** Saves item changes: `{ ...changed fields, version }`. */
export const useUpdateItem = (id) =>
  useStockMutation((body) => apiFetch(`/v1/stock/items/${id}`, { method: 'PATCH', body }).then((r) => r.item));

/** Records a shelf count: `{ counted, expectedOnHand, reason, unitCost? }`. */
export const useCountStock = (id) =>
  useStockMutation((body) => apiFetch(`/v1/stock/items/${id}/count`, { method: 'POST', body }).then((r) => r.item));

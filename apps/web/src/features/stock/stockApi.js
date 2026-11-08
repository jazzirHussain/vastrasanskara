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

/** "To buy" requests by status ('open' = requested or ordered; 'received'; 'cancelled'), a page at a time. */
export function useRequests(status) {
  return useInfiniteQuery(infinite(['requests', status], '/v1/stock/requests', { status }));
}

/** Puts an item on the "To buy" list: `{ stockItemId, quantity, reason, note }`. */
export const useCreateRequest = () =>
  useStockMutation((body) => apiFetch('/v1/stock/requests', { method: 'POST', body }).then((r) => r.request));

/** Marks a request ordered: `{ version, vendorId, note }`. */
export const useMarkOrdered = (id) =>
  useStockMutation((body) => apiFetch(`/v1/stock/requests/${id}/order`, { method: 'POST', body }).then((r) => r.request));

/** Takes a request off the list: `{ version, reason }`. */
export const useCancelRequest = (id) =>
  useStockMutation((body) => apiFetch(`/v1/stock/requests/${id}/cancel`, { method: 'POST', body }).then((r) => r.request));

/**
 * Receives a delivery against a request (`requestId`) or straight onto an item (`itemId`):
 * `{ body, key }`, `key` the Idempotency-Key made when the dialog opened. Answers { request, item, expense }.
 */
export function useReceive({ requestId, itemId }) {
  const queryClient = useQueryClient();
  const path = requestId ? `/v1/stock/requests/${requestId}/receive` : `/v1/stock/items/${itemId}/receive`;
  return useMutation({
    mutationFn: ({ body, key }) => apiFetch(path, { method: 'POST', body, idempotencyKey: key }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STOCK_KEY });
      queryClient.invalidateQueries({ queryKey: ['expenses'] });
    },
  });
}

/** Undoes a delivery: `{ version, reason }`; the stock comes back out and its expense is voided. */
export function useUndoReceipt(id) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch(`/v1/stock/requests/${id}/undo`, { method: 'POST', body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STOCK_KEY });
      queryClient.invalidateQueries({ queryKey: ['expenses'] });
    },
  });
}

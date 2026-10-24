import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api.js';

export const ORDERS_KEY = ['orders'];

/** Active designers to assign an order to. */
export function useDesigners() {
  return useQuery({ queryKey: ['designers'], queryFn: () => apiFetch('/v1/designers'), staleTime: 60_000 });
}

/** Takes an order; `key` is the Idempotency-Key kept for every retry of this order. */
export function useCreateOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ body, key }) => apiFetch('/v1/orders', { method: 'POST', body, idempotencyKey: key }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ORDERS_KEY }),
  });
}

/** Orders matching `filters` (status, priority, pickupFrom, pickupTo, q, customerId), a page at a time. */
export function useOrders(filters, { enabled = true } = {}) {
  return useInfiniteQuery({
    queryKey: [...ORDERS_KEY, 'list', filters],
    queryFn: ({ pageParam }) => apiFetch('/v1/orders', { query: { ...filters, cursor: pageParam } }),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

export function useOrder(id) {
  return useQuery({ queryKey: [...ORDERS_KEY, id], queryFn: () => apiFetch(`/v1/orders/${id}`) });
}

/**
 * A change to the order: `{ path, method, body, key? }` relative to /v1/orders/:id. The order
 * as returned replaces the cached one; lists refresh.
 */
export function useOrderChange(id) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ path = '', method = 'POST', body, key }) =>
      apiFetch(`/v1/orders/${id}${path}`, { method, body, idempotencyKey: key }),
    onSuccess: (order) => {
      queryClient.setQueryData([...ORDERS_KEY, id], order);
      queryClient.invalidateQueries({ queryKey: [...ORDERS_KEY, 'list'] });
    },
  });
}

/** Planned-date changes to one garment of order `orderId`; the order is re-read after. */
export function useGarmentPlan(orderId, garmentId) {
  const queryClient = useQueryClient();
  const reloadOrder = () => queryClient.invalidateQueries({ queryKey: [...ORDERS_KEY, orderId] });
  const mutation = useMutation({
    mutationFn: (body) => apiFetch(`/v1/garments/${garmentId}/plan`, { method: 'PUT', body }),
    onSuccess: reloadOrder,
  });
  return { ...mutation, reloadOrder };
}

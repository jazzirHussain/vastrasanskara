import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

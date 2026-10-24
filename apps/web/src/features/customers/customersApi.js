import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api.js';

const CUSTOMERS_KEY = ['customers'];

/** Customers matching `q` (name prefix or phone digits), a page at a time. */
export function useCustomers(q) {
  return useInfiniteQuery({
    queryKey: [...CUSTOMERS_KEY, 'list', q ?? ''],
    queryFn: ({ pageParam }) => apiFetch('/v1/customers', { query: { q: q || undefined, cursor: pageParam } }),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useCustomer(id) {
  return useQuery({ queryKey: [...CUSTOMERS_KEY, id], queryFn: () => apiFetch(`/v1/customers/${id}`), enabled: Boolean(id) });
}

export function useCreateCustomer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (customer) => apiFetch('/v1/customers', { method: 'POST', body: customer }),
    onSuccess: (created) => {
      queryClient.setQueryData([...CUSTOMERS_KEY, created.id], created);
      queryClient.invalidateQueries({ queryKey: [...CUSTOMERS_KEY, 'list'] });
    },
  });
}

/** Saves `changes` to the customer at `version`. */
export function useUpdateCustomer(id) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ version, changes }) => apiFetch(`/v1/customers/${id}`, { method: 'PATCH', body: { version, ...changes } }),
    onSuccess: (saved) => {
      queryClient.setQueryData([...CUSTOMERS_KEY, id], saved);
      queryClient.invalidateQueries({ queryKey: [...CUSTOMERS_KEY, 'list'] });
    },
  });
}

export function useMeasurements(customerId) {
  return useQuery({
    queryKey: [...CUSTOMERS_KEY, customerId, 'measurements'],
    queryFn: () => apiFetch(`/v1/customers/${customerId}/measurements`),
    enabled: Boolean(customerId),
  });
}

/** The newest set per garment type, for pre-filling orders. */
export function useLatestMeasurements(customerId) {
  return useQuery({
    queryKey: [...CUSTOMERS_KEY, customerId, 'measurements', 'latest'],
    queryFn: () => apiFetch(`/v1/customers/${customerId}/measurements/latest`),
    enabled: Boolean(customerId),
  });
}

export function useRecordMeasurement(customerId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (measurement) => apiFetch(`/v1/customers/${customerId}/measurements`, { method: 'POST', body: measurement }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [...CUSTOMERS_KEY, customerId, 'measurements'] }),
  });
}

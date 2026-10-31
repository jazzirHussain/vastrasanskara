import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api.js';

/** The branch's price-list items; `active` (true/false) and `kind` narrow the list. */
export function useCatalogItems({ active, kind } = {}) {
  return useQuery({
    queryKey: ['catalog', { active, kind }],
    queryFn: () => apiFetch('/v1/catalog/items', { query: { active, kind } }),
    staleTime: 60_000,
  });
}

/** Creates (no `id`) or updates (`id` + `body` with `version`) an item; every list refreshes. */
export function useSaveItem() {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['catalog'] });
  const mutation = useMutation({
    mutationFn: ({ id, body }) =>
      apiFetch(id ? `/v1/catalog/items/${id}` : '/v1/catalog/items', { method: id ? 'PATCH' : 'POST', body }),
    onSuccess: refresh,
  });
  return { ...mutation, refresh };
}

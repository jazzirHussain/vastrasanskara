import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api.js';

const listQuery = (path, key, active) =>
  ({ queryKey: [key, { active }], queryFn: () => apiFetch(path, { query: { active } }), staleTime: 60_000 });

/** The branch's workers (`active` true/false narrows the list). */
export function useWorkers({ active } = {}) {
  return useQuery(listQuery('/v1/workers', 'workers', active));
}

/** The branch's vendors (`active` true/false narrows the list). */
export function useVendors({ active } = {}) {
  return useQuery(listQuery('/v1/vendors', 'vendors', active));
}

/** Creates (no `id`) or updates (`id` + `body` with `version`) one record of `path`; lists refresh. */
function useSave(path, key) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: [key] });
  const mutation = useMutation({
    mutationFn: ({ id, body }) => apiFetch(id ? `${path}/${id}` : path, { method: id ? 'PATCH' : 'POST', body }),
    onSuccess: refresh,
  });
  return { ...mutation, refresh };
}

export const useSaveWorker = () => useSave('/v1/workers', 'workers');
export const useSaveVendor = () => useSave('/v1/vendors', 'vendors');

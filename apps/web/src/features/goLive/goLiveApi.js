import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api.js';

export const GO_LIVE_KEY = ['go-live'];
const SETTINGS_KEY = ['settings'];

/** The go-live checklist (admins only: pass enabled=false for others). */
export function useGoLive({ enabled = true } = {}) {
  return useQuery({ queryKey: GO_LIVE_KEY, queryFn: () => apiFetch('/v1/go-live'), enabled });
}

/** True while the branch is still getting ready (not yet live), read from settings; false while unknown. */
export function useNotLiveYet({ enabled = true } = {}) {
  const settings = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => apiFetch('/v1/settings'), enabled });
  return Boolean(enabled && settings.data && !settings.data.goLive?.liveSince);
}

function useGoLiveAction(path) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body = {}) => apiFetch(`/v1/go-live/${path}`, { method: 'POST', body }),
    onSuccess: (result) => {
      queryClient.setQueryData(GO_LIVE_KEY, result);
      return queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
    },
  });
}

export const useConfirmNumbers = () => useGoLiveAction('numbers');
export const useSendTestEmail = () => useGoLiveAction('test-email');
export const useMarkLive = () => useGoLiveAction('live');

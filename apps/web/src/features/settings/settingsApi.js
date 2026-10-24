import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api.js';

const SETTINGS_KEY = ['settings'];
const BRANCH_KEY = ['branch'];

export function useSettings() {
  return useQuery({ queryKey: SETTINGS_KEY, queryFn: () => apiFetch('/v1/settings') });
}

export function useSaveSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings) => apiFetch('/v1/settings', { method: 'PUT', body: settings }),
    onSuccess: (saved) => queryClient.setQueryData(SETTINGS_KEY, saved),
  });
}

export function useBranch() {
  return useQuery({ queryKey: BRANCH_KEY, queryFn: () => apiFetch('/v1/branch') });
}

export function useSaveBranch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (branch) => apiFetch('/v1/branch', { method: 'PUT', body: branch }),
    onSuccess: (saved) => queryClient.setQueryData(BRANCH_KEY, saved),
  });
}

/** A short-lived download URL for a stored file (null key → no request). */
export function useFileUrl(key) {
  return useQuery({
    queryKey: ['file-url', key],
    queryFn: () => apiFetch('/v1/files/url', { query: { key } }),
    enabled: Boolean(key),
    staleTime: 4 * 60 * 1000,
  });
}

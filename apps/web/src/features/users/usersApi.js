import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api.js';

const USERS_KEY = ['users'];

export function useUsers() {
  return useQuery({ queryKey: USERS_KEY, queryFn: () => apiFetch('/v1/users') });
}

export function useCreateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (user) => apiFetch('/v1/users', { method: 'POST', body: user }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: USERS_KEY }),
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, changes }) => apiFetch(`/v1/users/${id}`, { method: 'PATCH', body: changes }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: USERS_KEY }),
  });
}

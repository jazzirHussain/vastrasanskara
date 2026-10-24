import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api.js';
import { ME_KEY } from '../lib/queryClient.js';
import { AuthContext } from './AuthContext.js';

// The signed-in user, or null when nobody is signed in.
async function fetchMe() {
  try {
    return await apiFetch('/v1/auth/me');
  } catch (err) {
    if (err.status === 401) return null;
    throw err;
  }
}

export function AuthProvider({ children }) {
  const queryClient = useQueryClient();
  const { data: user, isPending, error, refetch } = useQuery({
    queryKey: ME_KEY,
    queryFn: fetchMe,
    staleTime: Infinity,
  });

  const login = useCallback(
    async (email, password) => {
      const result = await apiFetch('/v1/auth/login', { method: 'POST', body: { email, password } });
      queryClient.setQueryData(ME_KEY, result.user);
      return result.user;
    },
    [queryClient],
  );

  const logout = useCallback(async () => {
    try {
      await apiFetch('/v1/auth/logout', { method: 'POST' });
    } finally {
      // Sign out in the cache, then drop everything else cached for the old user.
      // (clear() would also remove the 'me' query the provider is observing.)
      queryClient.setQueryData(ME_KEY, null);
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== ME_KEY[0] });
    }
  }, [queryClient]);

  const value = useMemo(
    () => ({
      user: user ?? null,
      loading: isPending,
      error,
      retry: refetch,
      can: (permission) => Boolean(user?.permissions?.includes(permission)),
      login,
      logout,
    }),
    [user, isPending, error, refetch, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';

export const ME_KEY = ['me'];

/**
 * One cache per app. Any request answered 401 means the session is gone: the signed-in
 * user is cleared, and RequireAuth sends them to /login.
 */
export function createQueryClient() {
  const onError = (error) => {
    if (error?.status === 401) queryClient.setQueryData(ME_KEY, null);
  };
  const queryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: { retry: (count, error) => error?.status >= 500 && count < 2, refetchOnWindowFocus: false },
    },
  });
  return queryClient;
}

import { QueryClient } from '@tanstack/react-query';

/**
 * One cache for the whole console. Lists are fresh for 60 s (stale-while-revalidate
 * after that, refetched on window focus); master-data lookups override to 10 min.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 10 * 60_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

/**
 * Mark everything stale after a write. Mounted queries refetch at once, the rest on
 * next use. Lookups (master data) are only refreshed when `lookups` is true.
 */
export function invalidateAfterWrite(opts: { lookups?: boolean } = {}) {
  void queryClient.invalidateQueries({ predicate: (q) => opts.lookups || q.queryKey[0] !== 'lookups' });
}

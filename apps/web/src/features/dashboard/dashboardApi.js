import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { apiFetch } from '../../lib/api.js';

const PRESET_KEY = 'vs.home.preset';
const FILTER_KEYS = ['preset', 'from', 'to', 'designerId', 'priority', 'customerType'];
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export const clean = (filters) => Object.fromEntries(Object.entries(filters).filter(([, v]) => v));

function rememberedPreset() {
  try {
    const p = localStorage.getItem(PRESET_KEY);
    return p && p !== 'custom' ? p : null;
  } catch {
    return null;
  }
}

/** Remembers the last preset on this device (a convenience; nothing breaks without it). */
export function rememberPreset(preset) {
  try {
    if (preset !== 'custom') localStorage.setItem(PRESET_KEY, preset);
  } catch {
    // private window or blocked storage
  }
}

/**
 * The Home filters, kept in the address (?preset=&from=&to=&designerId=&priority=&customerType=)
 * so Back keeps them. `setFilters(patch)` merges and replaces the address.
 */
export function useHomeFilters() {
  const [params, setParams] = useSearchParams();
  const filters = clean({ preset: params.get('preset') ?? rememberedPreset() ?? 'month', ...Object.fromEntries(FILTER_KEYS.slice(1).map((k) => [k, params.get(k)])) });
  const setFilters = (patch) => {
    const next = clean({ ...filters, ...patch });
    if (next.preset !== 'custom') {
      delete next.from;
      delete next.to;
    }
    if (patch.preset) rememberPreset(patch.preset);
    setParams(next, { replace: true });
  };
  return { filters, setFilters };
}

/** '?preset=month&…' for links that keep the filters (drill-down lists). */
export const filterQuery = (filters, extra = {}) => new URLSearchParams(clean({ ...filters, ...extra })).toString();

/** Whether the filters can be sent (a custom range needs both dates). */
export const filtersReady = (f) => f.preset !== 'custom' || (YMD.test(f.from ?? '') && YMD.test(f.to ?? ''));

/** GET /v1/dashboard for the filters, fresh for a minute; `refresh()` asks the server to recompute. */
export function useDashboard(filters) {
  const queryClient = useQueryClient();
  const key = ['dashboard', filters];
  const query = useQuery({
    queryKey: key,
    queryFn: () => apiFetch('/v1/dashboard', { query: clean(filters) }),
    staleTime: 60_000,
    enabled: filtersReady(filters),
  });
  const refresh = async () => {
    queryClient.setQueryData(key, await apiFetch('/v1/dashboard', { query: { ...clean(filters), fresh: '1' } }));
  };
  return { ...query, refresh };
}

/** The records behind one number, a page at a time (`key` picks one bar of a breakdown). */
export function useMetricRows(metric, filters, key) {
  return useInfiniteQuery({
    queryKey: ['dashboard', 'rows', metric, filters, key ?? null],
    queryFn: ({ pageParam }) => apiFetch(`/v1/dashboard/metrics/${metric}/rows`, { query: clean({ ...filters, key, cursor: pageParam }) }),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: filtersReady(filters),
  });
}

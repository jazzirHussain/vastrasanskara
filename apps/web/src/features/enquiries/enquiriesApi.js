import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { phone as phoneSchema } from '@vs/shared/schemas/common.js';
import { apiFetch } from '../../lib/api.js';

export const ENQUIRIES_KEY = ['enquiries'];

/** Enquiries of a view ('follow_ups', 'open', a status or 'all'), searched by `q`, a page at a time. */
export function useEnquiries({ view, q }) {
  return useInfiniteQuery({
    queryKey: [...ENQUIRIES_KEY, 'list', view, q ?? ''],
    queryFn: ({ pageParam }) => apiFetch('/v1/enquiries', { query: { view, q: q || undefined, cursor: pageParam } }),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

export function useEnquiry(id) {
  return useQuery({
    queryKey: [...ENQUIRIES_KEY, 'one', id],
    queryFn: () => apiFetch(`/v1/enquiries/${id}`).then((r) => r.enquiry),
    enabled: Boolean(id),
  });
}

/** Who the phone already is (a customer, an open enquiry); asks only once the number is valid. */
export function usePhoneCheck(phone) {
  const parsed = phoneSchema.safeParse(phone ?? '');
  const e164 = parsed.success ? parsed.data : null;
  return useQuery({
    queryKey: [...ENQUIRIES_KEY, 'check', e164],
    queryFn: () => apiFetch('/v1/enquiries/check-phone', { query: { phone: e164 } }),
    enabled: Boolean(e164),
    staleTime: 10_000,
  });
}

/** How many calls are due today (and how many are overdue). */
export function useFollowUpCount() {
  return useQuery({
    queryKey: [...ENQUIRIES_KEY, 'follow-ups'],
    queryFn: () => apiFetch('/v1/enquiries/follow-ups/count'),
  });
}

function useEnquiryMutation(fn) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (enquiry) => {
      if (enquiry?.id) queryClient.setQueryData([...ENQUIRIES_KEY, 'one', enquiry.id], enquiry);
      queryClient.invalidateQueries({ queryKey: ENQUIRIES_KEY });
    },
  });
}

/** Saves a new enquiry: `{ body, key }`, `key` made when the form opened and sent on every retry. */
export const useCreateEnquiry = () =>
  useEnquiryMutation(({ body, key }) => apiFetch('/v1/enquiries', { method: 'POST', body, idempotencyKey: key }).then((r) => r.enquiry));

const action = (id, path, method = 'POST') => (body) =>
  apiFetch(`/v1/enquiries/${id}${path}`, { method, body }).then((r) => r.enquiry);

export const useUpdateEnquiry = (id) => useEnquiryMutation(action(id, '', 'PATCH'));
export const useLogCall = (id) => useEnquiryMutation(action(id, '/call'));
export const useMarkLost = (id) => useEnquiryMutation(action(id, '/lost'));
export const useReopenEnquiry = (id) => useEnquiryMutation(action(id, '/reopen'));

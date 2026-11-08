import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api.js';
import { ENQUIRIES_KEY } from '../enquiries/enquiriesApi.js';

export const APPOINTMENTS_KEY = ['appointments'];

/** One day: a column per designer (only one's own for designers). */
export function useDay(date, designerId, { enabled = true } = {}) {
  return useQuery({
    queryKey: [...APPOINTMENTS_KEY, 'day', date, designerId ?? null],
    queryFn: () => apiFetch('/v1/appointments/day', { query: { date, designerId: designerId || undefined } }),
    enabled: enabled && Boolean(date),
    placeholderData: keepPreviousData,
  });
}

/** Appointments matching `filters` (customerId, enquiryId, from, to, …), a page at a time. */
export function useAppointments(filters, { enabled = true } = {}) {
  return useInfiniteQuery({
    queryKey: [...APPOINTMENTS_KEY, 'list', filters],
    queryFn: ({ pageParam }) => apiFetch('/v1/appointments', { query: { ...filters, cursor: pageParam } }),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

export function useAppointment(id) {
  return useQuery({
    queryKey: [...APPOINTMENTS_KEY, 'one', id],
    queryFn: () => apiFetch(`/v1/appointments/${id}`).then((r) => r.appointment),
    enabled: Boolean(id),
  });
}

// A booking change can move an enquiry to "appointment booked", so both lists refresh.
function useAppointmentMutation(fn) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: APPOINTMENTS_KEY });
      queryClient.invalidateQueries({ queryKey: ENQUIRIES_KEY });
    },
  });
}

/** Books: `{ body, key }`, `key` made when the page opened and sent on every retry. */
export const useBookAppointment = () =>
  useAppointmentMutation(({ body, key }) => apiFetch('/v1/appointments', { method: 'POST', body, idempotencyKey: key }).then((r) => r.appointment));

const action = (id, path, method = 'POST') => (body) =>
  apiFetch(`/v1/appointments/${id}${path}`, { method, body }).then((r) => r.appointment);

export const useMoveAppointment = (id) => useAppointmentMutation(action(id, '', 'PATCH'));
export const useCancelAppointment = (id) => useAppointmentMutation(action(id, '/cancel'));
export const useMarkAppointment = (id) => useAppointmentMutation(action(id, '/mark'));

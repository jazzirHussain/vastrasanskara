import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api.js';
import { ORDERS_KEY } from '../orders/ordersApi.js';

export const BILLING_KEY = ['billing'];
const invoiceKey = (id) => [...BILLING_KEY, 'invoice', id];
const pdfKey = (docId) => [...BILLING_KEY, 'pdf', docId];

/** Bills and orders show money from each other, so every billing write refreshes both. */
function useRefresh() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: BILLING_KEY }),
      queryClient.invalidateQueries({ queryKey: ORDERS_KEY }),
    ]);
}

/** A bill (draft, issued or cancelled) as GET /v1/billing/invoices/:id returns it. */
export function useInvoice(id) {
  return useQuery({
    queryKey: invoiceKey(id),
    queryFn: () => apiFetch(`/v1/billing/invoices/${id}`).then((r) => r.invoice),
  });
}

/** Opens the order's draft bill, making it from the garments and charges not yet billed. */
export function useCreateBillFromOrder() {
  const queryClient = useQueryClient();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (orderId) => apiFetch('/v1/billing/invoices/from-order', { method: 'POST', body: { orderId } }).then((r) => r.invoice),
    onSuccess: (invoice) => {
      queryClient.setQueryData(invoiceKey(invoice.id), invoice);
      return refresh();
    },
  });
}

/** Saves a draft: `{ version, lines, invoiceDiscount, notes }`. The saved bill replaces the cached one. */
export function useSaveDraft(id) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch(`/v1/billing/invoices/${id}`, { method: 'PUT', body }).then((r) => r.invoice),
    onSuccess: (invoice) => {
      queryClient.setQueryData(invoiceKey(id), invoice);
      // The bill itself is fresh; only what shows it elsewhere is re-read.
      queryClient.invalidateQueries({ queryKey: [...BILLING_KEY, 'order'] });
      queryClient.invalidateQueries({ queryKey: ORDERS_KEY });
    },
  });
}

export function useDeleteDraft(id) {
  const queryClient = useQueryClient();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: () => apiFetch(`/v1/billing/invoices/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: invoiceKey(id) });
      return refresh();
    },
  });
}

/**
 * Issues a draft: `{ version, key }`, where `key` is the Idempotency-Key made when the confirm
 * dialog opened and sent again on every retry, so a retry never issues twice.
 */
export function useIssueInvoice(id) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ version, key }) =>
      apiFetch(`/v1/billing/invoices/${id}/issue`, { method: 'POST', body: { version }, idempotencyKey: key }).then((r) => r.invoice),
    onSuccess: () => refresh(),
  });
}

/** { status, url, filename } of a billing document's PDF; with `poll`, re-asked every 5 s while it is being made. */
export function usePdfLink(docId, { poll = false, enabled = true } = {}) {
  return useQuery({
    queryKey: pdfKey(docId),
    queryFn: () => apiFetch(`/v1/billing/documents/${docId}/pdf`),
    enabled,
    // The signed link lasts 5 minutes: each print or share asks for a fresh one.
    staleTime: 0,
    refetchInterval: (query) => (poll && query.state.data?.status === 'pending' ? 5000 : false),
  });
}

/** What an order is worth, has been paid and billed, and its bills (GET /v1/billing/orders/:id/summary). */
export function useOrderMoney(orderId, { enabled = true } = {}) {
  return useQuery({
    queryKey: [...BILLING_KEY, 'order', orderId],
    queryFn: () => apiFetch(`/v1/billing/orders/${orderId}/summary`),
    enabled,
  });
}

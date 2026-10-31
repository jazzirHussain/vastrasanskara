import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

/** Deletes a draft. `onDeleted` runs first (leave the page), then the bill is dropped from the cache. */
export function useDeleteDraft(id, { onDeleted } = {}) {
  const queryClient = useQueryClient();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: () => apiFetch(`/v1/billing/invoices/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      onDeleted?.();
      await queryClient.cancelQueries({ queryKey: invoiceKey(id) });
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

/**
 * Records a payment: `{ body, key }`, where `key` is the Idempotency-Key made when the dialog
 * opened and sent again on every retry. Resolves to the receipt (with its voucher, if one was made).
 */
export function useRecordPayment() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ body, key }) => apiFetch('/v1/billing/payments', { method: 'POST', body, idempotencyKey: key }).then((r) => r.receipt),
    onSuccess: () => refresh(),
  });
}

/** A cursor-paged list under /v1/billing, a page at a time. */
function useBillingList(name, path, filters, enabled = true) {
  return useInfiniteQuery({
    queryKey: [...BILLING_KEY, name, filters],
    queryFn: ({ pageParam }) => apiFetch(path, { query: { ...filters, cursor: pageParam } }),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

/** Bills still owed, oldest due first: `{ items, totals: { count, balance, overdue } }` per page. Filters: bucket, customerId. */
export function useReceivables(filters) {
  return useBillingList('receivables', '/v1/billing/receivables', filters);
}

/** Bills (any status) matching status, payStatus, overdue, customerId, from, to, q. */
export function useInvoices(filters) {
  return useBillingList('invoices', '/v1/billing/invoices', filters);
}

/** Payments (receipts) matching from, to, mode, customerId. */
export function useReceipts(filters) {
  return useBillingList('receipts', '/v1/billing/payments', filters);
}

/** { billed, received, credited, refunded, outstanding, overdue, advanceHeld } for a customer. */
export function useCustomerMoney(customerId, { enabled = true } = {}) {
  return useQuery({
    queryKey: [...BILLING_KEY, 'customer', customerId, 'summary'],
    queryFn: () => apiFetch(`/v1/billing/customers/${customerId}/summary`),
    enabled,
  });
}

/** The customer's ledger, newest first, a page at a time. */
export function useCustomerLedger(customerId, { enabled = true } = {}) {
  return useBillingList(`customer-ledger-${customerId}`, `/v1/billing/customers/${customerId}/ledger`, {}, enabled);
}

/** Cancels an issued bill: `{ reason }`. Payments on it become advance. */
export function useCancelInvoice(id) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (body) => apiFetch(`/v1/billing/invoices/${id}/cancel`, { method: 'POST', body }).then((r) => r.invoice),
    onSuccess: () => refresh(),
  });
}

/** Pauses (`{ paused: true }`) or resumes the overdue reminders of a bill. */
export function useSetReminders(id) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (body) => apiFetch(`/v1/billing/invoices/${id}/reminders`, { method: 'PUT', body }).then((r) => r.invoice),
    onSuccess: () => refresh(),
  });
}

/**
 * Issues a credit note: `{ body: { reason, full, lines }, key }`, with the Idempotency-Key made
 * when the dialog opened. Resolves to `{ creditNote, warnings }`.
 */
export function useIssueCreditNote(invoiceId) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ body, key }) => apiFetch(`/v1/billing/invoices/${invoiceId}/credit-notes`, { method: 'POST', body, idempotencyKey: key }),
    onSuccess: () => refresh(),
  });
}

/** Cancels a payment: `{ id, reason }`. The money comes off any bills it paid. */
export function useCancelReceipt() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ id, reason }) => apiFetch(`/v1/billing/payments/${id}/cancel`, { method: 'POST', body: { reason } }).then((r) => r.receipt),
    onSuccess: () => refresh(),
  });
}

/** Gives money back from advance held: `{ body, key }`. Resolves to the refund. */
export function useIssueRefund() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ body, key }) => apiFetch('/v1/billing/refunds', { method: 'POST', body, idempotencyKey: key }).then((r) => r.refund),
    onSuccess: () => refresh(),
  });
}

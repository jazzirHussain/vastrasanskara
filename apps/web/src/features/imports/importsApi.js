import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api.js';
import { downloadFile } from '../../lib/download.js';
import { uploadFile } from '../../lib/upload.js';

export const IMPORTS_KEY = ['imports'];
const BUSY = new Set(['checking', 'importing']);
export const IMPORT_MAX_BYTES = 5242880;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Each kind of old record with its columns, in the order to bring them in. */
export function useImportKinds() {
  return useQuery({ queryKey: [...IMPORTS_KEY, 'kinds'], queryFn: () => apiFetch('/v1/imports/kinds').then((r) => r.kinds), staleTime: Infinity });
}

/** Recent imports, newest first; polls while one is being checked or added. */
export function useImports() {
  return useQuery({
    queryKey: [...IMPORTS_KEY, 'list'],
    queryFn: () => apiFetch('/v1/imports', { query: { limit: 100 } }),
    refetchInterval: (query) => ((query.state.data?.items ?? []).some((r) => BUSY.has(r.status)) ? 2000 : false),
  });
}

/** One import; polls every 2 s while it is being checked or added. */
export function useImport(id) {
  return useQuery({
    queryKey: [...IMPORTS_KEY, 'one', id],
    queryFn: () => apiFetch(`/v1/imports/${id}`).then((r) => r.import),
    refetchInterval: (query) => (BUSY.has(query.state.data?.status) ? 2000 : false),
  });
}

/** One import's rows with `status` (or all), a page at a time. */
export function useImportRows(id, status, { enabled = true } = {}) {
  return useInfiniteQuery({
    queryKey: [...IMPORTS_KEY, 'rows', id, status ?? 'all'],
    queryFn: ({ pageParam }) => apiFetch(`/v1/imports/${id}/rows`, { query: { status, cursor: pageParam, limit: 50 } }),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

// Phones and some Windows browsers give no type, or Excel's old one, for .csv and .xlsx files.
export function spreadsheetType(file) {
  if (/\.xlsx$/i.test(file.name)) return XLSX;
  if (/\.csv$/i.test(file.name)) return file.type === 'application/vnd.ms-excel' ? file.type : 'text/csv';
  return file.type || 'application/octet-stream';
}

/**
 * Uploads a filled file and asks for it to be checked: `mutate({ kind, file, asOf })`. One
 * Idempotency-Key per upload, reused when a network failure retries the request.
 */
export function useStartImport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ kind, file, asOf }) => {
      const fileKey = await uploadFile(file, 'import_file', { contentType: spreadsheetType(file) });
      const body = { kind, fileKey, fileName: file.name.slice(0, 120), ...(asOf && { asOf }) };
      return apiFetch('/v1/imports', { method: 'POST', body, idempotencyKey: crypto.randomUUID() }).then((r) => r.import);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: IMPORTS_KEY }),
  });
}

function useRunAction(id, action) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ version }) => apiFetch(`/v1/imports/${id}/${action}`, { method: 'POST', body: { version } }).then((r) => r.import),
    onSuccess: (run) => {
      queryClient.setQueryData([...IMPORTS_KEY, 'one', id], run);
      queryClient.invalidateQueries({ queryKey: IMPORTS_KEY });
    },
  });
}

export const useConfirmImport = (id) => useRunAction(id, 'confirm');
export const useCancelImport = (id) => useRunAction(id, 'cancel');
export const useResumeImport = (id) => useRunAction(id, 'resume');

/** Saves a kind's empty template ('xlsx' or 'csv'). */
export const downloadTemplate = (kind, format = 'xlsx') =>
  downloadFile(`/v1/imports/templates/${kind}`, { query: { format }, fallbackName: `template.${format}` });

/** Saves the rows of an import that need fixing, with "What to fix" beside each. */
export const downloadProblems = (id) => downloadFile(`/v1/imports/${id}/problems`, { fallbackName: 'rows to fix.xlsx' });

/** "customers", "price-list items"…: what an import of `kind` adds. */
export const RECORD_NOUNS = {
  customers: 'customers',
  vendors: 'vendors',
  workers: 'workers',
  catalog: 'price-list items',
  stock: 'stock items',
  orders: 'order lines',
  opening_balances: 'opening balances',
};

/** Where the added records can be seen. */
export const RECORD_LINKS = {
  customers: { to: '/customers', label: 'View customers' },
  vendors: { to: '/workshop', label: 'View vendors' },
  workers: { to: '/workshop', label: 'View workers' },
  catalog: { to: '/catalog', label: 'View the price list' },
  stock: { to: '/stock', label: 'View stock' },
  orders: { to: '/orders', label: 'View orders' },
  opening_balances: { to: '/bills?tab=owed', label: 'View money owed' },
};

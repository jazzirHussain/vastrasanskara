import { Alert, Loader, Stack, Text } from '@mantine/core';
import { LoadMore } from '../../components/LoadMore.jsx';
import { useImportRows } from './importsApi.js';

const STATUS_WORDS = { exists: 'Already in the system', skipped: 'Already in the system', added: 'Added' };

/** "Row 14 · Priya S — Phone: '98765' is not a 10-digit mobile number." */
export function rowText(row) {
  const what = row.errors.length
    ? row.errors.map((e) => (e.column ? `${e.column}: ${e.message}` : e.message)).join(' ')
    : STATUS_WORDS[row.status];
  const head = row.label ? `Row ${row.rowNo} · ${row.label}` : `Row ${row.rowNo}`;
  return what ? `${head} — ${what}` : head;
}

/** The rows of an import with one outcome, a page at a time. */
export function RowList({ id, status }) {
  const rows = useImportRows(id, status);
  const items = rows.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Stack gap={4} component="ul" style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label="Rows">
      {rows.isPending && <Loader size="sm" />}
      {rows.error && <Alert color="red">{rows.error.message}</Alert>}
      {rows.data && items.length === 0 && <Text c="var(--vs-muted)">No rows here.</Text>}
      {items.map((row) => (
        <li key={row.rowNo} className="vs-panel" style={{ padding: '8px 12px' }}>
          <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
            {rowText(row)}
          </Text>
        </li>
      ))}
      <LoadMore query={rows} />
    </Stack>
  );
}

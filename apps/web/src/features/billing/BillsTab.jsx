import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Chip, Group, Loader, Stack, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconSearch } from '@tabler/icons-react';
import { DateLabel } from '../../components/DateLabel.jsx';
import { EmptyState } from '../../components/EmptyState.jsx';
import { LoadMore } from '../../components/LoadMore.jsx';
import { Money } from '../../components/Money.jsx';
import { ResponsiveTable } from '../../components/ResponsiveTable.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { useInvoices } from './billingApi.js';
import { billBadge } from './billStatus.js';

const FILTERS = [
  { value: 'all', label: 'All', query: {} },
  { value: 'draft', label: 'Drafts', query: { status: 'draft' } },
  { value: 'unpaid', label: 'Unpaid', query: { status: 'issued', payStatus: 'unpaid' } },
  { value: 'part_paid', label: 'Part paid', query: { status: 'issued', payStatus: 'part_paid' } },
  { value: 'paid', label: 'Paid', query: { status: 'issued', payStatus: 'paid' } },
  { value: 'cancelled', label: 'Cancelled', query: { status: 'cancelled' } },
];

/** Every bill, newest first, filtered by status and searched by bill number. */
export function BillsTab() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim(), 250);
  const bills = useInvoices({ ...FILTERS.find((f) => f.value === filter).query, ...(q && { q }) });
  const rows = bills.data?.pages.flatMap((p) => p.items) ?? [];

  const columns = [
    {
      key: 'bill',
      header: 'Bill',
      primary: true,
      render: (b) => (
        <div>
          <Text fw={600} className="vs-figures">
            {b.number ?? 'Not issued yet'}
          </Text>
          <Text size="sm" c="var(--vs-muted)">
            {b.customer.name}
          </Text>
        </div>
      ),
    },
    { key: 'date', header: 'Date', render: (b) => (b.date ? <DateLabel ymd={b.date} relative={false} /> : '—') },
    { key: 'total', header: 'Total', align: 'right', render: (b) => <Money paise={b.total} style={{ fontWeight: 600 }} /> },
    { key: 'status', header: 'Status', render: (b) => <StatusBadge {...billBadge(b)} /> },
  ];

  return (
    <Stack gap="sm">
      <TextInput
        aria-label="Search bills"
        placeholder="Bill number"
        leftSection={<IconSearch size={16} aria-hidden="true" />}
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
        maw={420}
      />
      <Chip.Group multiple={false} value={filter} onChange={setFilter}>
        <Group gap="xs">
          {FILTERS.map((f) => (
            <Chip key={f.value} value={f.value} type="radio" variant="outline" size="sm">
              {f.label}
            </Chip>
          ))}
        </Group>
      </Chip.Group>
      {bills.isPending && <Loader />}
      {bills.error && <Alert color="red">{bills.error.message}</Alert>}
      {bills.data && rows.length === 0 && (
        <EmptyState
          title={q || filter !== 'all' ? 'No bills match' : 'No bills yet'}
          body={q || filter !== 'all' ? 'Try another filter or bill number.' : 'Open an order and tap "Create bill" to make the first one.'}
        />
      )}
      {rows.length > 0 && (
        <ResponsiveTable label="Bills" rows={rows} rowKey={(b) => b.id} onRowClick={(b) => navigate(`/bills/${b.id}`)} columns={columns} />
      )}
      <LoadMore query={bills} />
    </Stack>
  );
}

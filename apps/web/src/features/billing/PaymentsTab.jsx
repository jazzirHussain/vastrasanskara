import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Chip, Group, Loader, Stack, Text } from '@mantine/core';
import { addDaysYmd } from '@vs/shared/fy.js';
import { DateLabel, todayYmd } from '../../components/DateLabel.jsx';
import { EmptyState } from '../../components/EmptyState.jsx';
import { LoadMore } from '../../components/LoadMore.jsx';
import { Money } from '../../components/Money.jsx';
import { ResponsiveTable } from '../../components/ResponsiveTable.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { useReceipts } from './billingApi.js';
import { MODE_LABELS } from './billStatus.js';
import { PdfLinkButton } from './PdfButtons.jsx';

const FILTERS = [
  { value: 'today', label: 'Today', query: (today) => ({ from: today, to: today }) },
  { value: 'week', label: 'This week', query: (today) => ({ from: addDaysYmd(today, -6), to: today }) },
  { value: 'all', label: 'All', query: () => ({}) },
];

const columns = [
  {
    key: 'payment',
    header: 'Payment',
    primary: true,
    render: (r) => (
      <div>
        <Text fw={600}>{r.customer.name}</Text>
        <Group gap={4} wrap="nowrap">
          <Text size="sm" c="var(--vs-muted)" className="vs-figures">
            {r.number}
          </Text>
          <PdfLinkButton docId={r.id} name={`receipt ${r.number}`} />
        </Group>
      </div>
    ),
  },
  { key: 'date', header: 'Date', render: (r) => <DateLabel ymd={r.date} relative={false} /> },
  { key: 'mode', header: 'Paid by', render: (r) => <StatusBadge status="mode" label={MODE_LABELS[r.mode] ?? r.mode} /> },
  {
    key: 'amount',
    header: 'Amount',
    align: 'right',
    render: (r) => (
      <Group gap={8} justify="flex-end" wrap="nowrap">
        {r.status === 'cancelled' && <StatusBadge status="cancelled" />}
        <Money paise={r.amount} style={{ fontWeight: 700, textDecoration: r.status === 'cancelled' ? 'line-through' : undefined }} />
      </Group>
    ),
  },
];

/** Payments taken (receipts), newest first. */
export function PaymentsTab() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState('today');
  const payments = useReceipts(FILTERS.find((f) => f.value === filter).query(todayYmd()));
  const rows = payments.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Stack gap="sm">
      <Chip.Group multiple={false} value={filter} onChange={setFilter}>
        <Group gap="xs">
          {FILTERS.map((f) => (
            <Chip key={f.value} value={f.value} type="radio" variant="outline" size="sm">
              {f.label}
            </Chip>
          ))}
        </Group>
      </Chip.Group>
      {payments.isPending && <Loader />}
      {payments.error && <Alert color="red">{payments.error.message}</Alert>}
      {payments.data && rows.length === 0 && (
        <EmptyState
          title={filter === 'today' ? 'No payments today' : filter === 'week' ? 'No payments this week' : 'No payments yet'}
          body={filter === 'all' ? 'Payments are taken on an order, a bill or a customer page.' : 'Choose All to see earlier payments.'}
        />
      )}
      {rows.length > 0 && (
        <ResponsiveTable label="Payments" rows={rows} rowKey={(r) => r.id} onRowClick={(r) => navigate(`/customers/${r.customer.id}`)} columns={columns} />
      )}
      <LoadMore query={payments} />
    </Stack>
  );
}

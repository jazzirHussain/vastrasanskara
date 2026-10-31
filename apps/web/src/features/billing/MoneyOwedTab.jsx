import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Anchor, Button, Chip, Group, Loader, Stack, Text } from '@mantine/core';
import { useAuth } from '../../auth/AuthContext.js';
import { DateLabel } from '../../components/DateLabel.jsx';
import { EmptyState } from '../../components/EmptyState.jsx';
import { LoadMore } from '../../components/LoadMore.jsx';
import { Money } from '../../components/Money.jsx';
import { ResponsiveTable } from '../../components/ResponsiveTable.jsx';
import { useReceivables } from './billingApi.js';
import { TakePaymentDialog } from './TakePaymentDialog.jsx';

// The API's ageing buckets (days past the due date), in plain words.
const FILTERS = [
  { value: 'all', label: 'All', query: {} },
  { value: 'overdue', label: 'Overdue', query: { bucket: 'overdue' } },
  { value: 'd31_60', label: '31–60 days', query: { bucket: 'd31_60' } },
  { value: 'd61_90', label: '61–90 days', query: { bucket: 'd61_90' } },
  { value: 'd90_plus', label: 'Over 90 days', query: { bucket: 'd90_plus' } },
];

function Figure({ label, paise, tone, hint }) {
  return (
    <div>
      <Text size="sm" c="var(--vs-muted)">
        {label}
      </Text>
      <Money paise={paise} style={{ fontSize: 30, fontWeight: 700, lineHeight: 1.1, color: tone }} />
      {hint && (
        <Text size="sm" c="var(--vs-muted)">
          {hint}
        </Text>
      )}
    </div>
  );
}

/** Bills still unpaid, oldest due first, with the totals for the whole filter on top. */
export function MoneyOwedTab() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [filter, setFilter] = useState('all');
  const [paying, setPaying] = useState(null);
  const owed = useReceivables(FILTERS.find((f) => f.value === filter).query);
  const rows = owed.data?.pages.flatMap((p) => p.items) ?? [];
  const totals = owed.data?.pages[0].totals;

  const columns = [
    {
      key: 'customer',
      header: 'Customer',
      primary: true,
      render: (r) => (
        <Anchor component={Link} to={`/customers/${r.customer.id}`} onClick={(e) => e.stopPropagation()} fw={600} c="inherit">
          {r.customer.name}
        </Anchor>
      ),
    },
    { key: 'bill', header: 'Bill', render: (r) => <span className="vs-figures">{r.invoice.number}</span> },
    { key: 'due', header: 'Due', render: (r) => <DateLabel ymd={r.invoice.dueDate} /> },
    {
      key: 'balance',
      header: 'Owes',
      align: 'right',
      render: (r) => <Money paise={r.invoice.balance} style={{ fontWeight: 700, fontSize: 17 }} />,
    },
    {
      key: 'pay',
      header: '',
      render: (r) =>
        can('payments.record') && (
          <Button
            size="xs"
            variant="default"
            onClick={(e) => {
              e.stopPropagation();
              setPaying(r);
            }}
            aria-label={`Take payment from ${r.customer.name} for ${r.invoice.number}`}
          >
            Take payment
          </Button>
        ),
    },
  ];

  return (
    <Stack gap="md">
      {totals && (
        <section aria-label="Money owed summary" className="vs-panel" style={{ padding: 16 }}>
          <Group gap={40} wrap="wrap">
            <Figure label="Owed" paise={totals.balance} hint={`${totals.count} ${totals.count === 1 ? 'bill' : 'bills'}`} />
            <Figure label="Overdue" paise={totals.overdue} tone={totals.overdue > 0 ? 'var(--vs-kumkum)' : undefined} />
          </Group>
        </section>
      )}
      <Chip.Group multiple={false} value={filter} onChange={setFilter}>
        <Group gap="xs">
          {FILTERS.map((f) => (
            <Chip key={f.value} value={f.value} type="radio" variant="outline" size="sm">
              {f.label}
            </Chip>
          ))}
        </Group>
      </Chip.Group>
      {owed.isPending && <Loader />}
      {owed.error && <Alert color="red">{owed.error.message}</Alert>}
      {owed.data && rows.length === 0 && (
        <EmptyState
          title={filter === 'all' ? 'Nobody owes you money' : 'No bills here'}
          body={filter === 'all' ? 'Bills that are not fully paid show up here, oldest first.' : 'Try another filter, or choose All.'}
        />
      )}
      {rows.length > 0 && (
        <ResponsiveTable label="Money owed" rows={rows} rowKey={(r) => r.invoice.id} onRowClick={(r) => navigate(`/bills/${r.invoice.id}`)} columns={columns} />
      )}
      <LoadMore query={owed} />
      {paying && (
        <TakePaymentDialog
          customer={paying.customer}
          invoice={paying.invoice}
          defaultAmount={paying.invoice.balance}
          billBalance={paying.invoice.balance}
          onDone={() => setPaying(null)}
        />
      )}
    </Stack>
  );
}

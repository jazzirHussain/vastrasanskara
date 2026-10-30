import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Anchor, Button, Group, Loader, SimpleGrid, Text, Title } from '@mantine/core';
import { useAuth } from '../../auth/AuthContext.js';
import { DateLabel } from '../../components/DateLabel.jsx';
import { LoadMore } from '../../components/LoadMore.jsx';
import { Money } from '../../components/Money.jsx';
import { ResponsiveTable } from '../../components/ResponsiveTable.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { useCustomerLedger, useCustomerMoney } from './billingApi.js';
import { MODE_LABELS } from './billStatus.js';
import { TakePaymentDialog } from './TakePaymentDialog.jsx';

function Tile({ label, paise, tone }) {
  return (
    <div className="vs-panel" style={{ padding: 14 }}>
      <Text size="sm" c="var(--vs-muted)">
        {label}
      </Text>
      <Money paise={paise} style={{ fontSize: 24, fontWeight: 700, color: tone }} />
    </div>
  );
}

/** "Bill INV/2627/0012", "Payment (UPI)", "Credit note" or "Refund" for a ledger entry. */
function entryName(e) {
  switch (e.type) {
    case 'invoice':
      return `Bill ${e.number}`;
    case 'receipt': {
      const mode = /\((\w+)\)/.exec(e.label)?.[1];
      return mode ? `Payment (${MODE_LABELS[mode] ?? mode})` : 'Payment';
    }
    case 'credit_note':
      return 'Credit note';
    case 'refund':
      return 'Refund';
    default:
      return e.label;
  }
}

const columns = [
  { key: 'date', header: 'Date', hideOnPhone: true, render: (e) => <DateLabel ymd={e.date} relative={false} /> },
  {
    key: 'entry',
    header: 'What',
    primary: true,
    render: (e) => {
      const cancelled = e.status === 'cancelled';
      const name = <span style={cancelled ? { textDecoration: 'line-through' } : undefined}>{entryName(e)}</span>;
      return (
        <Group gap={8} wrap="wrap">
          {e.type === 'invoice' ? (
            <Anchor component={Link} to={`/bills/${e.id}`} c="inherit">
              {name}
            </Anchor>
          ) : (
            name
          )}
          {cancelled && <StatusBadge status="cancelled" />}
        </Group>
      );
    },
  },
  {
    key: 'amount',
    header: 'Amount',
    align: 'right',
    render: (e) => {
      const strike = e.status === 'cancelled' ? 'line-through' : undefined;
      // Money coming in (payments, credit notes) reads "+"; bills and refunds are what the customer owes.
      return e.credit > 0 ? (
        <span style={{ color: 'var(--vs-neem)', textDecoration: strike }}>
          +<Money paise={e.credit} />
        </span>
      ) : (
        <Money paise={e.debit} style={{ textDecoration: strike }} />
      );
    },
  },
  { key: 'balance', header: 'Owes after', align: 'right', render: (e) => <Money paise={e.balance} /> },
];

/** A customer's money: what they owe, what is overdue, advance held, and every bill and payment. */
export function CustomerMoney({ customer }) {
  const { can } = useAuth();
  const allowed = can('money.view');
  const summary = useCustomerMoney(customer.id, { enabled: allowed });
  const ledger = useCustomerLedger(customer.id, { enabled: allowed });
  const [paying, setPaying] = useState(false);
  if (!allowed) return null;
  const rows = ledger.data?.pages.flatMap((p) => p.items) ?? [];
  const s = summary.data;

  return (
    <section aria-label="Money" style={{ marginTop: 32 }}>
      <Group justify="space-between" mb="sm" wrap="wrap">
        <Title order={3}>Money</Title>
        {can('payments.record') && <Button onClick={() => setPaying(true)}>Take payment</Button>}
      </Group>
      {summary.error && <Alert color="red">{summary.error.message}</Alert>}
      {summary.isPending && <Loader size="sm" />}
      {s && (
        <SimpleGrid cols={{ base: 1, xs: 3 }} spacing="sm" mb="md">
          <Tile label="Owed" paise={s.outstanding} />
          <Tile label="Overdue" paise={s.overdue} tone={s.overdue > 0 ? 'var(--vs-kumkum)' : undefined} />
          <Tile label="Advance held" paise={s.advanceHeld} />
        </SimpleGrid>
      )}
      {ledger.isPending && <Loader size="sm" />}
      {ledger.error && <Alert color="red">{ledger.error.message}</Alert>}
      {ledger.data && rows.length === 0 && <Text c="var(--vs-muted)">No bills or payments yet.</Text>}
      {rows.length > 0 && <ResponsiveTable label="Ledger" rows={rows} rowKey={(e) => e.id} columns={columns} />}
      <LoadMore query={ledger} />
      {paying && (
        <TakePaymentDialog
          customer={{ id: customer.id, name: customer.name }}
          defaultAmount={s?.outstanding ?? 0}
          billBalance={s?.outstanding ?? 0}
          onDone={() => setPaying(false)}
        />
      )}
    </section>
  );
}

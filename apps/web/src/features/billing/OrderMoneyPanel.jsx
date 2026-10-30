import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Button, Group, Loader, Stack, Text } from '@mantine/core';
import { useAuth } from '../../auth/AuthContext.js';
import { Money } from '../../components/Money.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { billErrorMessage } from '../../lib/errorMessages.js';
import { useCreateBillFromOrder, useOrderMoney } from './billingApi.js';
import { billBadge } from './billStatus.js';
import { TakePaymentDialog } from './TakePaymentDialog.jsx';

function Figure({ label, paise, hint }) {
  return (
    <div>
      <Text size="xs" c="var(--vs-muted)">
        {label}
      </Text>
      <Money paise={paise} style={{ fontWeight: 600, fontSize: 18 }} />
      {hint && (
        <Text size="xs" c="var(--vs-muted)">
          {hint}
        </Text>
      )}
    </div>
  );
}

/**
 * The order's money for staff who see money: its value (GST is added on the bill), the advance
 * due and paid, what is billed and still owed, the main billing action ("Create bill", or
 * "Open draft bill" when there is one) and the order's bills.
 */
export function OrderMoneyPanel({ order }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const money = useOrderMoney(order.id);
  const create = useCreateBillFromOrder();
  const [paying, setPaying] = useState(false);

  if (money.isPending) return <Loader size="sm" mb="md" />;
  if (money.error) return <Alert color="red" mb="md">{money.error.message}</Alert>;
  const m = money.data;
  const advancePaid = m.receipts.filter((r) => r.status === 'issued').reduce((s, r) => s + r.amount, 0);
  const live = order.status !== 'cancelled';
  const canBill = can('billing.draft') && live;
  const canPay = can('payments.record') && live;
  const hasIssuedBill = m.invoices.some((b) => b.status === 'issued');

  return (
    <section aria-label="Money" className="vs-panel" style={{ padding: 20, marginBottom: 24 }}>
      <Stack gap="md">
        <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
          <Figure label="Order value" paise={m.orderValue} hint="GST will be added on the bill" />
          {/* Once billed, what is owed is the bill's balance, not an advance. */}
          {m.billed === 0 && <Figure label="Advance due" paise={m.advanceDue} />}
          <Figure label="Advance paid" paise={advancePaid} />
          <Figure label="Billed" paise={m.billed} />
          <Figure label="Balance due" paise={m.balanceDue} />
        </div>

        {(canBill || canPay) && (
          <Group gap="sm">
            {canBill &&
              (m.draftInvoiceId ? (
                <Button component={Link} to={`/bills/${m.draftInvoiceId}`} size="md">
                  Open draft bill
                </Button>
              ) : m.hasUnbilled ? (
                <Button
                  size="md"
                  loading={create.isPending}
                  onClick={() => create.mutate(order.id, { onSuccess: (invoice) => navigate(`/bills/${invoice.id}`) })}
                >
                  Create bill
                </Button>
              ) : (
                <Text size="sm" c="var(--vs-muted)">
                  Everything on this order is billed
                </Text>
              ))}
            {canPay && (
              <Button size="md" variant="default" onClick={() => setPaying(true)}>
                {hasIssuedBill ? 'Take payment' : 'Take advance'}
              </Button>
            )}
          </Group>
        )}
        {paying && (
          <TakePaymentDialog
            customer={order.customer}
            order={order}
            defaultAmount={hasIssuedBill ? m.balanceDue : m.advanceDue}
            billBalance={hasIssuedBill ? m.balanceDue : 0}
            onDone={() => setPaying(false)}
          />
        )}
        {create.error && <Alert color="red">{billErrorMessage(create.error)}</Alert>}

        {m.invoices.length > 0 && (
          <Stack gap={4}>
            <Text size="xs" c="var(--vs-muted)">
              Bills
            </Text>
            {m.invoices.map((inv) => {
              const badge = billBadge(inv);
              return (
                <Link key={inv.id} to={`/bills/${inv.id}`} className="vs-bill-link">
                  <span className="vs-figures" style={{ fontWeight: 600 }}>
                    {inv.number}
                  </span>
                  <Money paise={inv.total} />
                  <StatusBadge status={badge.status} label={badge.label} />
                </Link>
              );
            })}
          </Stack>
        )}
      </Stack>
    </section>
  );
}

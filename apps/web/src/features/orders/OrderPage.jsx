import { Link, useParams } from 'react-router-dom';
import { Alert, Anchor, Button, Group, Loader, Stack, Text } from '@mantine/core';
import { useAuth } from '../../auth/AuthContext.js';
import { DateLabel, todayYmd } from '../../components/DateLabel.jsx';
import { Money } from '../../components/Money.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { OrderMoneyPanel } from '../billing/OrderMoneyPanel.jsx';
import { OrderCosts } from '../costing/OrderCosts.jsx';
import { useSettings } from '../settings/settingsApi.js';
import { GarmentPanel } from './GarmentPanel.jsx';
import { OrderActions } from './OrderActions.jsx';
import { OrderFlags } from './OrdersPage.jsx';
import { isGarmentLate, isOpen } from './orderStatus.js';
import { useOrder, useOrderChange } from './ordersApi.js';

function Fact({ label, children }) {
  return (
    <div>
      <Text size="xs" c="var(--vs-muted)">
        {label}
      </Text>
      <div>{children}</div>
    </div>
  );
}

export function OrderPage() {
  const { id } = useParams();
  const order = useOrder(id);
  const settings = useSettings();
  const change = useOrderChange(id);
  const { can } = useAuth();

  if (order.isPending) return <Loader />;
  if (order.error) return <Alert color="red">{order.error.message}</Alert>;
  const o = order.data;
  const today = todayYmd();
  const typeLabel = (key) => settings.data?.garmentTypes.find((t) => t.key === key)?.label ?? key;
  const moved = o.pickupDate !== o.originalPickupDate;
  const openHold = o.holdHistory.find((h) => !h.to);

  return (
    <Stack gap={0}>
      <PageHeader title={o.orderNo} action={<OrderActions order={o} settings={settings.data} mutation={change} />}>
        <Group gap="sm">
          <Anchor component={Link} to={`/customers/${o.customer.id}`} fw={600}>
            {o.customer.name}
          </Anchor>
          <OrderFlags order={o} />
        </Group>
      </PageHeader>

      {change.error?.code === 'CONFLICT' && (
        <Alert color="haldi" mb="md">
          <Group justify="space-between">
            <Text size="sm">Someone else changed this order. Reload to see their changes.</Text>
            <Button size="xs" variant="white" color="haldi" onClick={() => { change.reset(); order.refetch(); }}>
              Reload
            </Button>
          </Group>
        </Alert>
      )}

      <div className="vs-panel" style={{ padding: 20, marginBottom: 24, display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <Fact label="Pickup">
          <DateLabel ymd={o.pickupDate} done={!isOpen(o)} />
          {moved && (
            <Text size="xs" c="var(--vs-muted)">
              Originally <DateLabel ymd={o.originalPickupDate} relative={false} />
            </Text>
          )}
        </Fact>
        {o.occasionDate && (
          <Fact label="Occasion">
            <DateLabel ymd={o.occasionDate} relative={false} />
          </Fact>
        )}
        <Fact label="Designer">{o.designer.name}</Fact>
        <Fact label="Taken">
          <DateLabel ymd={o.orderDate} relative={false} />
        </Fact>
        {o.expectedBudget !== undefined && o.expectedBudget !== null && (
          <Fact label="Expected budget">
            <Money paise={o.expectedBudget} />
          </Fact>
        )}
      </div>

      {can('money.view') && <OrderMoneyPanel order={o} />}
      {can('costing.view') && <OrderCosts orderId={o.id} />}

      {openHold && (
        <Alert color="haldi" mb="md" title="On hold">
          Since <DateLabel ymd={openHold.from} relative={false} />: {openHold.reason}
        </Alert>
      )}
      {o.cancellation && (
        <Alert color="gray" mb="md" title="Cancelled">
          {o.cancellation.reason}. Refund {o.cancellation.refundPercent}% of the advance.
        </Alert>
      )}
      {o.notes && (
        <Text mb="md" style={{ whiteSpace: 'pre-wrap' }}>
          {o.notes}
        </Text>
      )}

      <Stack gap="md">
        {o.garments.map((g) => (
          <GarmentPanel key={g.id} order={o} garment={g} typeLabel={typeLabel} late={isGarmentLate(g, o, today)} />
        ))}
      </Stack>
    </Stack>
  );
}

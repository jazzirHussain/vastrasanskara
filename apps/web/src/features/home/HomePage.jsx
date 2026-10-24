import { Link, useNavigate } from 'react-router-dom';
import { Button, Loader, Stack, Text, Title } from '@mantine/core';
import { addDaysYmd } from '@vs/shared/fy.js';
import { useAuth } from '../../auth/AuthContext.js';
import { todayYmd } from '../../components/DateLabel.jsx';
import { EmptyState } from '../../components/EmptyState.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { ResponsiveTable } from '../../components/ResponsiveTable.jsx';
import { orderColumns } from '../orders/OrdersPage.jsx';
import { useOrders } from '../orders/ordersApi.js';

function OrdersSection({ title, query, empty }) {
  const navigate = useNavigate();
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <section aria-label={title} style={{ marginBottom: 32 }}>
      <Title order={3} mb="sm">
        {title}
      </Title>
      {query.isPending && <Loader size="sm" />}
      {query.data && rows.length === 0 && empty}
      {rows.length > 0 && (
        <ResponsiveTable label={title} rows={rows} rowKey={(o) => o.id} onRowClick={(o) => navigate(`/orders/${o.id}`)} columns={orderColumns()} />
      )}
    </section>
  );
}

/** Greeting, the next two weeks of pickups and what is on hold. */
export function HomePage() {
  const { user, can } = useAuth();
  const canRead = can('orders.read.own');
  const today = todayYmd();
  const upcoming = useOrders({ status: 'active', pickupFrom: today, pickupTo: addDaysYmd(today, 14) }, { enabled: canRead });
  const onHold = useOrders({ status: 'on_hold' }, { enabled: canRead });

  return (
    <Stack gap={0}>
      <PageHeader title={`Welcome, ${user.name}`} />
      {canRead && (
        <>
          <OrdersSection
            title="Upcoming pickups"
            query={upcoming}
            empty={
              <EmptyState
                title="No pickups in the next two weeks."
                body={can('orders.write') ? 'New orders show here as their pickup dates come near.' : 'Your orders show here as their pickup dates come near.'}
                action={
                  can('orders.write') && (
                    <Button component={Link} to="/orders/new">
                      Take an order
                    </Button>
                  )
                }
              />
            }
          />
          <OrdersSection title="On hold" query={onHold} empty={<Text c="var(--vs-muted)">Nothing is on hold.</Text>} />
        </>
      )}
    </Stack>
  );
}

import { useNavigate } from 'react-router-dom';
import { Loader, Text, Title } from '@mantine/core';
import { useAuth } from '../../auth/AuthContext.js';
import { LoadMore } from '../../components/LoadMore.jsx';
import { ResponsiveTable } from '../../components/ResponsiveTable.jsx';
import { orderColumns } from '../orders/OrdersPage.jsx';
import { useOrders } from '../orders/ordersApi.js';

/** The customer's orders (a designer sees only their own). */
export function CustomerOrders({ customerId }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const orders = useOrders({ customerId }, { enabled: can('orders.read.own') });
  const rows = orders.data?.pages.flatMap((p) => p.items) ?? [];
  if (!can('orders.read.own')) return null;

  return (
    <section aria-label="Orders" style={{ marginTop: 32 }}>
      <Title order={3} mb="sm">
        Orders
      </Title>
      {orders.isPending && <Loader size="sm" />}
      {orders.data && rows.length === 0 && <Text c="var(--vs-muted)">No orders yet.</Text>}
      {rows.length > 0 && (
        <ResponsiveTable
          label="Customer orders"
          rows={rows}
          rowKey={(o) => o.id}
          onRowClick={(o) => navigate(`/orders/${o.id}`)}
          columns={orderColumns({ withCustomer: false })}
        />
      )}
      <LoadMore query={orders} />
    </section>
  );
}

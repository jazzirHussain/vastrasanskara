import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Button, Chip, Group, Loader, Stack, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconSearch } from '@tabler/icons-react';
import { addDaysYmd } from '@vs/shared/fy.js';
import { useAuth } from '../../auth/AuthContext.js';
import { DateLabel, todayYmd } from '../../components/DateLabel.jsx';
import { EmptyState } from '../../components/EmptyState.jsx';
import { LoadMore } from '../../components/LoadMore.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { ResponsiveTable } from '../../components/ResponsiveTable.jsx';
import { StageThread } from '../../components/StageThread.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { useOrders } from './ordersApi.js';

const FILTERS = [
  { value: 'active', label: 'Active', query: () => ({ status: 'active' }) },
  { value: 'on_hold', label: 'On hold', query: () => ({ status: 'on_hold' }) },
  { value: 'rush', label: 'Rush', query: () => ({ status: 'active', priority: 'rush' }) },
  { value: 'late', label: 'Late', query: () => ({ status: 'active' }), keep: (o) => o.late },
  {
    value: 'week',
    label: 'Pickup this week',
    query: (today) => ({ status: 'active', pickupFrom: today, pickupTo: addDaysYmd(today, 6) }),
  },
  { value: 'all', label: 'All', query: () => ({}) },
];

/** The rush, late and tight flags plus any status other than active. */
export function OrderFlags({ order }) {
  return (
    <Group gap={6} wrap="wrap">
      {order.status !== 'active' && <StatusBadge status={order.status} />}
      {order.priority === 'rush' && <StatusBadge status="rush" />}
      {order.late && <StatusBadge status="late" />}
      {order.tight && <StatusBadge status="tight" />}
    </Group>
  );
}

/** Order list columns, shared with the customer page and home. */
export function orderColumns({ withCustomer = true } = {}) {
  return [
    {
      key: 'order',
      header: 'Order',
      primary: true,
      render: (o) => (
        <div>
          <Text fw={600} className="vs-figures">
            {o.orderNo}
          </Text>
          {withCustomer && (
            <Text size="sm" c="var(--vs-muted)">
              {o.customer.name}
            </Text>
          )}
        </div>
      ),
    },
    { key: 'designer', header: 'Designer', hideOnPhone: true, render: (o) => o.designer.name },
    { key: 'pickup', header: 'Pickup', render: (o) => <DateLabel ymd={o.pickupDate} done={o.status !== 'active'} /> },
    {
      key: 'progress',
      header: 'Progress',
      render: (o) =>
        o.thread && (
          <StageThread
            stagePlan={o.thread.stagePlan}
            currentStage={o.thread.currentStage}
            status={o.thread.status}
            tight={o.thread.tightSchedule}
            late={o.late}
          />
        ),
    },
    { key: 'flags', header: '', render: (o) => <OrderFlags order={o} /> },
  ];
}

export function OrdersPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [filter, setFilter] = useState('active');
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim(), 250);
  const chosen = FILTERS.find((f) => f.value === filter);
  const orders = useOrders({ ...chosen.query(todayYmd()), ...(q && { q }) });
  const rows = (orders.data?.pages.flatMap((p) => p.items) ?? []).filter(chosen.keep ?? (() => true));

  return (
    <Stack gap={0}>
      <PageHeader
        title="Orders"
        action={
          can('orders.write') && (
            <Button component={Link} to="/orders/new">
              Take an order
            </Button>
          )
        }
      />
      <Stack gap="sm" mb="md">
        <TextInput
          aria-label="Search orders"
          placeholder="Order number or customer name"
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
      </Stack>
      {orders.isPending && <Loader />}
      {orders.error && <Alert color="red">{orders.error.message}</Alert>}
      {orders.data && rows.length === 0 && (
        <EmptyState
          title={q || filter !== 'active' ? 'No orders match' : 'No orders yet'}
          body={q || filter !== 'active' ? 'Try another filter or search.' : 'Take the first order.'}
          action={
            !q && filter === 'active' && can('orders.write') && (
              <Button component={Link} to="/orders/new">
                Take an order
              </Button>
            )
          }
        />
      )}
      {rows.length > 0 && (
        <ResponsiveTable label="Orders" rows={rows} rowKey={(o) => o.id} onRowClick={(o) => navigate(`/orders/${o.id}`)} columns={orderColumns()} />
      )}
      <LoadMore query={orders} />
    </Stack>
  );
}

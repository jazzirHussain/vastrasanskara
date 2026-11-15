import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ActionIcon, Button, Group, Loader, SimpleGrid, Stack, Text } from '@mantine/core';
import { IconCalendarEvent, IconPhoneCall, IconReceiptRupee, IconRefresh } from '@tabler/icons-react';
import { DASHBOARD_TILES } from '@vs/shared/dashboard.js';
import { useAuth } from '../../auth/AuthContext.js';
import { PageHeader } from '../../components/PageHeader.jsx';
import { messageFor } from '../../lib/errorMessages.js';
import { AttentionList } from './AttentionList.jsx';
import { FilterBar } from './FilterBar.jsx';
import { KeyNumbers } from './KeyNumbers.jsx';
import { useDashboard, useHomeFilters } from './dashboardApi.js';
import { CalendarTile } from './tiles/CalendarTile.jsx';
import { EnquiriesTile } from './tiles/EnquiriesTile.jsx';
import { ExpensesTile } from './tiles/ExpensesTile.jsx';
import { MoneyTile } from './tiles/MoneyTile.jsx';
import { PickupsTile } from './tiles/PickupsTile.jsx';
import { ProductionTile } from './tiles/ProductionTile.jsx';
import { ProfitTile } from './tiles/ProfitTile.jsx';
import { StockTile } from './tiles/StockTile.jsx';
import { WorkloadTile } from './tiles/WorkloadTile.jsx';

const TILES = {
  production: ProductionTile,
  pickups: PickupsTile,
  money: MoneyTile,
  calendar: CalendarTile,
  stock: StockTile,
  enquiries: EnquiriesTile,
  workload: WorkloadTile,
  expenses: ExpensesTile,
  profit: ProfitTile,
};

/** "Updated just now" / "Updated 3 min ago", ticking every 30 seconds. */
function Updated({ asOf }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const minutes = Math.max(0, Math.floor((now - new Date(asOf).getTime()) / 60_000));
  return (
    <Text size="sm" c="var(--vs-muted)">
      {minutes < 1 ? 'Updated just now' : `Updated ${minutes} min ago`}
    </Text>
  );
}

/** Home: what needs attention, the key numbers and a tile for each part of the business. */
export function DashboardPage() {
  const { user, can } = useAuth();
  const { filters, setFilters } = useHomeFilters();
  const dashboard = useDashboard(filters);
  const [refreshing, setRefreshing] = useState(false);
  const data = dashboard.data;

  const refresh = async () => {
    setRefreshing(true);
    try {
      await dashboard.refresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Stack gap={0}>
      <PageHeader title={`Welcome, ${user.name}`}>
        {data && (
          <Group gap={4} mt={4}>
            <Updated asOf={data.asOf} />
            <ActionIcon variant="subtle" size={44} aria-label="Refresh" onClick={refresh} loading={refreshing}>
              <IconRefresh size={20} aria-hidden />
            </ActionIcon>
          </Group>
        )}
      </PageHeader>
      <Group gap="sm" mb="lg">
        {can('enquiries.write') && (
          <Button component={Link} to="/enquiries/new" size="md" leftSection={<IconPhoneCall size={20} aria-hidden />}>
            New enquiry
          </Button>
        )}
        {can('appointments.write') && (
          <Button component={Link} to="/appointments/new" variant="outline" size="md" leftSection={<IconCalendarEvent size={20} aria-hidden />}>
            Book appointment
          </Button>
        )}
        {can('expenses.write') && (
          <Button component={Link} to="/expenses/new" variant="outline" size="md" leftSection={<IconReceiptRupee size={20} aria-hidden />}>
            Add expense
          </Button>
        )}
      </Group>
      <FilterBar filters={filters} setFilters={setFilters} />
      {dashboard.isPending && dashboard.fetchStatus !== 'idle' && <Loader size="sm" />}
      {dashboard.error && (
        <Text c="var(--vs-kumkum)" mb="md" role="alert">
          {messageFor(dashboard.error.code, dashboard.error.message)}
        </Text>
      )}
      {data && (
        <>
          <AttentionList tile={data.tiles.attention} filters={filters} />
          <KeyNumbers tile={data.tiles.key_numbers} filters={filters} />
          <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
            {DASHBOARD_TILES.filter((t) => TILES[t] && data.tiles[t]).map((t) => {
              const Tile = TILES[t];
              return <Tile key={t} tile={data.tiles[t]} filters={filters} />;
            })}
          </SimpleGrid>
        </>
      )}
    </Stack>
  );
}

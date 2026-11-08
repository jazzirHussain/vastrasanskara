import { Link, useNavigate } from 'react-router-dom';
import { Anchor, Button, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { IconCalendarEvent, IconPhoneCall, IconReceiptRupee } from '@tabler/icons-react';
import { APPOINTMENT_TYPE_LABELS } from '@vs/shared/frontOffice.js';
import { addDaysYmd } from '@vs/shared/fy.js';
import { useAuth } from '../../auth/AuthContext.js';
import { todayYmd } from '../../components/DateLabel.jsx';
import { EmptyState } from '../../components/EmptyState.jsx';
import { LoadMore } from '../../components/LoadMore.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { ResponsiveTable } from '../../components/ResponsiveTable.jsx';
import { orderColumns } from '../orders/OrdersPage.jsx';
import { useOrders } from '../orders/ordersApi.js';
import { timeRange, whoOf } from '../appointments/AppointmentCard.jsx';
import { useDay } from '../appointments/appointmentsApi.js';
import { useEnquiries } from '../enquiries/enquiriesApi.js';
import { interestText } from '../enquiries/EnquiriesPage.jsx';

/** "Follow-ups today": the first five calls due, with "See all". */
function FollowUpsSection() {
  const navigate = useNavigate();
  const query = useEnquiries({ view: 'follow_ups' });
  const rows = (query.data?.pages[0]?.items ?? []).slice(0, 5);
  return (
    <section aria-label="Follow-ups today" style={{ marginBottom: 32 }}>
      <Group justify="space-between" mb="sm">
        <Title order={3}>Follow-ups today</Title>
        <Anchor component={Link} to="/enquiries">
          See all
        </Anchor>
      </Group>
      {query.isPending && <Loader size="sm" />}
      {query.data && rows.length === 0 && <Text c="var(--vs-muted)">No calls due today.</Text>}
      {rows.length > 0 && (
        <ResponsiveTable
          label="Follow-ups today"
          rows={rows}
          rowKey={(e) => e.id}
          onRowClick={(e) => navigate(`/enquiries/${e.id}`)}
          columns={[
            { key: 'name', header: 'Name', primary: true, render: (e) => <Text fw={600}>{e.name}</Text> },
            { key: 'interest', header: 'Interested in', render: (e) => interestText(e) },
            { key: 'when', header: 'Call back', render: (e) => (e.overdue ? <Text span c="var(--vs-kumkum)" fw={600}>Overdue</Text> : 'Today') },
          ]}
        />
      )}
    </section>
  );
}

/** "Today's appointments": every designer's for front desk, one's own for a designer. */
function TodaySection({ today }) {
  const day = useDay(today);
  const items = (day.data?.designers ?? [])
    .flatMap((d) => d.appointments.map((a) => ({ ...a, designerName: d.name })))
    .sort((a, b) => a.start.localeCompare(b.start));
  return (
    <section aria-label="Today's appointments" style={{ marginBottom: 32 }}>
      <Group justify="space-between" mb="sm">
        <Title order={3}>Today&apos;s appointments</Title>
        <Anchor component={Link} to="/appointments">
          See the day
        </Anchor>
      </Group>
      {day.isPending && <Loader size="sm" />}
      {day.data && items.length === 0 && <Text c="var(--vs-muted)">No appointments today.</Text>}
      <Stack gap={6}>
        {items.map((a) => (
          <Text key={a.id} style={{ opacity: a.status === 'booked' ? 1 : 0.6 }}>
            <span className="vs-figures">{timeRange(a)}</span> · {APPOINTMENT_TYPE_LABELS[a.type]} · {whoOf(a).name} · {a.designerName}
          </Text>
        ))}
      </Stack>
    </section>
  );
}

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
      <LoadMore query={query} />
    </section>
  );
}

/** Greeting, the next two weeks of pickups (overdue ones first) and what is on hold. */
export function HomePage() {
  const { user, can } = useAuth();
  const canRead = can('orders.read.own');
  const today = todayYmd();
  const upcoming = useOrders({ status: 'active', pickupTo: addDaysYmd(today, 14) }, { enabled: canRead });
  const onHold = useOrders({ status: 'on_hold' }, { enabled: canRead });

  return (
    <Stack gap={0}>
      <PageHeader title={`Welcome, ${user.name}`} />
      <Group gap="sm" mb="xl">
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
      {can('enquiries.write') && <FollowUpsSection />}
      {can('appointments.own') && <TodaySection today={today} />}
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

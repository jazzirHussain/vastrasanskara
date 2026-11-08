import { Link } from 'react-router-dom';
import { Anchor, Button, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { APPOINTMENT_TYPE_LABELS, appointmentWhen } from '@vs/shared/frontOffice.js';
import { useAuth } from '../../auth/AuthContext.js';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { LoadMore } from '../../components/LoadMore.jsx';
import { useAppointments } from './appointmentsApi.js';

const CLOSED = { completed: ['completed', 'Done'], no_show: ['cancelled', "Didn't come"], cancelled: ['cancelled', 'Cancelled'] };

/** "Appointments" of a customer or an enquiry: upcoming ones first, then the rest; "Book appointment". */
export function PartyAppointments({ customerId, enquiryId }) {
  const { can } = useAuth();
  const filters = customerId ? { customerId } : { enquiryId };
  const query = useAppointments(filters);
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  const now = Date.now();
  const upcoming = rows.filter((a) => a.status === 'booked' && new Date(a.end).getTime() >= now);
  const rest = rows.filter((a) => !upcoming.includes(a)).reverse();
  const bookLink = `/appointments/new?${customerId ? `customerId=${customerId}` : `enquiryId=${enquiryId}`}`;
  return (
    <section aria-label="Appointments" style={{ marginTop: 24 }}>
      <Group justify="space-between" mb="sm">
        <Title order={3}>Appointments</Title>
        {can('appointments.write') && (
          <Button component={Link} to={bookLink} variant="light" size="sm">
            Book appointment
          </Button>
        )}
      </Group>
      {query.isPending && <Loader size="sm" />}
      {query.data && rows.length === 0 && <Text c="var(--vs-muted)">No appointments yet.</Text>}
      <Stack gap={6}>
        {[...upcoming, ...rest].map((a) => (
          <Group key={a.id} gap="xs" wrap="wrap">
            <Anchor component={Link} to={`/appointments?date=${a.date}`}>
              {`${APPOINTMENT_TYPE_LABELS[a.type]} with ${a.designer.name} — ${appointmentWhen(new Date(a.start))}`}
            </Anchor>
            {CLOSED[a.status] && <StatusBadge status={CLOSED[a.status][0]} label={CLOSED[a.status][1]} />}
          </Group>
        ))}
      </Stack>
      <LoadMore query={query} />
    </section>
  );
}

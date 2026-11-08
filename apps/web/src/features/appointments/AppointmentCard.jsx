import { useState } from 'react';
import { Anchor, Button, Group, Text } from '@mantine/core';
import { APPOINTMENT_TYPE_LABELS } from '@vs/shared/frontOffice.js';
import { istTime } from '@vs/shared/fy.js';
import { useAuth } from '../../auth/AuthContext.js';
import { todayYmd } from '../../components/DateLabel.jsx';
import { StatusBadge } from '../../components/StatusBadge.jsx';
import { displayPhone } from '../customers/CustomersPage.jsx';
import { useMarkAppointment } from './appointmentsApi.js';
import { time12 } from './bookingForm.js';
import { CancelDialog } from './CancelDialog.jsx';
import { MoveDialog } from './MoveDialog.jsx';

const CLOSED = { completed: ['completed', 'Done'], no_show: ['cancelled', "Didn't come"], cancelled: ['cancelled', 'Cancelled'] };

/** '11:00 am – 12:00 pm' for an appointment. */
export const timeRange = (a) => `${time12(a.time)} – ${time12(istTime(new Date(a.end)))}`;
/** Who the appointment is for: the customer, else the enquiry. */
export const whoOf = (a) => a.customer ?? a.enquiry ?? { name: '', phone: null };

/**
 * One appointment: time, type, who (phone as a call link), garments and note; done or no-show ones
 * are greyed. Front desk can move and cancel; from its day, "Done" / "Didn't come".
 */
export function AppointmentCard({ appointment: a }) {
  const { user, can } = useAuth();
  const frontDesk = can('appointments.write');
  const mark = useMarkAppointment(a.id);
  const [dialog, setDialog] = useState(null);
  const who = whoOf(a);
  const booked = a.status === 'booked';
  const canMark = booked && a.date <= todayYmd() && (frontDesk || a.designer?.id === user.id);
  const closed = CLOSED[a.status];
  const label = `${timeRange(a)} ${APPOINTMENT_TYPE_LABELS[a.type]} ${who.name}`;
  return (
    <article
      aria-label={label}
      className="vs-panel"
      style={{ padding: 12, opacity: booked ? 1 : 0.6, borderLeft: `4px solid var(--vs-${a.type === 'fitting' ? 'haldi' : 'indigo'})` }}
    >
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <Text fw={600} className="vs-figures">
          {timeRange(a)}
        </Text>
        {closed && <StatusBadge status={closed[0]} label={closed[1]} />}
      </Group>
      <Text size="sm" c="var(--vs-muted)">
        {APPOINTMENT_TYPE_LABELS[a.type]}
      </Text>
      <Group gap="xs" mt={4}>
        <Text fw={500}>{who.name}</Text>
        {!a.customer && a.enquiry && (
          <Text size="xs" c="var(--vs-muted)">
            (enquiry)
          </Text>
        )}
        {who.phone && (
          <Anchor href={`tel:${who.phone}`} size="sm" className="vs-figures">
            {displayPhone(who.phone)}
          </Anchor>
        )}
      </Group>
      {a.garments.length > 0 && (
        <Text size="sm" mt={4}>
          {a.garments.map((g) => `${g.garmentNo} ${g.description}`).join(', ')}
        </Text>
      )}
      {a.note && (
        <Text size="sm" mt={4} c="var(--vs-muted)">
          {a.note}
        </Text>
      )}
      {(canMark || (booked && frontDesk)) && (
        <Group gap="xs" mt="sm">
          {canMark && (
            <>
              <Button size="compact-sm" color="neem" loading={mark.isPending} onClick={() => mark.mutate({ version: a.version, status: 'completed' })}>
                Done
              </Button>
              <Button size="compact-sm" variant="default" disabled={mark.isPending} onClick={() => mark.mutate({ version: a.version, status: 'no_show' })}>
                Didn&apos;t come
              </Button>
            </>
          )}
          {booked && frontDesk && (
            <>
              <Button size="compact-sm" variant="light" onClick={() => setDialog('move')}>
                Move
              </Button>
              <Button size="compact-sm" variant="subtle" color="kumkum" onClick={() => setDialog('cancel')}>
                Cancel appointment
              </Button>
            </>
          )}
        </Group>
      )}
      {mark.error && (
        <Text size="sm" c="red" mt={4} role="alert">
          {mark.error.message}
        </Text>
      )}
      {dialog === 'move' && <MoveDialog appointment={a} onClose={() => setDialog(null)} />}
      {dialog === 'cancel' && <CancelDialog appointment={a} onClose={() => setDialog(null)} />}
    </article>
  );
}

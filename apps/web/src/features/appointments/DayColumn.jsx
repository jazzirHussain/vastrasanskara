import { useNavigate } from 'react-router-dom';
import { Stack, Text, Title, UnstyledButton } from '@mantine/core';
import { AppointmentCard } from './AppointmentCard.jsx';
import { freeGaps, time12 } from './bookingForm.js';

const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * One designer's day: appointments in time order with the free stretches between them. Front desk
 * taps a free stretch to book there.
 */
export function DayColumn({ column, date, settings, canBook }) {
  const navigate = useNavigate();
  const gaps = freeGaps(column.appointments, { date, settings, now: new Date() });
  const items = [
    ...column.appointments.map((a) => ({ at: minutesOf(a.time), key: a.id, node: <AppointmentCard appointment={a} /> })),
    ...gaps.map((g) => {
      const text = `Free ${time12(g.from)} – ${time12(g.to)}`;
      const style = { display: 'block', width: '100%', padding: '8px 12px', border: '1px dashed var(--vs-rule)', borderRadius: 8, color: 'var(--vs-muted)' };
      return {
        at: minutesOf(g.from),
        key: `free-${g.from}`,
        node: canBook ? (
          <UnstyledButton style={style} onClick={() => navigate(`/appointments/new?designerId=${column.id}&date=${date}&time=${g.from}`)}>
            {text}
          </UnstyledButton>
        ) : (
          <Text style={style}>{text}</Text>
        ),
      };
    }),
  ].sort((x, y) => x.at - y.at);
  return (
    <section aria-label={column.name ?? 'Designer'} style={{ minWidth: 0 }}>
      <Title order={4} mb="xs">
        {column.name}
      </Title>
      <Stack gap="xs">
        {items.map((i) => (
          <div key={i.key}>{i.node}</div>
        ))}
        {items.length === 0 && (
          <Text size="sm" c="var(--vs-muted)">
            Nothing booked.
          </Text>
        )}
      </Stack>
    </section>
  );
}

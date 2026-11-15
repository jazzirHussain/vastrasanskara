import { Link } from 'react-router-dom';
import { Badge, Stack, Text, UnstyledButton } from '@mantine/core';
import { DateLabel } from '../../../components/DateLabel.jsx';
import { TileCard } from './TileCard.jsx';

const PAYMENT = {
  paid: ['Paid', 'neem'],
  part_paid: ['Part paid', 'haldi'],
  unpaid: ['Not paid', 'kumkum'],
  advance_only: ['Advance taken', 'indigo'],
  nothing_yet: ['Nothing paid', 'gray'],
};

/** Orders picking up in the next 14 days, by day; payment shows only for money users. */
export function PickupsTile({ tile, filters }) {
  const figure = tile.metrics?.upcoming_pickups;
  const next = figure?.next ?? [];
  const days = [...new Set(next.map((p) => p.pickupDate))];
  return (
    <TileCard title="Pickups" explain="Orders to hand over in the next 14 days." tile={tile} metric="upcoming_pickups" filters={filters}>
      {next.length === 0 && <Text c="var(--vs-muted)">No pickups in the next two weeks.</Text>}
      <Stack gap="sm">
        {days.map((day) => (
          <div key={day}>
            <Text size="sm" fw={600}>
              <DateLabel ymd={day} />
            </Text>
            {next
              .filter((p) => p.pickupDate === day)
              .map((p) => (
                <UnstyledButton key={p.orderId} component={Link} to={`/orders/${p.orderId}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, minHeight: 44, alignItems: 'center' }}>
                  <span>
                    <Text span size="sm">
                      {p.orderNo} · {p.customerName}
                    </Text>
                    <Text span size="xs" c="var(--vs-muted)" display="block">
                      {p.ready} of {p.garments} ready
                    </Text>
                  </span>
                  {p.payment && (
                    <Badge variant="light" color={PAYMENT[p.payment.status]?.[1]}>
                      {PAYMENT[p.payment.status]?.[0]}
                    </Badge>
                  )}
                </UnstyledButton>
              ))}
          </div>
        ))}
      </Stack>
      {figure?.count > next.length && (
        <Text size="sm" c="var(--vs-muted)" mt="xs">
          {figure.count - next.length} more in the next two weeks
        </Text>
      )}
    </TileCard>
  );
}

import { Link } from 'react-router-dom';
import { Stack, Text, UnstyledButton } from '@mantine/core';
import { TileCard, barLink } from './TileCard.jsx';

/** Today's appointments per designer. */
export function CalendarTile({ tile, filters }) {
  const figure = tile.metrics?.appointments_today;
  const designers = figure?.breakdown ?? [];
  return (
    <TileCard title="Today’s calendar" explain="Appointments booked for today, by designer." tile={tile} metric="appointments_today" filters={filters}>
      {designers.length === 0 && <Text c="var(--vs-muted)">No appointments today.</Text>}
      <Stack gap={0}>
        {designers.map((d) => (
          <UnstyledButton
            key={d.key}
            component={Link}
            to={barLink('appointments_today', filters, d.key)}
            style={{ display: 'flex', justifyContent: 'space-between', minHeight: 44, alignItems: 'center' }}
          >
            <Text span size="sm">
              {d.label}
            </Text>
            <Text span size="sm" c="var(--vs-muted)">
              {d.count === 1 ? '1 appointment' : `${d.count} appointments`}
            </Text>
          </UnstyledButton>
        ))}
      </Stack>
    </TileCard>
  );
}

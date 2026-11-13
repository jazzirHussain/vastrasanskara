import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ActionIcon, Alert, Anchor, Button, Chip, Group, Loader, Stack, Text, TextInput } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { addDaysYmd } from '@vs/shared/fy.js';
import { useAuth } from '../../auth/AuthContext.js';
import { shortDate, todayYmd } from '../../components/DateLabel.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { PHONE_QUERY } from '../../components/ResponsiveTable.jsx';
import { useSettings } from '../settings/settingsApi.js';
import { useDay } from './appointmentsApi.js';
import { DayColumn } from './DayColumn.jsx';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** "Appointments": one day, a column per designer (designers see their own); move between days. */
export function AppointmentsPage() {
  const { can } = useAuth();
  const canBook = can('appointments.write');
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const [params, setParams] = useSearchParams();
  const today = todayYmd();
  const date = YMD.test(params.get('date') ?? '') ? params.get('date') : today;
  const [only, setOnly] = useState('all');
  const [picking, setPicking] = useState(false);
  const settings = useSettings();
  const day = useDay(date);
  const go = (next) => setParams({ date: next }, { replace: true });
  const columns = day.data?.date === date ? day.data.designers : [];
  const shown = phone && canBook && only !== 'all' ? columns.filter((c) => c.id === only) : columns;
  const dayText = `${date === today ? 'Today, ' : date === addDaysYmd(today, 1) ? 'Tomorrow, ' : ''}${shortDate(date)}`;

  return (
    <Stack gap="md">
      <PageHeader
        title="Appointments"
        action={
          canBook && (
            <Button component={Link} to={`/appointments/new?date=${date}`}>
              Book appointment
            </Button>
          )
        }
      />
      <Group gap="xs">
        <ActionIcon variant="default" size="lg" aria-label="Previous day" onClick={() => go(addDaysYmd(date, -1))}>
          <IconChevronLeft size={18} aria-hidden="true" />
        </ActionIcon>
        <Text fw={600} className="vs-figures" style={{ minWidth: 150, textAlign: 'center' }}>
          {dayText}
        </Text>
        <ActionIcon variant="default" size="lg" aria-label="Next day" onClick={() => go(addDaysYmd(date, 1))}>
          <IconChevronRight size={18} aria-hidden="true" />
        </ActionIcon>
        {date !== today && (
          <Anchor component="button" type="button" size="sm" onClick={() => go(today)}>
            Today
          </Anchor>
        )}
        {picking ? (
          <TextInput type="date" aria-label="Pick a date" size="sm" value={date} onChange={(e) => e.currentTarget.value && go(e.currentTarget.value)} />
        ) : (
          <Anchor component="button" type="button" size="sm" onClick={() => setPicking(true)}>
            Pick a date
          </Anchor>
        )}
      </Group>
      {phone && canBook && columns.length > 1 && (
        <Chip.Group multiple={false} value={only} onChange={setOnly}>
          <Group gap="xs">
            <Chip value="all" type="radio" variant="outline">
              All
            </Chip>
            {columns.map((c) => (
              <Chip key={c.id} value={c.id} type="radio" variant="outline">
                {c.name}
              </Chip>
            ))}
          </Group>
        </Chip.Group>
      )}
      {(day.isPending || settings.isPending) && <Loader />}
      {(day.error || settings.error) && <Alert color="red">{(day.error ?? settings.error).message}</Alert>}
      {settings.data && day.data && columns.length === 0 && <Text c="var(--vs-muted)">No designers yet.</Text>}
      {settings.data && columns.length > 0 && (
        <div
          style={{
            display: 'grid',
            gap: 16,
            gridTemplateColumns: phone ? '1fr' : `repeat(${shown.length}, minmax(220px, 1fr))`,
            overflowX: phone ? 'visible' : 'auto',
          }}
        >
          {shown.map((c) => (
            <DayColumn
              key={c.id}
              column={c}
              date={date}
              settings={{ ...settings.data, openingTime: day.data.openingTime, closingTime: day.data.closingTime }}
              canBook={canBook}
            />
          ))}
        </div>
      )}
    </Stack>
  );
}

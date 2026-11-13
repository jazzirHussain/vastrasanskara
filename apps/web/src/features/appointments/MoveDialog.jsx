import { useState } from 'react';
import { Alert, Button, Chip, Group, Modal, NumberInput, Stack, Text, TextInput } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { todayYmd } from '../../components/DateLabel.jsx';
import { PHONE_QUERY } from '../../components/ResponsiveTable.jsx';
import { useDesigners } from '../orders/ordersApi.js';
import { useSettings } from '../settings/settingsApi.js';
import { useDay, useMoveAppointment } from './appointmentsApi.js';
import { timeChoices } from './bookingForm.js';
import { TimeChips } from './TimeChips.jsx';

const MOVE_ERRORS = { SLOT_TAKEN: 'That time was just booked. Pick another time.' };

/** "Move": another day, time, length or designer; only free times are offered. */
export function MoveDialog({ appointment: a, onClose }) {
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const settings = useSettings();
  const designers = useDesigners();
  const move = useMoveAppointment(a.id);
  const [date, setDate] = useState(a.date);
  const [time, setTime] = useState(a.time);
  const [minutes, setMinutes] = useState(a.minutes);
  const [designerId, setDesignerId] = useState(a.designer.id);
  const day = useDay(date);
  const choices =
    settings.data && day.data?.date === date
      ? timeChoices(day.data, { designerId, minutes, settings: settings.data, now: new Date(), exceptId: a.id })
      : [];
  const patch = {
    ...(date !== a.date ? { date } : {}),
    ...(time !== a.time ? { time } : {}),
    ...(minutes !== a.minutes ? { minutes } : {}),
    ...(designerId !== a.designer.id ? { designerId } : {}),
  };
  const changed = Object.keys(patch).length > 0;

  async function save() {
    try {
      await move.mutateAsync({ version: a.version, ...patch });
      onClose();
    } catch (err) {
      if (err?.code === 'SLOT_TAKEN') day.refetch();
    }
  }

  return (
    <Modal opened title="Move appointment" centered={!phone} fullScreen={phone} size="lg" onClose={move.isPending ? () => {} : onClose}>
      <Stack gap="md">
        <TextInput label="Day" type="date" size="md" min={todayYmd()} value={date} onChange={(e) => e.currentTarget.value && setDate(e.currentTarget.value)} />
        <div role="group" aria-label="Designer">
          <Text size="md" fw={500} mb={6}>
            Designer
          </Text>
          <Chip.Group multiple={false} value={designerId} onChange={setDesignerId}>
            <Group gap="xs">
              {(designers.data?.items ?? []).map((d) => (
                <Chip key={d.id} value={d.id} type="radio" variant="outline">
                  {d.name}
                </Chip>
              ))}
            </Group>
          </Chip.Group>
        </div>
        <NumberInput label="Minutes" size="md" min={5} max={480} step={15} value={minutes} onChange={(v) => setMinutes(Number(v) || 0)} maw={160} />
        <TimeChips key={`${designerId}:${date}:${minutes}`} choices={choices} value={time} loading={day.isPending} onChange={setTime} />
        {move.error && <Alert color="red">{MOVE_ERRORS[move.error.code] ?? move.error.message}</Alert>}
        <Group justify="flex-end" grow={phone}>
          <Button variant="default" size="md" onClick={onClose} disabled={move.isPending}>
            Go back
          </Button>
          <Button size="md" disabled={!changed || !time} loading={move.isPending} onClick={save}>
            Move appointment
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

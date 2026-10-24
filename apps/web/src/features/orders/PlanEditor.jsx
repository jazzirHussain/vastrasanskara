import { useState } from 'react';
import { Alert, Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { STAGES } from '@vs/shared/stages.js';
import { shortDate } from '../../components/DateLabel.jsx';
import { useGarmentPlan } from './ordersApi.js';

// Order taken is fixed on the order date and Picked up is never planned.
const EDITABLE = STAGES.filter((s) => s.key !== 'order_taken' && s.key !== 'picked_up');

/** Planned dates by hand, one date per stage; the first planned date shows struck through once changed. */
export function PlanEditor({ orderId, garment, opened, onClose }) {
  const plan = useGarmentPlan(orderId, garment.id);
  const planned = Object.fromEntries(garment.stagePlan.map((s) => [s.stage, s]));
  const [dates, setDates] = useState(() => Object.fromEntries(garment.stagePlan.map((s) => [s.stage, s.plannedDate ?? ''])));
  const changes = EDITABLE.filter((s) => dates[s.key] && dates[s.key] !== planned[s.key]?.plannedDate).map((s) => ({
    stage: s.key,
    plannedDate: dates[s.key],
  }));

  function save() {
    plan.mutate({ version: garment.version, changes }, { onSuccess: onClose });
  }

  return (
    <Modal opened={opened} onClose={onClose} title={`Adjust plan for ${garment.description}`} size="md">
      <Stack gap="xs">
        <Text size="sm" c="var(--vs-muted)">
          Dates must follow the stage order and fall between today and the due date.
        </Text>
        {EDITABLE.map((s) => {
          const entry = planned[s.key];
          const original = entry?.originalPlannedDate;
          const moved = original && dates[s.key] && dates[s.key] !== original;
          return (
            <Group key={s.key} justify="space-between" wrap="nowrap" gap="sm">
              <TextInput
                label={s.label}
                type="date"
                disabled={entry?.skipped}
                value={dates[s.key]}
                onChange={(e) => setDates((d) => ({ ...d, [s.key]: e.currentTarget.value }))}
                style={{ flex: 1 }}
              />
              <Text size="sm" c="var(--vs-muted)" mt={22} w={110} ta="right" td={moved ? 'line-through' : undefined}>
                {moved ? shortDate(original) : ''}
              </Text>
            </Group>
          );
        })}
        {plan.error && <Alert color="red">{plan.error.message}</Alert>}
        <Group justify="flex-end" mt="sm">
          <Button variant="default" onClick={onClose}>
            Close
          </Button>
          <Button onClick={save} disabled={changes.length === 0} loading={plan.isPending}>
            Save plan
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

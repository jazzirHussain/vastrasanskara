import { ActionIcon, Button, Group, NumberInput, Select, Stack, Text, Title } from '@mantine/core';
import { STAGES } from '@vs/shared/stages.js';

const STAGE_OPTIONS = STAGES.map((s) => ({ value: s.key, label: s.label }));
const toPaise = (rupees) => (rupees === '' ? '' : Math.round(Number(rupees) * 100));

export function MoneyTab({ values, set, errors }) {
  const schedule = values.cancellationRefundSchedule;
  const setRow = (index, field) => (value) =>
    set(
      'cancellationRefundSchedule',
      schedule.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    );

  return (
    <Stack>
      <NumberInput
        label="Advance at order (%)"
        min={0}
        max={100}
        value={values.advancePercent}
        onChange={(v) => set('advancePercent', v)}
        error={errors.advancePercent}
      />
      <NumberInput
        label="Bill due days"
        description="Days after the invoice date that payment is due"
        min={0}
        value={values.billDueDays}
        onChange={(v) => set('billDueDays', v)}
        error={errors.billDueDays}
      />
      <NumberInput
        label="B2CL threshold (₹)"
        description="Inter-state invoices to unregistered buyers above this are reported as B2CL"
        min={0}
        decimalScale={2}
        thousandSeparator=","
        thousandsGroupStyle="lakh"
        value={values.b2clThreshold === '' ? '' : values.b2clThreshold / 100}
        onChange={(v) => set('b2clThreshold', toPaise(v))}
        error={errors.b2clThreshold}
      />

      <Title order={4}>Cancellation refund schedule</Title>
      <Text size="sm" c="dimmed">
        How much of the advance is refunded if an order is cancelled up to each stage.
      </Text>
      {schedule.map((row, index) => (
        <Group key={index} align="flex-end">
          <Select
            label="Up to stage"
            data={STAGE_OPTIONS}
            value={row.uptoStage}
            onChange={setRow(index, 'uptoStage')}
            error={errors[`cancellationRefundSchedule.${index}.uptoStage`]}
          />
          <NumberInput
            label="Refund (%)"
            min={0}
            max={100}
            value={row.refundPercent}
            onChange={setRow(index, 'refundPercent')}
            error={errors[`cancellationRefundSchedule.${index}.refundPercent`]}
          />
          <ActionIcon
            variant="subtle"
            color="red"
            aria-label="Remove row"
            onClick={() => set('cancellationRefundSchedule', schedule.filter((_, i) => i !== index))}
          >
            ✕
          </ActionIcon>
        </Group>
      ))}
      <Group>
        <Button
          variant="light"
          onClick={() =>
            set('cancellationRefundSchedule', [...schedule, { uptoStage: STAGES[0].key, refundPercent: 0 }])
          }
        >
          Add refund rule
        </Button>
      </Group>
    </Stack>
  );
}

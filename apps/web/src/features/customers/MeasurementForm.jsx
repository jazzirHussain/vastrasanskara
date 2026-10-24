import { useState } from 'react';
import { Alert, Button, Group, NumberInput, SegmentedControl, Select, SimpleGrid, Stack, Text, Textarea } from '@mantine/core';
import { fieldErrors } from '../../lib/fieldErrors.js';

/**
 * A new set of measurements: pick the garment type and its fields appear as number inputs,
 * all in inches or all in centimetres. Empty fields are left out.
 */
export function MeasurementForm({ garmentTypes, mutation, onSaved, initialType = null }) {
  const [type, setType] = useState(initialType);
  const [unit, setUnit] = useState('in');
  const [values, setValues] = useState({});
  const [notes, setNotes] = useState('');
  const fields = garmentTypes.find((t) => t.key === type)?.measurementFields ?? [];
  const errors = fieldErrors(mutation.error);
  const entered = fields.filter((name) => typeof values[name] === 'number' && values[name] > 0);

  function submit(event) {
    event.preventDefault();
    mutation.mutate(
      { garmentType: type, values: entered.map((name) => ({ name, value: values[name], unit })), notes: notes.trim() },
      { onSuccess: onSaved },
    );
  }

  return (
    <form onSubmit={submit}>
      <Stack>
        {mutation.error && mutation.error.code !== 'VALIDATION_FAILED' && <Alert color="red">{mutation.error.message}</Alert>}
        <Group align="flex-end" justify="space-between">
          <Select
            label="Garment type"
            data={garmentTypes.map((t) => ({ value: t.key, label: t.label }))}
            value={type}
            onChange={(v) => {
              setType(v);
              setValues({});
            }}
            allowDeselect={false}
            error={errors.garmentType}
            style={{ flex: 1, minWidth: 180 }}
          />
          <SegmentedControl
            aria-label="Unit"
            value={unit}
            onChange={setUnit}
            data={[
              { value: 'in', label: 'in' },
              { value: 'cm', label: 'cm' },
            ]}
          />
        </Group>
        {type && fields.length === 0 && (
          <Text c="var(--vs-muted)" size="sm">
            This garment type has no measurement fields yet. Add them in Settings → Garment types.
          </Text>
        )}
        <SimpleGrid cols={{ base: 2, xs: 3 }}>
          {fields.map((name) => (
            <NumberInput
              key={name}
              label={name}
              min={0}
              max={500}
              decimalScale={2}
              hideControls
              inputMode="decimal"
              rightSection={<Text size="xs" c="var(--vs-muted)">{unit}</Text>}
              value={values[name] ?? ''}
              onChange={(v) => setValues((current) => ({ ...current, [name]: v === '' ? undefined : Number(v) }))}
            />
          ))}
        </SimpleGrid>
        {errors.values && <Text c="red" size="sm">{errors.values}</Text>}
        {type && <Textarea label="Notes" autosize minRows={2} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />}
        <Group justify="flex-end">
          <Button type="submit" disabled={!type || entered.length === 0} loading={mutation.isPending}>
            Save measurements
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
